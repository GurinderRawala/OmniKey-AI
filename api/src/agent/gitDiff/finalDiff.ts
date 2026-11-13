/**
 * Final-answer diff: Git first, agent patches only as a per-file fallback.
 *
 * 1. The normal native Git capture runs exactly as before (no model call).
 *    Its valid repositories are authoritative. In turn mode only roots with a
 *    verified turn baseline are kept; a baseline-less root's working-tree
 *    patch is not attributable to this turn and is omitted (disclosed in the
 *    notice), never shown as a guess.
 * 2. When the run advertised `supports_agent_patches` and the accepted final
 *    answer carried a fully valid `<file_patches>` report (agentPatch.ts),
 *    each agent file whose path (or rename source) is NOT already covered by
 *    a Git file section is added, grouped under its Git root when it lies in
 *    one, else under its own directory. Git sections are never replaced.
 * 3. Nothing else: no second model call, no script analysis, no evidence or
 *    proof orchestration. Any failure means "no snapshot"; the final answer is
 *    never lost or delayed beyond the bounded native capture.
 */
import type { Logger } from 'winston';
import {
  GIT_DIFF_MAX_REPOSITORIES,
  comparablePath,
  isSafeAbsolutePath,
  isSafeRelativePath,
  normalizeAbsolutePath,
  pathIsWithin,
  type GitDiffRepository,
  type SessionDiffCandidate,
  type SessionDiffRecoveryProvenance,
  type SessionDiffSummary,
} from './contracts';
import { captureSessionDiffCandidate, saveSessionDiff, type GitRunState } from './coordinator';
import { renderAgentPatchSection, type AgentPatchFile, type AgentPatchReport } from './agentPatch';

/** Native sentence for a missing baseline (replaced by our own note). */
const BASELINE_UNAVAILABLE_REASON = /Turn baseline unavailable for [^.]*\.\s*/g;
/** Bounded so an adversarial patch cannot make coverage checks expensive. */
const MAX_PATCH_PATHS = 4_096;

/** Decode a Git C-quoted path body (`"a/caf\303\251"` without the quotes). */
function unquoteGitPath(value: string): string | undefined {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = value[++i];
    const simple: Record<string, number> = {
      n: 10,
      t: 9,
      '"': 34,
      '\\': 92,
      a: 7,
      b: 8,
      f: 12,
      r: 13,
      v: 11,
    };
    if (next !== undefined && next in simple) bytes.push(simple[next]);
    else if (/^[0-7]{3}$/.test(value.slice(i, i + 3))) {
      bytes.push(parseInt(value.slice(i, i + 3), 8));
      i += 2;
    } else return undefined;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `a/P` / `b/P` / `"a/P"` file-line name -> P (or undefined). */
function fileLineName(raw: string, prefix: 'a/' | 'b/'): string | undefined {
  const value = raw.replace(/\t$/, '');
  if (value.startsWith('"') && value.endsWith('"') && value.length > 2) {
    const decoded = unquoteGitPath(value.slice(1, -1));
    return decoded?.startsWith(prefix) ? decoded.slice(2) : undefined;
  }
  return value.startsWith(prefix) ? value.slice(2) : undefined;
}

/** Relative paths one Git file section names (old and new sides). */
function sectionPaths(header: string, meta: string[]): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined) => {
    if (p && isSafeRelativePath(p)) out.add(p);
  };
  for (const line of meta) {
    if (line.startsWith('--- ')) add(fileLineName(line.slice(4), 'a/'));
    else if (line.startsWith('+++ ')) add(fileLineName(line.slice(4), 'b/'));
    else if (line.startsWith('rename from ')) add(line.slice(12));
    else if (line.startsWith('rename to ')) add(line.slice(10));
    else if (line.startsWith('copy to ')) add(line.slice(8));
  }
  if (out.size) return [...out];
  // Header-only sections (mode change, empty file, binary): the symmetric
  // `a/P b/P` form only.
  const rest = header.slice('diff --git '.length);
  if (rest.startsWith('a/') && (rest.length - 5) % 2 === 0) {
    const half = (rest.length - 5) / 2;
    const left = rest.slice(2, 2 + half);
    if (rest.slice(2 + half) === ` b/${left}`) add(left);
  }
  return [...out];
}

