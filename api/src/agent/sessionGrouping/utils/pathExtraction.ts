/**
 * Deterministic project-root extraction. Given a slab of user-typed text,
 * produce the most likely absolute filesystem path of the project the user
 * is working in. The pipeline has three layers:
 *
 *   1. Strip every URL-shaped token from the text BEFORE running the path
 *      regex (URL_LIKE_REGEXES). Real filesystem paths never carry a
 *      URL scheme, and bare host.tld/path references would otherwise leak
 *      through as "/<host>/<path>" matches.
 *   2. Match what remains against an unbounded absolute-path regex
 *      (buildAbsolutePathRegex). Path segments cannot contain whitespace,
 *      <>, quotes, or any regex metacharacters that show up in source code
 *      but never in real filesystem paths.
 *   3. Normalise each match via trimToProjectRoot — strips trailing file
 *      segments, walks up through non-root subdirs (src/lib/dist/...),
 *      bails on bare home directories or top-level pseudo-roots, and only
 *      accepts paths under known local-computer prefixes (LOCAL_PATH_PREFIXES).
 *
 * extractProjectPath then counts DIRECT votes per normalised root — no
 * ancestor rollup — and breaks ties by preferring the deeper path. That
 * stops a single leaked parent reference from outvoting many references
 * to the real project.
 */

// ---------------------------------------------------------------------------
// Path-segment classifiers used by trimToProjectRoot

/**
 * Path segments that are never a project root on their own. When the deepest
 * scored candidate ends in one of these we walk up one level. Matched
 * case-insensitively against the final segment.
 */
export const NON_ROOT_SEGMENTS = new Set([
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

/**
 * Top-level OS roots that contain user home directories. The segment
 * immediately after one of these is a username, NOT a project — so we
 * always skip both segments when computing the shallowest legitimate
 * project depth.
 */
export const HOME_ROOT_SEGMENTS = new Set(['users', 'home']);

/**
 * Generic container directories that sit between a username and the project
 * root and therefore can never themselves BE the project. We walk through
 * any chain of these when determining the first project-eligible segment.
 */
export const HOME_CONTAINER_SEGMENTS = new Set([
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

// ---------------------------------------------------------------------------
// URL stripping — runs BEFORE the path regex, so URL-shaped tokens never
// contribute a project-root candidate.

/**
 * URL-shaped tokens that the regex would otherwise capture as a path. We
 * replace each match with a single space so adjacent real path tokens stay
 * separated. Covers:
 *   - full URLs with scheme (http(s)://, ftp(s)://, ssh://, git://, git+...://,
 *     file://, ws(s)://, mailto:, chrome[-extension]:, vscode:, data:)
 *   - scheme-relative URLs (//host.tld/path)
 *   - git remotes (git@host:owner/repo)
 *   - bare host.tld/path or localhost:port/path references with no scheme
 */
const URL_LIKE_REGEXES: readonly RegExp[] = [
  /\b(?:https?|ftps?|sftp|ssh|git|git\+ssh|git\+https?|file|ws|wss|chrome|chrome-extension|vscode|data)(?::\/\/|:)[^\s<>"'`]+/gi,
  /(?<![A-Za-z0-9_])\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/[^\s<>"'`]*)?/gi,
  /\bgit@[a-z0-9.-]+:[^\s<>"'`]+/gi,
  /\bmailto:[^\s<>"'`]+/gi,
  /\b(?:[a-z0-9-]+\.[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?|localhost:\d+)\/[^\s<>"'`]*/gi,
];

export function stripUrls(text: string): string {
  let out = text;
  for (const re of URL_LIKE_REGEXES) out = out.replace(re, ' ');
  return out;
}

// ---------------------------------------------------------------------------
// Local-path allow-list — only paths rooted under a known local-computer
// prefix are accepted as project roots. Anything else (top-level pseudo-
// roots like /work/..., route paths bleeding out of URLs the stripper
// missed, the macOS volume root) is dropped rather than guessed at.

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

export function isLocalLookingPath(path: string): boolean {
  return LOCAL_PATH_PREFIXES.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// Centralised absolute-path regex. Returns a fresh /g RegExp on every call
// because /g RegExps carry mutable lastIndex state between matchAll calls.
//
// The matcher is intentionally UNBOUNDED on the number of trailing path
// segments — a deep monorepo file like
//   /Users/me/Documents/projects/org/monorepo/packages/api/src/index.ts
// has 10 segments and we want to capture the full path so the downstream
// trimToProjectRoot can walk it up to the real project root.

export function buildAbsolutePathRegex(): RegExp {
  return /(\/(?:[^\s/<>"'`?^${}\[\]()|\\*+]+\/)+[^\s/<>"'`?^${}\[\]()|\\*+]*)/g;
}

// ---------------------------------------------------------------------------
// First-segment domain detection — a final guard inside trimToProjectRoot
// for URL-shaped paths that somehow survive the URL stripper.

const DOMAINY_FIRST_SEGMENT = /^(?:localhost(?::\d+)?$|[a-z0-9-]+\.[a-z]{2,}(?:\.[a-z]{2,})*$)/i;

export function firstSegmentLooksLikeDomain(segment: string): boolean {
  return DOMAINY_FIRST_SEGMENT.test(segment);
}

// ---------------------------------------------------------------------------
// File-vs-directory heuristic — used to strip a trailing filename off
// captured paths before treating them as project roots.

export function looksLikeFile(segment: string): boolean {
  if (!segment) return false;
  if (segment.startsWith('.') && segment.length > 1 && !segment.includes('/')) {
    // .git, .github, .vscode are directories handled by NON_ROOT_SEGMENTS;
    // .env, .gitignore, .prettierrc are files.
    const known = new Set(['.git', '.github', '.vscode', '.idea', '.next', '.cache']);
    return !known.has(segment.toLowerCase());
  }
  return /\.[A-Za-z0-9]{1,8}$/.test(segment);
}

// ---------------------------------------------------------------------------
// Tilde expansion — handled here (not in the caller) so every path
// extractor benefits without duplicating the logic.

export function tildeExpand(text: string): string {
  const homeDir =
    (typeof process !== 'undefined' && (process.env.HOME || process.env.USERPROFILE)) || '';
  if (!homeDir) return text;
  return text.replace(/(^|[\s(\["'`])~\//g, (_m, pre: string) => `${pre}${homeDir}/`);
}
