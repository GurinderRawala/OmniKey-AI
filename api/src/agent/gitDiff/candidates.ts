/**
 * Deterministic repository-candidate discovery for Git session diffs.
 *
 * Candidates are directories on the CLIENT's execution host that the
 * current run demonstrably referred to. Sources, highest priority first:
 *   1. the structured `working_directory` shell argument,
 *   2. a literal leading `cd <absolute path>` or `git -C <absolute path>`,
 *   3. `pwd` output lines that are exactly one absolute path,
 *   4. absolute paths typed by the user in this run's input,
 *   5. the known `<project_context>` working directory,
 *   6. the candidates of this session's immediately previous run.
 *
 * Never used: the server's cwd or HOME, `~` expansion, recursive search,
 * model-generated patches, or execution/evaluation of script fragments.
 * The native collector re-verifies each path with Git on its own host.
 */
import { buildAbsolutePathRegex, stripUrls } from '../sessionGrouping/utils/pathExtraction';
import { trimToProjectRoot } from '../sessionGrouping/utils/trimToProjectRoot';
import { isLocalLookingPath } from '../sessionGrouping/utils/pathExtraction';
import {
  comparablePath,
  GIT_DIFF_MAX_CANDIDATES,
  isSafeAbsolutePath,
  normalizeAbsolutePath,
} from './contracts';

export type CandidateSource =
  | 'working_directory'
  | 'command'
  | 'pwd'
  | 'user_input'
  | 'project'
  | 'previous_run';

const SOURCE_PRIORITY: Record<CandidateSource, number> = {
  working_directory: 0,
  command: 1,
  pwd: 2,
  user_input: 3,
  project: 4,
  previous_run: 5,
};

/** A bare home directory or volume root is never a project candidate. */
function isBareContainer(path: string): boolean {
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return true;
  const first = parts[0].toLowerCase();
  if ((first === 'users' || first === 'home') && parts.length <= 2) return true;
  if (first === 'private' && parts.length <= 2) return true;
  if (first === 'volumes' && parts.length <= 1) return true;
  // Top-level directories such as /tmp, /opt or /root are containers too.
  return parts.length === 1;
}

/** Accept an explicit, structured directory exactly as given (bounded, local-looking). */
export function acceptDirectoryCandidate(value: unknown): string | null {
  if (!isSafeAbsolutePath(value)) return null;
  const path = normalizeAbsolutePath(value);
  if (!isLocalLookingPath(path) || isBareContainer(path)) return null;
  return path;
}