/** Comparable absolute paths of every file section of `patch` under `root`. */
export function patchCoveredPaths(root: string, patch: string): Set<string> {
  const covered = new Set<string>();
  const base = normalizeAbsolutePath(root);
  let header: string | undefined;
  let meta: string[] = [];
  const flush = () => {
    if (header === undefined) return;
    for (const rel of sectionPaths(header, meta)) {
      if (covered.size >= MAX_PATCH_PATHS) break;
      covered.add(comparablePath(`${base}/${rel}`));
    }
  };
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      header = line;
      meta = [];
      inHunk = false;
    } else if (line.startsWith('@@')) {
      inHunk = true;
    } else if (!inHunk && header !== undefined) {
      meta.push(line);
    }
  }
  flush();
  return covered;
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index > 0 ? path.slice(0, index) : '/';
}

/** Deepest common directory of absolute paths (may be "/"). */
function commonDirectory(paths: readonly string[]): string {
  const split = paths.map((p) => normalizeAbsolutePath(p).split('/').filter(Boolean));
  const first = split[0] ?? [];
  let n = 0;
  while (n < first.length && split.every((parts) => parts[n] === first[n])) n++;
  return `/${first.slice(0, n).join('/')}`;
}

/** Git repositories usable as authoritative turn evidence. */
export function authoritativeGitRepositories(candidate: SessionDiffCandidate | undefined): {
  repositories: GitDiffRepository[];
  omittedRoots: string[];
} {
  const repositories: GitDiffRepository[] = [];
  const omittedRoots: string[] = [];
  for (const repository of candidate?.repositories ?? []) {
    // Turn mode: a root without a verified baseline only has "working tree
    // vs HEAD", which is not evidence of what this turn changed.
    if (candidate?.turn && repository.scope !== 'turn') omittedRoots.push(repository.root);
    else repositories.push(repository);
  }
  return { repositories, omittedRoots };
}

/**
 * Agent files not covered by Git, rendered into `reconstructed` entries.
 * Returns null when the agent entries cannot be grouped within bounds.
 */
export function agentRepositories(
  files: readonly AgentPatchFile[],
  git: readonly GitDiffRepository[],
  knownRoots: readonly string[],
): { repositories: GitDiffRepository[]; duplicates: number } | null {
  const covered = new Set<string>();
  for (const repository of git) {
    for (const p of patchCoveredPaths(repository.root, repository.patch)) covered.add(p);
  }
  const roots = [...new Set([...git.map((r) => r.root), ...knownRoots].map(normalizeAbsolutePath))]
    .filter(isSafeAbsolutePath)
    .sort((a, b) => b.length - a.length);
  let duplicates = 0;
  const fresh: AgentPatchFile[] = [];
  for (const file of files) {
    const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
    if (paths.some((p) => covered.has(comparablePath(p)))) duplicates += 1;
    else fresh.push(file);
  }
  if (!fresh.length) return { repositories: [], duplicates };
  const rootOf = (file: AgentPatchFile): string | undefined => {
    const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
    return roots.find((root) =>
      paths.every((p) => pathIsWithin(p, root) && comparablePath(p) !== comparablePath(root)),
    );
  };
  const assign = (
    collapse: boolean,
  ): Map<string, { root: string; files: AgentPatchFile[] }> | null => {
    const groups = new Map<string, { root: string; files: AgentPatchFile[] }>();
    const loose = fresh.filter((f) => !rootOf(f));
    const looseRoot = collapse
      ? commonDirectory(
          loose.flatMap((f) => [dirname(f.path), ...(f.oldPath ? [dirname(f.oldPath)] : [])]),
        )
      : undefined;
    for (const file of fresh) {
      const root =
        rootOf(file) ??
        looseRoot ??
        commonDirectory([dirname(file.path), ...(file.oldPath ? [dirname(file.oldPath)] : [])]);
      if (!isSafeAbsolutePath(root)) return null;
      const key = comparablePath(root);
      const group = groups.get(key) ?? { root, files: [] };
      group.files.push(file);
      groups.set(key, group);
    }
    return groups;
  };
  const distinct = (groups: Map<string, unknown>) =>
    new Set([...git.map((r) => comparablePath(r.root)), ...groups.keys()]).size;
  let groups = assign(false);
  if (!groups || distinct(groups) > GIT_DIFF_MAX_REPOSITORIES) groups = assign(true);
  if (!groups || distinct(groups) > GIT_DIFF_MAX_REPOSITORIES) return null;
  return {
    duplicates,
    repositories: [...groups.values()].map(({ root, files: grouped }) => ({
      root,
      patch: grouped.map((f) => renderAgentPatchSection(f, root)).join(''),
      scope: 'working_tree' as const,
      reconstructed: true as const,
    })),
  };
}

