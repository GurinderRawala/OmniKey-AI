import { Op } from 'sequelize';
import { z } from 'zod';
import { AgentSession } from '../models/agentSession';
import { Subscription } from '../models/subscription';
import { aiClient, getDefaultModel } from '../ai-client';
import { config } from '../config';
import { logger } from '../logger';

const aiModel = getDefaultModel(config.aiProvider, 'fast');

// ---------------------------------------------------------------------------
// Strip response wrappers before JSON.parse
// ---------------------------------------------------------------------------

/** Remove <final_answer> tags and markdown code fences that some models wrap
 *  around JSON responses, leaving only the raw JSON text. */
function stripResponseWrappers(text: string): string {
  return text
    .trim()
    .replace(/^<final_answer>\s*/i, '')
    .replace(/\s*<\/final_answer>$/i, '')
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Extract user_input text from persisted session history
// ---------------------------------------------------------------------------

// Strip server-injected wrappers from inside a user message so we don't
// re-feed them to the classifier on subsequent turns. The agent server
// prepends <project_context name="..."> ... </project_context> (carrying the
// previously-classified group's absolute path) to every user turn for an
// already-grouped session. Leaving the WHOLE block in the text we send to
// the LLM and to extractProjectPath would cause the classifier to keep
// "seeing" the old project's path inside the user's own words — that is
// what made wrong groupings sticky forever.
//
// But naively stripping the entire block has its own failure mode: when the
// user types a path-free message like "continue working" or "what about
// the cron job?", removing <project_context> leaves NO path at all and the
// LLM is free to hallucinate a new one (we saw it produce things like
// "/linear.app/coderabbit/issue/..." and "/Users/.../OmniKey-AI/macOS/Sources"
// after the cron ran). So we now do something more conservative:
//
//   1. Pull the "Project root: <abs path>" sentence out of every
//      <project_context> block before stripping the rest.
//   2. Append each extracted path back as a plain line. It contributes only
//      ONE vote to extractProjectPath's frequency count, so any path the user
//      actually types still wins, but when the user typed nothing path-shaped
//      we have a deterministic fallback instead of a hallucination.
//   3. Strip <stored_instructions>, the outer <user_input>, and @omniAgent
//      the same as before.
// Result of stripping injected wrappers. We keep the user-typed body and the
// extracted context-root fallback lines as separate fields so the caller can
// truncate the body alone — the fallback line is small and must always
// survive truncation (otherwise we lose the only deterministic project-path
// signal on long path-free turns).
interface StrippedInput {
  body: string;
  contextPathsLine: string;
}

function stripInjectedWrappers(text: string): string {
  const r = stripInjectedWrappersRich(text);
  return r.contextPathsLine ? `${r.body}\n${r.contextPathsLine}`.trim() : r.body;
}

function stripInjectedWrappersRich(text: string): StrippedInput {
  const contextPaths: string[] = [];
  const withContextPathsExtracted = text.replace(
    /<project_context[^>]*>([\s\S]*?)<\/project_context>/gi,
    (_full, inner: string) => {
      const m = /(?:Project root|Working directory):\s*(\/[^\s.,;:!?)<>"'`]+)/i.exec(inner);
      if (m) contextPaths.push(m[1]);
      return '';
    },
  );
  const body = withContextPathsExtracted
    .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
    .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
    .replace(/@omniagent/gi, '')
    .trim();
  const contextPathsLine = contextPaths.length
    ? contextPaths.map((p) => `[context root] ${p}`).join('\n')
    : '';
  return { body, contextPathsLine };
}

function extractUserInputs(historyJson: string): string[] {
  try {
    const history = JSON.parse(historyJson) as Array<{ role: string; content: unknown }>;
    const inputs: string[] = [];

    for (const msg of history) {
      if (msg.role !== 'user') continue;
      const raw = typeof msg.content === 'string' ? msg.content : '';
      if (!raw) continue;

      // Skip injected feedback/control messages
      if (raw.startsWith('TERMINAL OUTPUT:')) continue;
      if (raw.startsWith('COMMAND ERROR:')) continue;
      if (raw.startsWith('Web research is complete')) continue;
      if (raw.startsWith('IMPORTANT: The web search tool failed')) continue;
      if (raw.startsWith('Content was truncated')) continue;

      // Extract the inner text from <user_input> wrapper if present, then
      // strip any server-injected blocks (project_context, stored_instructions)
      // so the classifier only sees what the user actually typed this turn.
      // We truncate the user-typed BODY alone (cap at 400 chars) and then
      // re-append the [context root] fallback line in full — the fallback is
      // the only deterministic path signal we have on long path-free turns
      // and must never be sliced off the end.
      const match = /<user_input>([\s\S]*?)<\/user_input>/i.exec(raw);
      const inner = match ? match[1] : raw;
      const { body, contextPathsLine } = stripInjectedWrappersRich(inner);
      const truncatedBody = body.slice(0, 400);
      const combined = contextPathsLine
        ? truncatedBody
          ? `${truncatedBody}\n${contextPathsLine}`
          : contextPathsLine
        : truncatedBody;
      if (combined.length > 5) {
        inputs.push(combined);
      }
    }

    return inputs.slice(0, 8);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Extract the deepest meaningful project root from absolute paths in text.
// Strategy: find all /abs/path segments, resolve the most commonly referenced
// root (stops at depth 4 from /, so ~/projects/foo/src/bar → ~/projects/foo).
// ---------------------------------------------------------------------------

// Path segments that are never a project root on their own — when the deepest
// scored candidate ends in one of these, we walk up one level. Kept lower-case;
// matched case-insensitively against the final segment.
const NON_ROOT_SEGMENTS = new Set([
  'src',
  'lib',
  'libs',
  'dist',
  'build',
  'out',
  'bin',
  'obj',
  'target',
  'pkg',
  'cmd',
  'public',
  'assets',
  'static',
  'node_modules',
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'docs',
  'doc',
  'scripts',
  'tmp',
  'temp',
  'vendor',
  'third_party',
  'internal',
  'pages',
  'components',
  'utils',
  'util',
  'helpers',
  'types',
  '.git',
  '.github',
  '.vscode',
  'node',
]);

// Top-level OS roots that contain user home directories. The segment
// immediately after one of these is a username, NOT a project — so we always
// skip both segments when computing the shallowest legitimate project depth.
// e.g. /Users/alice/... and /home/alice/... both contribute a project only at
// depth >= 3.
const HOME_ROOT_SEGMENTS = new Set(['users', 'home']);

// Generic container directories that sit between a username and the project
// root and therefore can never themselves BE the project. We walk through any
// chain of these when determining startDepth.
// e.g. /Users/alice/Documents/projects/MyApp → /Users/alice/Documents/projects
// are containers, /MyApp is the first legitimate project segment.
const HOME_CONTAINER_SEGMENTS = new Set([
  'documents',
  'desktop',
  'downloads',
  'projects',
  'workspace',
  'workspaces',
  'repos',
  'code',
  'dev',
  'work',
  'github',
]);

// Strip every URL-shaped token from the input BEFORE the path regex runs.
// We accept that real filesystem paths NEVER contain a scheme prefix
// (http://, https://, ftp://, ssh://, git+, file://, mailto:, etc.) and we
// also strip bare git remotes (git@host:owner/repo.git), scheme-relative
// URLs (//host.tld/path) and unprefixed host-with-TLD references
// (github.com/foo/bar). After this pass the input only contains real
// filesystem candidate paths and prose, so the downstream path regex never
// has to wonder "is this a URL?". We replace with a single space rather
// than empty string so adjacent path tokens stay separated.
const URL_LIKE_REGEXES: readonly RegExp[] = [
  // Full URLs with scheme: http(s)://, ftp(s)://, ssh://, git://, git+...://,
  // file://, ws(s)://, etc. Anything up to the next whitespace / quote / >.
  /\b(?:https?|ftps?|sftp|ssh|git|git\+ssh|git\+https?|file|ws|wss|chrome|chrome-extension|vscode|data)(?::\/\/|:)[^\s<>"'`]+/gi,
  // Scheme-relative URLs (//host.tld/path).
  /(?<![A-Za-z0-9_])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s<>"'`]*)?/gi,
  // git remotes: git@host:owner/repo(.git).
  /\bgit@[a-z0-9.-]+:[^\s<>"'`]+/gi,
  // mailto:user@host.
  /\bmailto:[^\s<>"'`]+/gi,
  // Bare URL with TLD but no scheme: github.com/foo, example.com:8080/path,
  // localhost:port/path. Requires the host to contain at least one dot OR
  // to be a port-bearing localhost — without that constraint we would eat
  // every "foo.bar" token in regular prose.
  /\b(?:[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?|localhost:\d+)\/[^\s<>"'`]*/gi,
];

function stripUrls(text: string): string {
  let out = text;
  for (const re of URL_LIKE_REGEXES) out = out.replace(re, ' ');
  return out;
}

// Positive filter: only accept paths whose leading segments look like
// real local-computer roots. This is intentionally an allow-list — the
// classifier's job is to identify the user's PROJECT, and real projects
// live somewhere predictable on disk. Anything that doesn't start with
// one of these prefixes is almost certainly a URL fragment, a route, or
// some other path-shaped noise; we drop it rather than guess.
//
// Macs and most Linux installs: /Users/<x>/..., /home/<x>/..., /opt/...,
// /usr/local/..., /var/..., /tmp/..., /private/Users/<x>/...,
// /Volumes/<vol>/..., /mnt/<vol>/..., /srv/..., /etc/..., /root/...
// Tilde paths (~/foo) are pre-expanded to /Users/<x>/foo before this
// filter runs, so they go through the /Users branch.
const LOCAL_PATH_PREFIXES: ReadonlyArray<RegExp> = [
  /^\/Users\/[^/]+(?:\/|$)/,
  /^\/home\/[^/]+(?:\/|$)/,
  /^\/private\/var\/folders\//,
  /^\/private\/tmp(?:\/|$)/,
  /^\/private\/Users\/[^/]+(?:\/|$)/,
  /^\/Volumes\/[^/]+(?:\/|$)/,
  /^\/mnt\/[^/]+(?:\/|$)/,
  /^\/opt\/[^/]+(?:\/|$)/,
  /^\/usr\/local(?:\/|$)/,
  /^\/usr\/share(?:\/|$)/,
  /^\/srv\/[^/]+(?:\/|$)/,
  /^\/var\/[^/]+(?:\/|$)/,
  /^\/tmp\/[^/]+(?:\/|$)/,
  /^\/etc\/[^/]+(?:\/|$)/,
  /^\/root(?:\/|$)/,
];

function isLocalLookingPath(path: string): boolean {
  return LOCAL_PATH_PREFIXES.some((re) => re.test(path));
}

// Centralised path matcher used by every absolute-path extractor in this
// file. Returns a fresh /g RegExp on every call because /g RegExps carry
// mutable lastIndex state between matchAll calls and would otherwise
// silently desync across call sites.
//
// The matcher is intentionally UNBOUNDED on the number of trailing path
// segments — a deep monorepo file like
//   /Users/me/Documents/projects/org/monorepo/packages/api/src/index.ts
// has 10 segments and we want to capture the full path so the downstream
// trimToProjectRoot can walk it up to the real project root. A previous
// hard cap of {1,6} truncated such paths into two halves and let the
// shallower (".../packages") win the vote, classifying every deep
// monorepo session under the wrong project.
//
// Path segments cannot contain whitespace, /, <>, quotes, or regex
// metacharacters (?, ^, $, {, }, [, ], (, ), |, \\, *, +) that show up
// in source code and config but are never valid in real filesystem paths.
function buildAbsolutePathRegex(): RegExp {
  return /(\/(?:[^\s/<>"'`?^${}\[\]()|\\*+]+\/)+[^\s/<>"'`?^${}\[\]()|\\*+]*)/g;
}

// First-segment patterns that mean a string starting with "/" is a URL or
// domain that the agent server / a copy-paste accidentally turned into a
// path-shaped token, NOT a real filesystem root. We reject these entirely
// from project-root candidacy. Examples seen in the wild:
//   /github.com/owner/repo/pull/220
//   /linear.app/coderabbit/issue/REV-19/...
//   /console.cloud.google.com/run/worker-pools/...
//   /localhost:5173/dashboard/summary
//   /apps.apple.com/ca/app/bhabi/id6475659322
const DOMAINY_FIRST_SEGMENT = /^(?:localhost(?::\d+)?$|[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})*$)/i;

function firstSegmentLooksLikeDomain(segment: string): boolean {
  return DOMAINY_FIRST_SEGMENT.test(segment);
}

function looksLikeFile(segment: string): boolean {
  // Treat a trailing dotted extension (e.g. index.ts, package.json, README.md)
  // as a file, not a directory. Dotfiles like .gitignore are also files.
  if (!segment) return false;
  if (segment.startsWith('.') && segment.length > 1 && !segment.includes('/')) {
    // .git, .github, .vscode are directories handled by NON_ROOT_SEGMENTS;
    // .env, .gitignore, .prettierrc are files.
    const known = new Set(['.git', '.github', '.vscode', '.idea', '.next', '.cache']);
    return !known.has(segment.toLowerCase());
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(segment);
}

function trimToProjectRoot(path: string): string | null {
  let parts = path.split('/').filter(Boolean);
  // Reject URL-shaped pseudo-paths up front. "/github.com/owner/repo" looks
  // like an absolute path to the regex but it is actually a URL with the
  // scheme stripped, and we must never treat it as a project root — doing so
  // is exactly how stale descriptions ended up storing things like
  // "Project root: /github.com/coderabbitai/grafana/pull/220".
  if (parts.length > 0 && firstSegmentLooksLikeDomain(parts[0])) {
    return null;
  }
  // Allow-list: only paths rooted under a known local-computer prefix
  // (/Users/<x>/, /home/<x>/, /opt/, /Volumes/<vol>/, ...) are treated as
  // real project roots. Anything else — top-level pseudo-roots like
  // /work/coderabbitai/mono or /db-api-server/src/routers, route paths
  // bleeding out of URLs the stripper missed, the macOS volume root — is
  // dropped rather than guessed at. This is the "only consider paths
  // that look like paths from a local computer" rule.
  if (!isLocalLookingPath('/' + parts.join('/'))) {
    return null;
  }
  // Strip a trailing file segment, if any.
  if (parts.length && looksLikeFile(parts[parts.length - 1])) {
    parts = parts.slice(0, -1);
  }
  // Walk up while the deepest segment is a non-root folder (src, lib, dist, ...).
  while (parts.length > 1 && NON_ROOT_SEGMENTS.has(parts[parts.length - 1].toLowerCase())) {
    parts = parts.slice(0, -1);
  }
  // A bare /Users/<name> or /home/<name> is not a project — neither is
  // /Users/<name>/Documents. Require at least one segment past the home
  // root + username + container chain.
  let firstProjectIdx = 0;
  // Skip the OS home-root + its username (e.g. /Users/alice or /home/bob).
  if (parts.length > 0 && HOME_ROOT_SEGMENTS.has(parts[0].toLowerCase())) {
    firstProjectIdx = Math.min(2, parts.length);
  }
  // Then skip any further generic container segments (Documents, projects, ...).
  while (
    firstProjectIdx < parts.length &&
    HOME_CONTAINER_SEGMENTS.has(parts[firstProjectIdx].toLowerCase())
  ) {
    firstProjectIdx++;
  }
  if (firstProjectIdx >= parts.length) return null;
  if (parts.length < 2) return null;
  return '/' + parts.join('/');
}

function extractProjectPath(texts: string[]): string | null {
  // Resolve the current user's home directory once. We use it to expand
  // "~/foo" tokens BEFORE running the absolute-path regex, so paths the
  // user typed with a tilde prefix (e.g. "~/work/coderabbitai/grafana")
  // are treated the same as "/Users/<name>/work/coderabbitai/grafana".
  // Without this, the regex captured only the "/work/..." tail and
  // accepted /work as a top-level root — which is how descriptions ended
  // up storing "Project root: /work/coderabbitai/...".
  const homeDir =
    (typeof process !== 'undefined' && (process.env.HOME || process.env.USERPROFILE)) || '';
  const tildeExpand = (text: string): string =>
    homeDir ? text.replace(/(^|[\s(\["'`])~\//g, (_m, pre: string) => `${pre}${homeDir}/`) : text;
  const combined = stripUrls(tildeExpand(texts.join(' ')));

  const pathRe = buildAbsolutePathRegex();
  const rawMatches = Array.from(combined.matchAll(pathRe), (m) => m[1])
    // Strip trailing sentence punctuation that the regex greedily included
    // (e.g. "see /Users/x/MyApp/cli, please edit ..." → /Users/x/MyApp/cli).
    .map((raw) => raw.replace(/[.,;:!?)\]]+$/, ''))
    .filter((raw) => raw.length > 1);
  if (!rawMatches.length) return null;

  // Normalise each match to its likely project root (drop trailing file
  // segment, drop non-root subdirs like src/dist/tests, and bail out on bare
  // home directories). Each match contributes one vote.
  const normalised: string[] = [];
  for (const raw of rawMatches) {
    const trimmed = trimToProjectRoot(raw);
    if (trimmed) normalised.push(trimmed);
  }
  if (!normalised.length) return null;

  // Count direct votes for each candidate project root. We deliberately do
  // NOT roll up votes to ancestors here: the previous implementation did, and
  // that's exactly how the user's home directory (or a parent project that
  // happened to enclose every referenced file) was scoring higher than the
  // actual project the user was working in. Each path votes for exactly one
  // candidate: its own trimmed project root.
  const directVotes = new Map<string, number>();
  for (const path of normalised) {
    directVotes.set(path, (directVotes.get(path) ?? 0) + 1);
  }

  // Pick the candidate with the most direct votes. Ties are broken by
  // preferring the DEEPER path — when two siblings tie, the longer one is the
  // most-specific common reference and is more likely the project root the
  // user actually means. If two unrelated paths tie at the top, fall through
  // and pick the one mentioned first (stable insertion order).
  const entries = Array.from(directVotes.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0].split('/').length - a[0].split('/').length;
  });

  // winner came from `normalised`, which is itself a list of
  // trimToProjectRoot outputs, so the path is already in its canonical
  // trimmed form — no second pass needed here.
  return entries[0][0];
}

// Return ALL normalised project roots referenced in the given texts together
// with their direct-vote count, ordered by score then by path. Used by the
// cron to detect groups that have drifted across multiple unrelated projects
// and need to be split.
function extractAllProjectRoots(texts: string[]): Array<{ root: string; votes: number }> {
  const homeDir =
    (typeof process !== 'undefined' && (process.env.HOME || process.env.USERPROFILE)) || '';
  const tildeExpand = (text: string): string =>
    homeDir ? text.replace(/(^|[\s(\["'`])~\//g, (_m, pre: string) => `${pre}${homeDir}/`) : text;
  const combined = stripUrls(tildeExpand(texts.join(' ')));
  const pathRe = buildAbsolutePathRegex();
  const rawMatches = Array.from(combined.matchAll(pathRe), (m) => m[1])
    .map((raw) => raw.replace(/[.,;:!?)\]]+$/, ''))
    .filter((raw) => raw.length > 1);
  const votes = new Map<string, number>();
  for (const raw of rawMatches) {
    const trimmed = trimToProjectRoot(raw);
    if (!trimmed) continue;
    votes.set(trimmed, (votes.get(trimmed) ?? 0) + 1);
  }
  return Array.from(votes.entries())
    .map(([root, n]) => ({ root, votes: n }))
    .sort((a, b) => (b.votes !== a.votes ? b.votes - a.votes : a.root.length - b.root.length));
}

// Return the most-referenced sub-directories UNDER a given project root,
// ordered by reference count then by depth, capped at `limit`. The trailing
// file segment (if any) is stripped, but unlike trimToProjectRoot we keep
// non-root subdirs (src, lib, dist, ...) because those are exactly the
// "key directories worked on" the description should mention.
function extractKeySubdirectories(texts: string[], projectRoot: string, limit: number): string[] {
  if (!projectRoot) return [];
  const homeDir =
    (typeof process !== 'undefined' && (process.env.HOME || process.env.USERPROFILE)) || '';
  const tildeExpand = (text: string): string =>
    homeDir ? text.replace(/(^|[\s(\["'`])~\//g, (_m, pre: string) => `${pre}${homeDir}/`) : text;
  const combined = stripUrls(tildeExpand(texts.join(' ')));
  const pathRe = buildAbsolutePathRegex();
  const prefix = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  const votes = new Map<string, number>();
  for (const m of combined.matchAll(pathRe)) {
    const raw = m[1].replace(/[.,;:!?)\]]+$/, '');
    if (!raw.startsWith(prefix)) continue;
    const parts = raw.split('/').filter(Boolean);
    // Strip trailing file segment, if any.
    if (parts.length && looksLikeFile(parts[parts.length - 1])) {
      parts.pop();
    }
    // Need at least one segment beyond the project root to be a subdir.
    const rootDepth = projectRoot.split('/').filter(Boolean).length;
    if (parts.length <= rootDepth) continue;
    // Walk every ancestor depth strictly deeper than the root, capping at
    // root + 3 segments so we don't promote one-off deeply-nested files.
    const maxDepth = Math.min(parts.length, rootDepth + 3);
    for (let depth = rootDepth + 1; depth <= maxDepth; depth++) {
      const sub = '/' + parts.slice(0, depth).join('/');
      votes.set(sub, (votes.get(sub) ?? 0) + 1);
    }
  }
  return Array.from(votes.entries())
    .filter(([, n]) => n >= 1)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].split('/').length - b[0].split('/').length))
    .slice(0, limit)
    .map(([sub]) => sub);
}

// Truncate to at most `maxLen` characters but never mid-word, preferring to
// end on a sentence boundary (.!?). Falls back to the last whitespace.
function truncateOnSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  // Prefer the last sentence terminator followed by a space (or end).
  const sentenceMatch = /[.!?](?=\s|$)(?!.*[.!?](?=\s|$))/s.exec(slice);
  if (sentenceMatch && sentenceMatch.index > maxLen * 0.5) {
    return slice.slice(0, sentenceMatch.index + 1).trimEnd();
  }
  // Otherwise back off to the last whitespace so we don't cut a word.
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    return (
      slice
        .slice(0, lastSpace)
        .trimEnd()
        .replace(/[,;:]$/, '') + '.'
    );
  }
  // Last resort: hard truncate, but always end on a period.
  return slice.trimEnd().replace(/[,;:.!?]+$/, '') + '.';
}

// ---------------------------------------------------------------------------
// Deterministic 3-sentence fallback description.
// The description always answers, in order:
//   1. Where is the project root located?
//   2. What is the purpose of this project?
//   3. If it is a coding project, what is the primary programming language?
// Used when the LLM does not return a usable description.
// ---------------------------------------------------------------------------

function buildDescription(projectPath: string | null, groupName: string): string {
  if (projectPath) {
    return [
      `Project root: ${projectPath} (the ${groupName} project).`,
      `Purpose: ongoing work on the ${groupName} codebase.`,
      `Primary language: not yet determined from session context.`,
    ].join(' ');
  }
  return [
    `Project root: not specified — no absolute path has been associated with the ${groupName} group yet.`,
    `Purpose: sessions grouped under ${groupName}.`,
    `Primary language: not applicable (no coding project identified).`,
  ].join(' ');
}

// ---------------------------------------------------------------------------
// Helpers for matching existing groups by project path. Name-based matching
// alone is unreliable: the LLM may pick "CLI" for two unrelated /cli dirs in
// different repos, or rename the same project ("OmniKey AI" vs "OmniKey-AI").
// Path matching is much stronger — when the deterministic project path
// extracted from the current session equals an existing group's stored path,
// we know with high confidence they are the same project.
// ---------------------------------------------------------------------------

/** Pull the project root path back out of a previously-stored group
 *  description. Descriptions written by this module start with
 *  "Project root: <absolute path>." so we just need to grab that span. */
function extractStoredProjectPath(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = /Project root:\s*(\/[^\s.,;:!?)<>"'`]+)/i.exec(description);
  if (!match) return null;
  // Only return paths that pass full normalisation. A previously-stored
  // description may carry a URL-shaped pseudo-path ("/github.com/..." or
  // "/linear.app/...") from before the URL rejection was added; treating
  // that as a valid project root would keep mis-merging unrelated sessions.
  // When the stored path fails normalisation we report "no stored path" so
  // the path-match short-circuit cannot fire and the LLM/safety nets get a
  // chance to rewrite the description with a real root.
  return trimToProjectRoot(match[1]);
}

/** Pick the existing group whose stored project root EXACTLY equals the
 *  current session's extracted project root. Equality is intentional — we do
 *  NOT treat an ancestor match as a hit, because the original user complaint
 *  was that a parent project was being chosen as the group for a child
 *  project. /Users/me/OmniKey-AI/cli must not auto-merge into a group whose
 *  stored path is /Users/me/OmniKey-AI. */
function findGroupByExactPath(
  currentPath: string | null,
  existingGroups: Array<{ groupName: string; groupDescription: string | null }>,
): { groupName: string; groupDescription: string } | null {
  if (!currentPath) return null;
  for (const g of existingGroups) {
    const stored = extractStoredProjectPath(g.groupDescription);
    if (stored && stored === currentPath) {
      return {
        groupName: g.groupName,
        groupDescription: g.groupDescription ?? '',
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// LLM: classify group name AND generate a 3-4 sentence description for new
// groups. For existing groups the stored description is always reused — the
// LLM only writes a description when this is a genuinely new group. The
// description must answer the three required questions and include the
// absolute project root path whenever one is present in the user inputs.
// ---------------------------------------------------------------------------

interface GroupResult {
  groupName: string;
  groupDescription: string;
}

async function classifyGroup(
  userInputs: string[],
  existingGroups: Array<{ groupName: string; groupDescription: string | null }>,
): Promise<GroupResult | null> {
  if (!userInputs.length) return null;

  // Deterministically extract the project path from the current session. This
  // is the single most reliable signal we have — far more reliable than the
  // LLM's interpretation — so we use it both to short-circuit and to anchor
  // the LLM's reasoning.
  const currentPath = extractProjectPath(userInputs);

  // 1) Path-first short-circuit. If any existing group already has the EXACT
  //    same stored project root, that is the group. Skip the LLM entirely —
  //    no name to invent, no chance of mis-matching to a parent repo.
  if (currentPath) {
    const exactMatch = findGroupByExactPath(currentPath, existingGroups);
    if (exactMatch) {
      logger.info('Session group matched by exact project path', {
        groupName: exactMatch.groupName,
        path: currentPath,
      });
      return {
        groupName: exactMatch.groupName,
        groupDescription: exactMatch.groupDescription,
      };
    }
  }

  // 2) Build the existing-groups list for the LLM, INCLUDING each group's
  //    stored project root path when we can recover it. Without this the LLM
  //    only sees group NAMES and has no way to disambiguate two projects that
  //    happen to share a generic name (e.g. "CLI") or to avoid re-using the
  //    parent repo's name when the user has moved on to a child project.
  const existingText = existingGroups.length
    ? existingGroups
        .map((g) => {
          const storedPath = extractStoredProjectPath(g.groupDescription);
          return storedPath
            ? `- "${g.groupName}" (root: ${storedPath})`
            : `- "${g.groupName}" (root: unknown)`;
        })
        .join('\n')
    : 'None.';

  const currentPathLine = currentPath
    ? `Project root detected in messages: ${currentPath}`
    : 'No absolute project path was detected in the messages.';

  const prompt = `Analyze these chat messages and assign a project group.

Messages:
${userInputs.map((m, i) => `${i + 1}. ${m}`).join('\n')}

${currentPathLine}

Existing groups (each shown with its stored project root):
${existingText}

Rules for the group name (in priority order):
1. If "Project root detected in messages" above is non-empty AND it is an
   EXACT match for an existing group's stored root, return that existing
   group's EXACT name verbatim. Do not modify the casing or punctuation.
2. If "Project root detected in messages" is a STRICT ANCESTOR or
   DESCENDANT of an existing group's stored root (e.g. detected is
   /Users/me/Repo/cli and an existing group's root is /Users/me/Repo), they
   are DIFFERENT projects — create a new group name for the detected path.
   Do NOT re-use the ancestor or descendant group's name.
3. If no path is detected but an existing group's NAME clearly matches the
   subject of the messages, return that existing name.
4. Otherwise create a concise NEW group name: 2-4 words, Title Case, derived
   from the deepest meaningful path segment (e.g. /Users/john/projects/my-app
   → "My App") or from the topic when no path is present.
5. If the session is purely general/conversational with no project signal,
   use "General".

Rules for the description (CRITICAL):
The description is appended to user input as <project_context> whenever the user picks this project, so it must be short, factual, and load-bearing. Write a SINGLE paragraph of 3-4 sentences (max 4 sentences, no markdown, no bullet points, no newlines) that answers these three questions in order:
   1. Where is the project root located? Use the EXACT "Project root detected in messages" path above when it is non-empty — do not invent, abbreviate, or guess a different path. If it is empty, say "Project root: not specified."
   2. What is the purpose of this project? One sentence summarising what the project / group is for, inferred from the messages.
   3. If it is a coding project, what is the primary programming language? Name the language (e.g. TypeScript, Python, Go, Rust) when it can be inferred from file extensions, framework names, package files, or explicit mentions. If it is not a coding project, say "Not a coding project." If the language cannot be inferred, say "Primary language not identified from the available context."
Keep the whole description under ~500 characters. Do NOT add extra commentary, tech-stack lists, workflow notes, or session summaries beyond what the three questions require.

Respond with ONLY valid JSON, no markdown:
{"groupName":"...","groupDescription":"..."}`;

  try {
    const result = await aiClient.complete(
      aiModel,
      [
        {
          role: 'system',
          content:
            'You are a session categorization assistant. Respond only with the requested JSON object, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0 },
    );

    const raw = stripResponseWrappers(result.content);

    const parsed: unknown = JSON.parse(raw);
    const response = z
      .object({ groupName: z.string(), groupDescription: z.string() })
      .parse(parsed);
    let groupName = response.groupName.trim().slice(0, 100);
    if (!groupName) return null;

    // When we fall through from the existingMatch branch to regenerate a stale
    // description, preserve the canonical existing group name so we don't
    // fragment groups by re-casing the name.
    let canonicalName: string | null = null;

    // Locate the LLM-chosen existing group, if any. We then VALIDATE the
    // match against project paths — the LLM's name-based pick may be wrong:
    // it might re-use a parent project's name even when the user is in a
    // child project, or vice versa.
    let existingMatch = existingGroups.find(
      (g) => g.groupName.toLowerCase() === groupName.toLowerCase(),
    );

    if (existingMatch && currentPath) {
      const storedPath = extractStoredProjectPath(existingMatch.groupDescription);
      if (storedPath && storedPath !== currentPath) {
        // The LLM picked an existing name but the stored path for that group
        // does not match the path the user is actually in. Treat this as a
        // NEW group and drop the existing-match so we don't merge unrelated
        // projects (or, worse, the parent of the current project).
        logger.info('Rejecting LLM existing-group match: project paths differ', {
          groupName,
          storedPath,
          currentPath,
        });
        existingMatch = undefined;
        // Derive a sensible new name from the current path instead of
        // re-using the LLM's name (which is already taken by the other
        // project). Title-case the last segment.
        const segs = currentPath.split('/').filter(Boolean);
        const last = segs[segs.length - 1] ?? groupName;
        const derived = last
          .replace(/[_-]+/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim()
          .slice(0, 100);
        if (derived) groupName = derived;
      }
    }

    if (existingMatch) {
      const stored = existingMatch.groupDescription ?? '';
      const hasNewShape = /project root/i.test(stored) && /primary language/i.test(stored);
      if (hasNewShape) {
        return { groupName: existingMatch.groupName, groupDescription: stored };
      }
      // Fall through: regenerate description using the LLM output below, but
      // keep the canonical existing group name so we don't fragment groups.
      canonicalName = existingMatch.groupName;
    }

    // Final safety net: if currentPath EXACTLY matches some other existing
    // group's stored path (different name than the LLM picked), prefer that
    // group. The LLM is allowed to invent a name, but path equality is
    // ground truth.
    if (currentPath) {
      const pathMatch = findGroupByExactPath(currentPath, existingGroups);
      if (pathMatch && pathMatch.groupName.toLowerCase() !== groupName.toLowerCase()) {
        logger.info('Overriding LLM group choice with exact-path match', {
          llmGroup: groupName,
          matchedGroup: pathMatch.groupName,
          path: currentPath,
        });
        return {
          groupName: pathMatch.groupName,
          groupDescription: pathMatch.groupDescription,
        };
      }
    }

    // New group: prefer the LLM description but fall back to the deterministic builder.
    // Description is a single 3-4 sentence paragraph (no newlines, capped at 800 chars
    // to leave headroom over the ~500 char target while still bounding storage).
    const rawDesc = response.groupDescription.trim();
    let groupDescription = (rawDesc || buildDescription(currentPath, groupName))
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Safety net 1: if the LLM hallucinated a different absolute path in its
    // "Project root:" sentence, replace it with the deterministically
    // extracted currentPath. This is the description the agent server will
    // inject as <project_context> on every future turn, so a wrong path here
    // poisons the session forever.
    if (currentPath) {
      groupDescription = groupDescription.replace(
        /Project root:\s*(\/[^\s.,;:!?)<>"'`]+)/i,
        (_m, llmPath: string) => {
          if (llmPath === currentPath) return `Project root: ${currentPath}`;
          logger.info('Replacing hallucinated description path with extracted path', {
            llmPath,
            currentPath,
          });
          return `Project root: ${currentPath}`;
        },
      );
      // Safety net 2: if the description never mentioned a path at all,
      // prepend the extracted one so the contract holds.
      if (!groupDescription.includes(currentPath)) {
        groupDescription = `Project root: ${currentPath}. ${groupDescription}`.trim();
      }
    }

    // Cap on a sentence boundary so we never store truncated mid-token text.
    groupDescription = truncateOnSentenceBoundary(groupDescription, 1000);

    return {
      // Preserve the canonical existing group name when we fell through from
      // the existingMatch branch to regenerate a stale description.
      groupName: canonicalName ?? groupName,
      groupDescription,
    };
  } catch (err) {
    logger.warn('Session group classification failed', { error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch up to 10 recent user inputs from sessions already in a group.
// Used to give the LLM richer context about the group when classifying a
// new session or when refreshing a description via the cron job.
// ---------------------------------------------------------------------------

async function fetchSiblingInputs(
  subscriptionId: string,
  groupName: string,
  excludeSessionId?: string,
): Promise<string[]> {
  const sessions = await AgentSession.findAll({
    where: excludeSessionId
      ? { subscriptionId, groupName, id: { [Op.ne]: excludeSessionId } }
      : { subscriptionId, groupName },
    order: [['last_active_at', 'DESC']],
    limit: 15,
    attributes: ['historyJson'],
  });

  const collected: string[] = [];
  for (const s of sessions) {
    for (const inp of extractUserInputs(s.historyJson)) {
      collected.push(inp);
      if (collected.length >= 10) break;
    }
    if (collected.length >= 10) break;
  }

  return collected;
}

// ---------------------------------------------------------------------------
// LLM: generate or update a group description using combined inputs.
// When isUpdateMode is true the LLM is asked to UPDATE the existing
// description with new findings rather than write one from scratch.
// ---------------------------------------------------------------------------

async function enrichGroupDescription(
  groupName: string,
  allInputs: string[],
  existingDescription: string | null,
  isUpdateMode: boolean,
  forcedProjectPath?: string | null,
): Promise<string | null> {
  if (!allInputs.length) return null;

  // Use the caller-provided project root when given (the cron passes the
  // collapsed dominant root for the group, which is the correct project root
  // even when individual sessions only reference subdirectories). Fall back
  // to running our own extraction otherwise — that's the path taken from
  // updateSessionGroup for a single session.
  const projectPath = forcedProjectPath ?? extractProjectPath(allInputs);
  const messagesText = allInputs.map((m, i) => `${i + 1}. ${m}`).join('\n');

  // Hand the LLM the deterministically extracted root explicitly. Before
  // this, the prompt only said "quote the exact absolute path verbatim when
  // present" and trusted the LLM to find it in the messages, which is how
  // we ended up with hallucinated paths like "/linear.app/coderabbit/..."
  // and "/Users/.../OmniKey-AI/macOS/Sources" surviving multiple cron
  // refreshes. The downstream safety net still rewrites mismatches, but
  // giving the LLM the path up front means most calls produce the right
  // text the first time.
  const projectPathLine = projectPath
    ? `Deterministically extracted project root for this group: ${projectPath}\n(Use this EXACT path in the "Project root:" sentence. Do not abbreviate, do not paraphrase, do not substitute a URL for it.)`
    : 'No absolute project root could be deterministically extracted from the messages. Say "Project root: not specified." in the description.';

  // Surface the key sub-directories the user has been working on inside this
  // project so the description can mention them. The LLM is instructed to
  // weave them in as a single sentence — they are not the project root, just
  // landmarks within it (e.g. /Users/me/Repo/api/src/agent, /Users/me/Repo/cli).
  const keySubdirs = projectPath ? extractKeySubdirectories(allInputs, projectPath, 4) : [];
  const keySubdirsLine = keySubdirs.length
    ? `Key sub-directories worked on inside this project (most-referenced first):\n${keySubdirs.map((s) => `  - ${s}`).join('\n')}`
    : 'No notable sub-directories were identified inside the project root.';

  const prompt =
    isUpdateMode && existingDescription
      ? `Update the project group description for "${groupName}" based on new session data.

Current description:
"${existingDescription}"

${projectPathLine}

${keySubdirsLine}

Recent user messages from sessions in this group:
${messagesText}

A GROUP CORRESPONDS TO EXACTLY ONE PROJECT. The description must describe ONLY the project at the project root above. Do not mention any other project root. Do not merge information about multiple unrelated projects into one description — the cron will split them into separate groups on its own.

Update the description to incorporate any new findings. Keep a 4-5 sentence single paragraph answering in order:
1. Where is the project root? Use the deterministically extracted path above when one was provided. Never use a URL (github.com/..., linear.app/..., console.cloud.google.com/...) as the project root.
2. What is the purpose of this project?
3. What are the main sub-directories worked on inside the project? Mention the most useful 2-3 from the key sub-directories list above (use their exact absolute paths). Skip this sentence if no sub-directories were identified.
4. What is the primary programming language?
5. (Optional, only if clearly inferable) What is the current focus of recent work, in one short clause.

Rules: single paragraph, no markdown, no bullet points, no newlines, end on a complete sentence. Keep under ~650 characters total. Preserve correct existing information. Only change what the messages provide new or better details on.

Respond with ONLY valid JSON: {"groupDescription":"..."}`
      : `Generate a description for the project group "${groupName}" based on these session messages.

${projectPathLine}

${keySubdirsLine}

Messages:
${messagesText}

A GROUP CORRESPONDS TO EXACTLY ONE PROJECT. Describe ONLY the project at the project root above. Do not mention any other project root and do not merge multiple unrelated projects into one description.

Write a SINGLE paragraph of 4-5 sentences (no markdown, no bullet points, no newlines, end on a complete sentence) answering in order:
1. Where is the project root? Use the deterministically extracted path above when one was provided; never use a URL.
2. What is the purpose of this project?
3. What are the main sub-directories worked on inside the project? Mention the most useful 2-3 from the key sub-directories list above (use their exact absolute paths). Skip if none.
4. What is the primary programming language? (Name it when inferable; "Primary language not identified." if not.)
5. (Optional) Current focus of recent work, in one short clause.

Keep the whole description under ~650 characters.

Respond with ONLY valid JSON: {"groupDescription":"..."}`;

  try {
    const result = await aiClient.complete(
      aiModel,
      [
        {
          role: 'system',
          content:
            'You are a session categorization assistant. Respond only with the requested JSON object, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0 },
    );

    const raw = stripResponseWrappers(result.content);

    const parsed: unknown = JSON.parse(raw);
    const response = z.object({ groupDescription: z.string() }).parse(parsed);

    let description = response.groupDescription
      .trim()
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // If the LLM wrote a "Project root: <path>" sentence with a path that
    // doesn't match the path we deterministically extracted, override it.
    // The description is injected verbatim into every future user turn, so
    // a wrong path here is what makes a mis-grouped session sticky.
    if (projectPath) {
      description = description.replace(
        /Project root:\s*(\/[^\s.,;:!?)<>"'`]+)/i,
        (_m, llmPath: string) => {
          if (llmPath === projectPath) return `Project root: ${projectPath}`;
          logger.info('enrichGroupDescription: replacing hallucinated path', {
            groupName,
            llmPath,
            projectPath,
          });
          return `Project root: ${projectPath}`;
        },
      );
      if (!description.includes(projectPath)) {
        description = `Project root: ${projectPath}. ${description}`.trim();
      }
    }

    // Cap on a sentence boundary so we never store "...Primary language: GPT-5"
    // (cut mid-token by the old hard slice). Hard limit raised from 800 to 1000
    // to accommodate the new sentence about key sub-directories, with the
    // truncator picking the last complete sentence inside that budget.
    return truncateOnSentenceBoundary(description, 1000);
  } catch (err) {
    logger.warn('Group description enrichment failed', { groupName, error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM: produce a one-to-two sentence summary of what the user worked on in a
// single session. Used to populate AgentSession.sessionSummary, which is then
// pulled into the <project_context> block at injection time so the agent
// always sees recent activity context WITHOUT having to rewrite the
// group-level description on every new session (which used to overwrite
// the group's accumulated context with whatever the latest session was
// about — the exact bug this change fixes).
// ---------------------------------------------------------------------------
async function generateSessionSummary(userInputs: string[]): Promise<string | null> {
  if (!userInputs.length) return null;
  const messagesText = userInputs.map((m, i) => `${i + 1}. ${m}`).join('\n');

  const prompt = `Summarise what the user worked on in this single session in 1-2 short sentences (max 240 characters total).

Messages:
${messagesText}

Rules:
- No markdown, no bullet points, no newlines, no quotes around the summary.
- Focus on the TASK the user was working on ("refactored the auth flow",
  "investigated a sqlite locking bug", "shipped a new settings pane").
- Do not include the project name or the project root path — those are
  stored separately in the group context.
- Do not include any URLs or absolute filesystem paths.
- If the session looks like exploration or general conversation with no
  concrete task, summarise the topic in one short clause.

Respond with ONLY valid JSON: {"summary":"..."}`;

  try {
    const result = await aiClient.complete(
      aiModel,
      [
        {
          role: 'system',
          content:
            'You are a session summarisation assistant. Respond only with the requested JSON object, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0 },
    );
    const raw = stripResponseWrappers(result.content);
    const parsed: unknown = JSON.parse(raw);
    const response = z.object({ summary: z.string() }).parse(parsed);
    const summary = response.summary
      .trim()
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!summary) return null;
    // Hard cap so a verbose LLM cannot blow out the context block. We aim
    // for ~240 chars but truncate on a sentence boundary up to 320.
    return truncateOnSentenceBoundary(summary, 320);
  } catch (err) {
    logger.warn('Session summary generation failed', { error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLM: produce a fresh group description from the most recent N session
// summaries in the group. This replaces the previous "enrich the group's
// description from raw user inputs across many sessions" approach, which
// made the description drift around whatever the latest session was about.
//
// Inputs:
//   - groupName: the group's canonical name (e.g. "OmniKey AI").
//   - dominantRoot: the deterministically extracted project root (used as
//     the verbatim "Project root: <path>" anchor and to guard against the
//     LLM hallucinating a different absolute path).
//   - sessionSummaries: { summary, lastActiveAt } pairs for the most recent
//     ~5 sessions in the group, ordered most-recent-first. These are the
//     ONLY information about session activity that the LLM sees.
//   - existingDescription: the current stored description, so the LLM can
//     preserve durable project meta (purpose, language) and only refresh
//     the parts that depend on recent work.
//
// The LLM is reminded once again that one group = one project, that it
// must not invent or substitute a different absolute path, and that the
// description should describe the PROJECT as a whole — not the contents
// of any single recent session.
// ---------------------------------------------------------------------------
async function generateGroupDescriptionFromSummaries(
  groupName: string,
  dominantRoot: string | null,
  sessionSummaries: Array<{ summary: string; lastActiveAt: Date }>,
  existingDescription: string | null,
): Promise<string | null> {
  if (!sessionSummaries.length && !existingDescription) return null;

  const summariesBlock = sessionSummaries.length
    ? sessionSummaries
        .map((s, i) => `${i + 1}. [${formatSessionTimestamp(s.lastActiveAt)}] ${s.summary}`)
        .join('\n')
    : '(no session summaries yet)';

  const rootLine = dominantRoot
    ? `Deterministically extracted project root for this group: ${dominantRoot}\n(Use this EXACT path in the "Project root:" sentence. Do not abbreviate, do not paraphrase, do not substitute a URL for it.)`
    : 'No absolute project root could be deterministically extracted. Say "Project root: not specified." in the description.';

  const prompt = `Update the project group description for "${groupName}".

Current description:
"${existingDescription ?? '(none yet — write one from scratch)'}"

${rootLine}

Recent session summaries in this group (most recent first; each one is what the user worked on in a single session):
${summariesBlock}

A GROUP CORRESPONDS TO EXACTLY ONE PROJECT. The description must describe ONLY the project at the project root above. Do not mention any other project root. Do not invent or substitute a different absolute path.

Write the description as a SINGLE paragraph of 4-5 sentences (no markdown, no bullet points, no newlines, end on a complete sentence) answering in order:
1. Where is the project root? Use the deterministically extracted path above when provided; never use a URL.
2. What is the purpose of this project? Preserve correct information from the current description; only change what the recent summaries provide new evidence about.
3. What is the primary programming language? Name it when inferable; "Primary language not identified." otherwise.
4. What has the user been working on recently? Summarise the THEMES across the recent session summaries — do NOT enumerate sessions and do NOT restate any single session verbatim.
5. (Optional) Current focus, in one short clause.

Rules: single paragraph, under ~650 characters total. Preserve correct existing information; only refresh what the new summaries reveal.

Respond with ONLY valid JSON: {"groupDescription":"..."}`;

  try {
    const result = await aiClient.complete(
      aiModel,
      [
        {
          role: 'system',
          content:
            'You are a session categorization assistant. Respond only with the requested JSON object, no extra text.',
        },
        { role: 'user', content: prompt },
      ],
      { temperature: 0 },
    );
    const raw = stripResponseWrappers(result.content);
    const parsed: unknown = JSON.parse(raw);
    const response = z.object({ groupDescription: z.string() }).parse(parsed);
    let description = response.groupDescription
      .trim()
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Hard guard: replace any path the LLM wrote that disagrees with the
    // deterministic root. We do not let the LLM choose the path.
    if (dominantRoot) {
      description = description.replace(
        /Project root:\s*(\/[^\s.,;:!?)<>"'`]+)/i,
        (_m, llmPath: string) => {
          if (llmPath === dominantRoot) return `Project root: ${dominantRoot}`;
          logger.info('generateGroupDescriptionFromSummaries: replacing hallucinated path', {
            groupName,
            llmPath,
            dominantRoot,
          });
          return `Project root: ${dominantRoot}`;
        },
      );
      if (!description.includes(dominantRoot)) {
        description = `Project root: ${dominantRoot}. ${description}`.trim();
      }
    }

    return truncateOnSentenceBoundary(description, 1000);
  } catch (err) {
    logger.warn('Group description generation from summaries failed', { groupName, error: err });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assemble the <project_context> block that gets prepended to every user
// turn for an already-grouped session. The block now contains:
//
//   <project_context name="...">
//   Working directory: /Users/me/MyApp
//   Confidence: high
//   Purpose: [1 sentence from the group-level description]
//   Primary language: [1 sentence from the group-level description]
//
//   Recent sessions in this project:
//   - 2026-06-11 18:32 — refactored the chat scroll behaviour
//   - 2026-06-10 14:05 — fixed a sqlite locking bug in the worker
//   ...
//   </project_context>
//
// Working directory + confidence come from the group's stored project root
// matched against the CURRENT session's deterministic root extraction.
// Confidence:
//   high   — group's stored path exactly matches the path the user is
//            currently typing about, or no fresh path was detected (so we
//            trust the stored one);
//   medium — current path is an ancestor or descendant of the stored path
//            (same project, different reference depth — the LLM should
//            confirm before assuming);
//   low    — current path is disjoint from the stored path, or no working
//            directory could be determined at all.
// ---------------------------------------------------------------------------
export type ProjectContextConfidence = 'high' | 'medium' | 'low';

export interface BuildProjectContextResult {
  text: string;
  workingDirectory: string | null;
  confidence: ProjectContextConfidence;
  groupDescriptionUpdatedAt: Date | null;
}

function isAncestorOrEqualPath(a: string, b: string): boolean {
  return a === b || b.startsWith(a.endsWith('/') ? a : a + '/');
}

function pathsRelated(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return isAncestorOrEqualPath(a, b) || isAncestorOrEqualPath(b, a);
}

function formatSessionTimestamp(d: Date | string | null | undefined): string {
  if (!d) return 'unknown time';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return 'unknown time';
  // YYYY-MM-DD HH:MM in UTC — concise and timezone-stable for context.
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

export async function buildProjectContext(
  subscriptionId: string,
  groupName: string,
  currentSessionInputs: string[] | null,
  excludeSessionId?: string,
): Promise<BuildProjectContextResult | null> {
  // Fetch the group's most recent description (purpose + language sentences)
  // and the last 5 session summaries from sibling sessions in the same group.
  // We deliberately include the EXCLUDED session's recent siblings rather
  // than the session itself — the current turn is what the user is typing
  // RIGHT NOW, so re-feeding its summary as "recent context" is redundant.
  const groupRow = await AgentSession.findOne({
    where: {
      subscriptionId,
      groupName,
      groupDescription: { [Op.not]: null },
    },
    attributes: ['groupName', 'groupDescription', 'groupDescriptionUpdatedAt'],
    order: [['last_active_at', 'DESC']],
  });
  if (!groupRow?.groupDescription) return null;

  const storedPath = extractStoredProjectPath(groupRow.groupDescription);
  const currentPath =
    currentSessionInputs && currentSessionInputs.length
      ? extractProjectPath(currentSessionInputs)
      : null;

  let confidence: ProjectContextConfidence;
  if (!currentPath) {
    // No fresh signal from this turn → trust the stored path (if any).
    confidence = storedPath ? 'high' : 'low';
  } else if (!storedPath) {
    confidence = 'low';
  } else if (storedPath === currentPath) {
    confidence = 'high';
  } else if (pathsRelated(storedPath, currentPath)) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // Recent sibling summaries. Filter out the current session so the agent
  // doesn't see its own (probably still-empty) summary as "recent activity".
  const siblingWhere: Record<string, unknown> = {
    subscriptionId,
    groupName,
    sessionSummary: { [Op.not]: null },
  };
  if (excludeSessionId) siblingWhere.id = { [Op.ne]: excludeSessionId };

  const recentSessions = await AgentSession.findAll({
    where: siblingWhere,
    order: [['last_active_at', 'DESC']],
    limit: 5,
    attributes: ['sessionSummary', 'lastActiveAt'],
  });

  // Trim the group-level description down to just the project-meta parts
  // (purpose + primary language). The deterministic shape we now write is
  // "Project root: ... . Purpose: ... . Primary language: ..." so we drop
  // the leading "Project root: ..." sentence and keep the rest.
  const projectMeta = groupRow.groupDescription.replace(/^Project root:\s*\S+\.\s*/i, '').trim();

  const lines: string[] = [];
  lines.push(`<project_context name="${groupRow.groupName}">`);
  if (storedPath || currentPath) {
    lines.push(`Working directory: ${currentPath ?? storedPath ?? '(unknown)'}`);
  } else {
    lines.push('Working directory: (not yet known)');
  }
  lines.push(
    `Confidence: ${confidence}` +
      (confidence === 'high'
        ? ''
        : ' (the path above may not be where this turn applies — confirm before running file operations)'),
  );
  if (projectMeta) {
    lines.push('');
    lines.push(projectMeta);
  }
  // Always surface how fresh the project meta is, so the agent can decide
  // whether to trust it vs. re-confirm from the messages.
  const descUpdatedAt = groupRow.groupDescriptionUpdatedAt ?? null;
  lines.push('');
  lines.push(
    `Group description last updated: ${descUpdatedAt ? formatSessionTimestamp(descUpdatedAt) : '(unknown — predates this feature; will be refreshed on the next cron tick)'}`,
  );
  if (recentSessions.length > 0) {
    lines.push('');
    lines.push(`Recent sessions in this project (most recent first):`);
    for (const s of recentSessions) {
      const ts = formatSessionTimestamp(s.lastActiveAt);
      const summary = (s.sessionSummary ?? '').trim();
      if (summary) lines.push(`- ${ts} — ${summary}`);
    }
  }
  lines.push('</project_context>');

  return {
    text: lines.join('\n'),
    workingDirectory: currentPath ?? storedPath,
    confidence,
    groupDescriptionUpdatedAt: descUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public: (re)generate the per-session summary for a single session.
//
// Called by the agent server when a session ends (WebSocket close). The
// summary is the unit of "recent activity" surfaced in future turns'
// <project_context> block — by refreshing it on session-end rather than
// on a cron schedule, the next session in the same group sees what the
// user JUST finished doing instead of what they were doing an hour ago.
//
// We do not gate by an in-memory marker here because the caller already
// knows the session has just ended; if there's nothing to summarise (no
// real user inputs) we bail silently.
// ---------------------------------------------------------------------------
export async function summariseSession(sessionId: string, subscriptionId: string): Promise<void> {
  try {
    const session = await AgentSession.findOne({
      where: { id: sessionId, subscriptionId },
      attributes: ['id', 'historyJson'],
    });
    if (!session) return;

    const inputs = extractUserInputs(session.historyJson);
    if (!inputs.length) return;

    const summary = await generateSessionSummary(inputs);
    if (!summary) return;

    await AgentSession.update({ sessionSummary: summary }, { where: { id: sessionId } });

    logger.info('Session summary generated on session end', { sessionId });
  } catch (err) {
    logger.warn('Failed to generate session summary on session end', { sessionId, error: err });
  }
}

// ---------------------------------------------------------------------------
// Public: update one session's group
// ---------------------------------------------------------------------------

export async function updateSessionGroup(sessionId: string, subscriptionId: string): Promise<void> {
  try {
    const session = await AgentSession.findOne({
      where: { id: sessionId, subscriptionId },
      attributes: ['id', 'historyJson'],
    });
    if (!session) return;

    const inputs = extractUserInputs(session.historyJson);
    if (!inputs.length) return;

    // Fetch existing distinct groups (by name) to encourage reuse
    const rows = await AgentSession.findAll({
      where: {
        subscriptionId,
        groupName: { [Op.not]: null },
        id: { [Op.ne]: sessionId },
      },
      attributes: ['groupName', 'groupDescription'],
      group: ['group_name'],
      limit: 50,
    });

    const existingGroups = rows
      .filter((s) => s.groupName)
      .map((s) => ({
        groupName: s.groupName!,
        groupDescription: s.groupDescription ?? null,
      }));

    // Step 1: classify to determine the group name. classifyGroup also
    // returns a description proposal, but for an EXISTING group we now
    // ignore that proposal — the group already has a description and we
    // do not want a new session's first turn to rewrite it. The cron
    // refreshes group-level descriptions on its own cadence.
    const result = await classifyGroup(inputs, existingGroups);
    if (!result) return;

    const isExistingGroup = existingGroups.some(
      (g) => g.groupName.toLowerCase() === result.groupName.toLowerCase(),
    );

    // For an existing group: do NOT overwrite the group description. Just
    // attach this session to the group. Recent-activity context is now
    // surfaced via per-session summaries (see Step 2) which buildProjectContext
    // pulls into the <project_context> block at injection time.
    //
    // For a brand-new group: use the description classifyGroup just produced.
    // No enrichment from siblings (there aren't any yet by definition).
    const descriptionToWrite = isExistingGroup ? undefined : result.groupDescription;

    // NOTE: we deliberately do NOT generate a per-session summary here.
    // sessionSummary is now produced when the session ENDS (see
    // summariseSession + the agentServer WebSocket close handler), so
    // it always reflects the session's final state instead of the first
    // turn of a still-in-progress conversation. If this session classifies
    // mid-conversation and a sibling needs <project_context> built before
    // we end, the sibling just won't see this session in its "recent
    // sessions" list yet — it will appear after the session ends.
    const update: Record<string, unknown> = { groupName: result.groupName };
    if (descriptionToWrite !== undefined) {
      update.groupDescription = descriptionToWrite;
      // Stamp the description's freshness timestamp so buildProjectContext
      // can show "Group description last updated: ..." on future turns.
      update.groupDescriptionUpdatedAt = new Date();
    }

    await AgentSession.update(update, { where: { id: sessionId } });

    logger.info('Session group updated', {
      sessionId,
      groupName: result.groupName,
      isExistingGroup,
      wroteGroupDescription: descriptionToWrite !== undefined,
    });
  } catch (err) {
    logger.error('Failed to update session group', { sessionId, error: err });
  }
}

// ---------------------------------------------------------------------------
// Cron helper: refresh the description for one group by collecting the most
// recent 10 user inputs across all sessions in that group and asking the LLM
// to UPDATE the existing description with any new findings.
// ---------------------------------------------------------------------------

// In-memory map of when we last refreshed each group's description. Keyed by
// `${subscriptionId}::${groupName}`. Lost on worker restart, which is fine —
// the first tick after restart will refresh everything once and then settle
// into the activity-gated steady state. We deliberately do NOT persist this
// to the DB: the existing AgentSession.updatedAt covers "was the description
// touched recently?" if we ever need durable tracking.
const lastRefreshedAt = new Map<string, Date>();

function refreshKey(subscriptionId: string, groupName: string): string {
  return `${subscriptionId}::${groupName}`;
}

async function refreshGroupDescription(
  subscriptionId: string,
  groupName: string,
  existingDescription: string | null,
): Promise<void> {
  try {
    // Skip-if-idle: only refresh when the group has had activity (a new user
    // turn pushed onto some session's history) since we last refreshed it.
    // Saves an LLM call per group per tick on quiet groups — the previous
    // implementation paid that cost forever even when nothing changed.
    const newest = await AgentSession.findOne({
      where: { subscriptionId, groupName },
      order: [['last_active_at', 'DESC']],
      attributes: ['lastActiveAt'],
    });
    if (!newest) return;
    const lastRefresh = lastRefreshedAt.get(refreshKey(subscriptionId, groupName));
    if (lastRefresh && newest.lastActiveAt <= lastRefresh) {
      logger.debug('Group description refresh skipped — no activity since last refresh', {
        subscriptionId,
        groupName,
        lastRefresh,
        lastActiveAt: newest.lastActiveAt,
      });
      return;
    }

    // Pull a window of recent sessions in the group along with their
    // already-written sessionSummary. We use the SUMMARIES as the LLM's
    // recent-activity context rather than re-extracting from raw history —
    // summaries are produced when each session ends (see agentServer's
    // WebSocket close handler), so the cron's job is just to roll them
    // up into a group-level description, not to re-mine the history.
    const sessions = await AgentSession.findAll({
      where: { subscriptionId, groupName },
      order: [['last_active_at', 'DESC']],
      limit: 15,
      attributes: ['id', 'historyJson', 'sessionSummary', 'lastActiveAt'],
    });

    // Per-session inputs + each session's dominant project root + its
    // existing summary. The split logic below still needs the raw inputs
    // because the dominant-root computation is what tells us when a group
    // has drifted across multiple unrelated projects.
    type Resolved = {
      id: string;
      inputs: string[];
      root: string | null;
      summary: string | null;
      lastActiveAt: Date;
    };
    const resolved: Resolved[] = sessions.map((s) => {
      const inputs = extractUserInputs(s.historyJson);
      return {
        id: s.id,
        inputs,
        root: extractProjectPath(inputs),
        summary: s.sessionSummary ?? null,
        lastActiveAt: s.lastActiveAt,
      };
    });

    // Count direct votes per root (sessions with no detectable root don't
    // contribute to the split decision, they ride along with whatever wins).
    const rawRootCounts = new Map<string, number>();
    for (const r of resolved) {
      if (r.root) rawRootCounts.set(r.root, (rawRootCounts.get(r.root) ?? 0) + 1);
    }

    // Collapse roots that are in an ancestor/descendant relationship into the
    // SHALLOWEST one — they are the same project, just referenced at
    // different depths (e.g. one session edits files in /Users/me/Repo, the
    // next edits files in /Users/me/Repo/api). Without this collapse the
    // split logic would treat /Users/me/Repo and /Users/me/Repo/api as two
    // separate projects and demote half the group on every tick.
    const isAncestorOrEqual = (a: string, b: string): boolean =>
      a === b || b.startsWith(a.endsWith('/') ? a : a + '/');
    const rawRoots = Array.from(rawRootCounts.keys());
    const canonicalOf = new Map<string, string>();
    for (const root of rawRoots) {
      let canonical = root;
      for (const other of rawRoots) {
        if (other === root) continue;
        if (isAncestorOrEqual(other, canonical)) canonical = other;
      }
      canonicalOf.set(root, canonical);
    }
    const rootCounts = new Map<string, number>();
    for (const [root, votes] of rawRootCounts.entries()) {
      const canon = canonicalOf.get(root) ?? root;
      rootCounts.set(canon, (rootCounts.get(canon) ?? 0) + votes);
    }

    // Dominant root: the canonical project most-referenced across sessions.
    // Ties are broken by shorter path (more likely the actual project root
    // when two truly disjoint trees somehow tie).
    const ranked = Array.from(rootCounts.entries()).sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : a[0].length - b[0].length,
    );
    const dominantRoot = ranked.length ? ranked[0][0] : null;

    // SPLIT: any session whose canonical root is non-null and DIFFERENT
    // from the dominant root does not belong in this group. We clear its
    // groupName/groupDescription so the next cron tick re-classifies it
    // into its own (likely new) group. We deliberately do NOT move it to a
    // specific named group here — classifyGroup handles naming, including
    // the path-match short-circuit that will merge it into an existing
    // sibling group if one already represents the same root.
    if (dominantRoot) {
      const stragglerIds = resolved
        .filter((r) => {
          if (!r.root) return false;
          const canon = canonicalOf.get(r.root) ?? r.root;
          return canon !== dominantRoot;
        })
        .map((r) => r.id);
      if (stragglerIds.length > 0) {
        logger.info(
          'Splitting polluted group: demoting sessions whose root differs from the dominant root',
          {
            subscriptionId,
            groupName,
            dominantRoot,
            stragglerCount: stragglerIds.length,
            otherRoots: Array.from(rootCounts.entries())
              .filter(([r]) => r !== dominantRoot)
              .map(([r, n]) => `${r} (${n})`),
          },
        );
        await AgentSession.update(
          { groupName: null, groupDescription: null },
          { where: { id: { [Op.in]: stragglerIds } } },
        );
      }
    }

    // Collect SUMMARIES from the most-recent ~5 sessions that belong to
    // the dominant root. We deliberately use the per-session sessionSummary
    // here, not the raw history — summaries are produced when each session
    // ends, so the cron's only job is to roll them up. This is the change
    // that fixes the previous behaviour where new sessions' raw history
    // dominated the prompt and reshaped the group's description around
    // whatever the latest session was about.
    const recentSummaries: Array<{ summary: string; lastActiveAt: Date }> = [];
    for (const r of resolved) {
      if (dominantRoot && r.root) {
        const canon = canonicalOf.get(r.root) ?? r.root;
        if (canon !== dominantRoot) continue;
      }
      if (!r.summary) continue;
      recentSummaries.push({ summary: r.summary, lastActiveAt: r.lastActiveAt });
      if (recentSummaries.length >= 5) break;
    }

    if (!recentSummaries.length && !existingDescription) {
      // Nothing to write yet — no summaries available and no prior
      // description to refresh. Bail without paying an LLM call.
      lastRefreshedAt.set(refreshKey(subscriptionId, groupName), new Date());
      return;
    }

    const newDescription = await generateGroupDescriptionFromSummaries(
      groupName,
      dominantRoot,
      recentSummaries,
      existingDescription,
    );

    if (!newDescription) return;

    // Sync the updated description AND its timestamp to every session that
    // REMAINS in this group (i.e. excluding the just-demoted stragglers).
    // The timestamp lets buildProjectContext show "Group description last
    // updated: ..." so the agent knows how fresh the project meta is.
    const updatedAt = new Date();
    await AgentSession.update(
      { groupDescription: newDescription, groupDescriptionUpdatedAt: updatedAt },
      { where: { subscriptionId, groupName } },
    );

    lastRefreshedAt.set(refreshKey(subscriptionId, groupName), updatedAt);

    logger.info('Group description refreshed', { subscriptionId, groupName, dominantRoot });
  } catch (err) {
    logger.error('Failed to refresh group description', { subscriptionId, groupName, error: err });
  }
}

// ---------------------------------------------------------------------------
// Public: refresh all sessions for a subscription (used by cron)
// ---------------------------------------------------------------------------

// Run an async function over each item in `items` with at most `limit`
// concurrent executions. Used to parallelise per-group refresh and
// per-session backfill within a subscription without unbounded fan-out
// against the LLM provider.
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = items.slice();
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await fn(item);
      } catch (err) {
        // Individual item failures are logged inside `fn`; we keep draining
        // the queue so one bad item never blocks the rest of the tick.
        logger.error('runWithConcurrency item failed', { error: err });
      }
    }
  };
  for (let i = 0; i < Math.max(1, limit); i++) workers.push(worker());
  await Promise.all(workers);
}

export async function refreshAllSessionGroups(subscriptionId: string): Promise<void> {
  try {
    // Refresh descriptions for all existing groups (one LLM call per group,
    // gated by the per-group skip-if-idle check inside refreshGroupDescription).
    const groupRows = await AgentSession.findAll({
      where: {
        subscriptionId,
        groupName: { [Op.not]: null },
      },
      attributes: ['groupName', 'groupDescription'],
      group: ['group_name'],
    });

    // Ungrouped sessions: classify any that have never been grouped yet.
    // Limited to the 20 most recently active so a long-quiet account with
    // thousands of historical ungrouped sessions still makes forward progress
    // tick by tick instead of blowing past the LLM rate limit on the first run.
    const ungroupedSessions = await AgentSession.findAll({
      where: { subscriptionId, groupName: null },
      order: [['last_active_at', 'DESC']],
      limit: 20,
      attributes: ['id'],
    });

    logger.info('Refreshing session groups', {
      subscriptionId,
      groupCount: groupRows.length,
      ungroupedCount: ungroupedSessions.length,
    });

    // The cron's responsibilities here are intentionally narrow:
    //
    //   1. Refresh existing groups' descriptions from their sessions' already-
    //      written sessionSummary fields (one LLM call per group, gated by
    //      the per-group skip-if-idle check inside refreshGroupDescription).
    //   2. Classify any sessions that don't yet have a group.
    //
    // We do NOT generate or refresh per-session summaries here — those are
    // produced by the agent server's session-end hook (see WebSocket close
    // handler). Driving summary generation off session-end rather than off
    // the hourly cron means summaries reflect the user's most recent state
    // immediately on disconnect, not up to an hour later.
    await Promise.allSettled([
      runWithConcurrency(groupRows, 3, async (row) => {
        await refreshGroupDescription(subscriptionId, row.groupName!, row.groupDescription ?? null);
      }),
      runWithConcurrency(ungroupedSessions, 3, async (session) => {
        await updateSessionGroup(session.id, subscriptionId);
      }),
    ]);
  } catch (err) {
    logger.error('Failed to refresh session groups for subscription', {
      subscriptionId,
      error: err,
    });
  }
}

// ---------------------------------------------------------------------------
// Cron: run hourly across all subscriptions.
//
// Each tick:
//   1. Lists every subscription.
//   2. For each subscription, refreshes existing group descriptions (gated by
//      activity since last refresh — quiet groups cost nothing) and classifies
//      up to 20 ungrouped sessions.
//
// Per-tick invariants:
//   - Only one tick runs at a time. If a tick exceeds the interval, the next
//     one is skipped instead of overlapping (overlap caused duplicate LLM
//     calls and racy AgentSession.update writes in the previous version).
//   - Subscriptions are processed concurrently with a small concurrency cap.
//   - An initial tick runs ~5 seconds after worker boot so sessions written
//     while the worker was down do not have to wait a full hour to be
//     grouped. Previously the boot-time backfill only ran when ZERO sessions
//     had ever been grouped, which silently regressed on every restart of a
//     normal account.
// ---------------------------------------------------------------------------

export const GROUPING_TICK_INTERVAL_MS = 60 * 60 * 1_000;
export const GROUPING_INITIAL_TICK_DELAY_MS = 5_000;
export const GROUPING_SUBSCRIPTION_CONCURRENCY = 3;

export function startGroupingCronJob(): void {
  let tickInFlight = false;

  const tick = async (): Promise<void> => {
    if (tickInFlight) {
      logger.warn('Skipping session grouping tick — previous tick still running');
      return;
    }
    tickInFlight = true;
    const startedAt = Date.now();
    try {
      const subscriptions = await Subscription.findAll({ attributes: ['id'] });
      logger.info('Running session grouping cron', {
        subscriptionCount: subscriptions.length,
      });
      await runWithConcurrency(subscriptions, GROUPING_SUBSCRIPTION_CONCURRENCY, async (sub) => {
        await refreshAllSessionGroups(sub.id);
      });
      logger.info('Session grouping cron tick completed', {
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      logger.error('Session grouping cron failed', { error: err });
    } finally {
      tickInFlight = false;
    }
  };

  setInterval(() => void tick(), GROUPING_TICK_INTERVAL_MS);
  logger.info('Session grouping cron started', {
    intervalMs: GROUPING_TICK_INTERVAL_MS,
  });

  // Always run an initial tick shortly after boot. We deliberately schedule
  // it (small delay) rather than awaiting it inline so worker bootstrap
  // returns immediately and the parent process can mark the worker healthy.
  // The previous "only if zero sessions have ever been grouped" gate meant
  // any restart of a real account would leave new ungrouped sessions
  // unclassified for up to an hour.
  setTimeout(() => void tick(), GROUPING_INITIAL_TICK_DELAY_MS);
}

// ---------------------------------------------------------------------------
// Test-only exports. Kept at the bottom of the file and prefixed with __ so
// they are obviously not part of the public API. The session grouping
// pipeline runs in a worker process and exercises the LLM, but the path
// extraction and input cleaning helpers are pure functions that we want
// thorough unit coverage on — they are the entire defence against the
// "session grouped under the wrong (often the parent) project" bug.
export const __testing__ = {
  generateSessionSummary,
  generateGroupDescriptionFromSummaries,
  buildProjectContext,
  summariseSession,
  extractUserInputs,
  extractProjectPath,
  extractAllProjectRoots,
  extractKeySubdirectories,
  truncateOnSentenceBoundary,
  stripInjectedWrappers,
  trimToProjectRoot,
  extractStoredProjectPath,
  findGroupByExactPath,
  classifyGroup,
  runWithConcurrency,
  refreshGroupDescription,
  lastRefreshedAt,
};