function unquote(token: string): string | null {
  if (token.startsWith('"') || token.startsWith("'")) {
    const quote = token[0];
    if (token.length < 2 || !token.endsWith(quote)) return null;
    const inner = token.slice(1, -1);
    // Double-quoted text with expansions is not literal; refuse it.
    if (quote === '"' && /[$`\\]/.test(inner)) return null;
    return inner;
  }
  // Unquoted: refuse anything a shell would expand or split.
  if (/[$`\\*?[\]{}~]/.test(token)) return null;
  return token;
}

const PATH_TOKEN = String.raw`("[^"\n]*"|'[^'\n]*'|[^\s;&|()<>]+)`;
const LEADING_CD = new RegExp(String.raw`^\s*cd\s+${PATH_TOKEN}\s*(?:&&|;|\n|$)`);
const GIT_DASH_C = new RegExp(String.raw`(?:^|[;&|(\n]|&&)\s*git\s+-C\s+${PATH_TOKEN}`, 'gm');
const PWD_COMMAND = /(?:^|[;&|\n]|&&)\s*pwd(?:\s+-[LP])?\s*(?:$|[;&|\n])/m;

/** Literal `cd`/`git -C` targets of a script. Never executes or evaluates it. */
export function literalScriptDirectories(script: string): string[] {
  const found: string[] = [];
  const cd = LEADING_CD.exec(script);
  if (cd) {
    const value = unquote(cd[1]);
    const accepted = value ? acceptDirectoryCandidate(value) : null;
    if (accepted) found.push(accepted);
  }
  for (const match of script.matchAll(GIT_DASH_C)) {
    const value = unquote(match[1]);
    const accepted = value ? acceptDirectoryCandidate(value) : null;
    if (accepted) found.push(accepted);
    if (found.length >= GIT_DIFF_MAX_CANDIDATES) break;
  }
  return found;
}

/** Output lines that are exactly one absolute path, only when the script ran `pwd`. */
export function pwdOutputDirectories(script: string, output: string): string[] {
  if (!PWD_COMMAND.test(script)) return [];
  const found: string[] = [];
  for (const line of output.split('\n').slice(0, 200)) {
    const trimmed = line.trim();
    if (!/^\/[^\s]*$/.test(trimmed)) continue;
    const accepted = acceptDirectoryCandidate(trimmed);
    if (accepted) found.push(accepted);
    if (found.length >= 2) break;
  }
  return found;
}

/** Absolute paths the user typed (no `~` expansion, URLs stripped, trimmed to a root). */
export function userInputDirectories(text: string): string[] {
  const found: string[] = [];
  const stripped = stripUrls(text.slice(0, 64 * 1024));
  for (const match of stripped.matchAll(buildAbsolutePathRegex())) {
    const raw = match[1].replace(/[.,;:!?)\]]+$/, '');
    // Only paths that start a token: "/Users/x" not "foo/Users/x".
    const startIndex = match.index ?? 0;
    if (startIndex > 0 && !/[\s(["'`=:]/.test(stripped[startIndex - 1])) continue;
    const root = trimToProjectRoot(raw);
    const accepted = root ? acceptDirectoryCandidate(root) : null;
    if (accepted) found.push(accepted);
    if (found.length >= GIT_DIFF_MAX_CANDIDATES) break;
  }
  return found;
}

/** `Working directory: <path>` from the server-built `<project_context>` block. */
export function projectContextDirectory(text: string): string | null {
  const block = /<project_context\b[^>]*>([\s\S]*?)<\/project_context>/i.exec(text);
  if (!block) return null;
  const line = /^Working directory:\s*(\/\S+)\s*$/m.exec(block[1]);
  return line ? acceptDirectoryCandidate(line[1]) : null;
}

/** Ordered, de-duplicated, bounded candidate set. */
export class CandidateSet {
  private entries: Array<{ path: string; source: CandidateSource; order: number }> = [];
  private counter = 0;

  add(path: string | null | undefined, source: CandidateSource): void {
    if (!path) return;
    const key = comparablePath(path);
    const existing = this.entries.find((entry) => comparablePath(entry.path) === key);
    if (existing) {
      if (SOURCE_PRIORITY[source] < SOURCE_PRIORITY[existing.source]) existing.source = source;
      return;
    }
    // Hard memory bound regardless of how many shells a run executes.
    if (this.entries.length >= GIT_DIFF_MAX_CANDIDATES * 4) {
      const worst = this.entries.reduce((a, item) =>
        SOURCE_PRIORITY[item.source] > SOURCE_PRIORITY[a.source] ||
        (SOURCE_PRIORITY[item.source] === SOURCE_PRIORITY[a.source] && item.order < a.order)
          ? item
          : a,
      );
      if (SOURCE_PRIORITY[source] > SOURCE_PRIORITY[worst.source]) return;
      this.entries.splice(this.entries.indexOf(worst), 1);
    }
    this.entries.push({ path, source, order: this.counter++ });
  }

  addAll(paths: readonly string[], source: CandidateSource): void {
    for (const path of paths) this.add(path, source);
  }

  /** Highest priority first; most recent evidence first within a priority. */
  list(limit = GIT_DIFF_MAX_CANDIDATES): string[] {
    return [...this.entries]
      .sort((a, b) => SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source] || b.order - a.order)
      .slice(0, limit)
      .map((entry) => entry.path);
  }

  get size(): number {
    return this.entries.length;
  }
}