export interface FinalDiffOptions {
  signal: AbortSignal | undefined;
  log: Logger;
  /** Report parsed from THIS candidate final only (never stored on the run). */
  agentReport?: AgentPatchReport;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The single final-capture helper of success and failure finals. Returns the
 * saved summary, or undefined (no button; final answer unchanged). Never throws.
 */
export async function captureFinalSessionDiff(
  run: GitRunState | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  options: FinalDiffOptions,
): Promise<SessionDiffSummary | undefined> {
  const { log, signal } = options;
  const aborted = () => Boolean(signal?.aborted || run?.connection?.aborted);
  if (!run || aborted()) return undefined;
  try {
    const outcome = await captureSessionDiffCandidate(run, history, signal, log);
    if (aborted()) return undefined;
    const candidate = outcome.candidate;
    const git = authoritativeGitRepositories(candidate);
    const report = run.agentPatches ? options.agentReport : undefined;
    if (report?.rejected) {
      log.info('Rejected agent file patches', {
        sessionId: run.sessionId,
        reason: report.rejected,
      });
    }
    const agent = report?.files?.length
      ? agentRepositories(report.files, git.repositories, [
          ...run.baselines.map((b) => b.root),
          ...git.omittedRoots,
        ])
      : undefined;
    if (agent === null) {
      log.info('Agent file patches exceed repository bounds; ignored', {
        sessionId: run.sessionId,
      });
    }
    const agentEntries = agent?.repositories ?? [];
    if (!git.repositories.length && !agentEntries.length) return undefined;

    const omittedNote = git.omittedRoots.length
      ? `Turn baseline unavailable for ${git.omittedRoots.join(', ')}; Git changes there are not shown because they cannot be attributed to this turn.`
      : '';
    // Native disclosures (e.g. excluded sensitive files) are kept; its own
    // baseline sentence is replaced by the omission note above.
    const reasonNote = (candidate?.reason ?? '').replace(BASELINE_UNAVAILABLE_REASON, '').trim();
    const notice = [omittedNote, reasonNote].filter(Boolean).join(' ') || undefined;
    const turn = git.repositories.some((r) => r.scope === 'turn') ? candidate?.turn : undefined;
    if (aborted()) return undefined;

    if (!agentEntries.length) {
      const summary = await saveSessionDiff(run, git.repositories, notice, turn);
      log.info('Saved git snapshot for final answer', {
        sessionId: run.sessionId,
        diffId: summary.id,
        fileCount: summary.fileCount,
        repositoryCount: summary.repositoryCount,
        omittedRoots: git.omittedRoots.length,
      });
      return summary;
    }

    const agentFiles = report!.files!.length - (agent?.duplicates ?? 0);
    const limitations = [
      `${plural(agentFiles, 'file is', 'files are')} shown from patches the agent wrote in its final answer; they were not read from disk and are not verified.`,
      ...(git.repositories.length ? ['Other files are from the Git capture of this turn.'] : []),
      ...(agent?.duplicates
        ? [
            `${plural(agent.duplicates, 'agent-reported file was', 'agent-reported files were')} already captured by Git; the Git version is shown.`,
          ]
        : []),
      ...(omittedNote ? [omittedNote] : []),
      'Changes the agent did not report may be missing.',
    ];
    const provenance: SessionDiffRecoveryProvenance = {
      kind: 'agent_patch',
      turnId: run.runId,
      evidenceIds: [],
      complete: false,
      limitations,
      reportSource: 'agent_final',
      ...(git.repositories.length ? { base: 'automatic' as const } : {}),
    };
    const summary = await saveSessionDiff(
      run,
      [...git.repositories, ...agentEntries],
      notice,
      turn,
      provenance,
    );
    log.info('Saved git snapshot with agent patches for final answer', {
      sessionId: run.sessionId,
      diffId: summary.id,
      fileCount: summary.fileCount,
      repositoryCount: summary.repositoryCount,
      agentFiles,
      duplicates: agent?.duplicates ?? 0,
    });
    return summary;
  } catch (err) {
    log.warn('Final session diff failed; delivering final answer without it', {
      sessionId: run.sessionId,
      error: err instanceof Error ? err.name : 'error',
    });
    return undefined;
  }
}
