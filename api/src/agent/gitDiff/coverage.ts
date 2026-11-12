/**
 * Conservative coverage assessment for a final-answer diff.
 *
 * A snapshot may be attached only when every change the backend KNOWS about
 * this turn (literal write targets of this run's write-like shells and the
 * paths of verified native records) is covered by an actual patch section, or
 * lies inside a root the normal capture authoritatively reported net-empty.
 * Anything the backend cannot account for (unresolved write targets,
 * truncated/withheld evidence, budget overflow, native omissions, sensitive
 * exclusions) is a blocking uncertainty: the snapshot is withheld.
 *
 * This is a boundary check over known evidence only. Writes performed by
 * scripts the heuristic does not recognise are invisible here, so "coverage
 * complete" never means "every change on disk is shown".
 */
import {
  comparablePath,
  isSafeRelativePath,
  normalizeAbsolutePath,
  pathIsWithin,
  type DiffRecoveryRecord,
  type GitDiffRepository,
} from './contracts';
import type { DiffRecoveryRunState } from './coordinator';
import { TASK_ENTRY_PATH, type ShellWriteEvidence, type WriteTarget } from './writeEvidence';

/** Bounded so an adversarial patch cannot make coverage checks expensive. */
const MAX_PATCH_PATHS = 4_096;
/** Native sentence for a missing baseline; handled per repository instead. */
const BASELINE_UNAVAILABLE_REASON = /Turn baseline unavailable for [^.]*\.\s*/g;

/** Paths a single patch section header names, or [] when not safely parseable. */
function sectionPaths(header: string, meta: string[]): string[] {
  const out = new Set<string>();
  const add = (p: string | undefined) => {
    if (p && isSafeRelativePath(p)) out.add(p);
  };
  for (const line of meta) {
    // Git appends one TAB to ---/+++ names that contain a space.
    if (line.startsWith('--- a/')) add(line.slice(6).replace(/\t$/, ''));
    else if (line.startsWith('+++ b/')) add(line.slice(6).replace(/\t$/, ''));
    else if (line.startsWith('rename from ')) add(line.slice(12));
    else if (line.startsWith('rename to ')) add(line.slice(10));
    else if (line.startsWith('copy to ')) add(line.slice(8));
  }
  if (out.size) return [...out];
  // Header-only sections (mode change, empty new file, binary): accept only
  // the unambiguous symmetric form `a/P b/P`. Quoted paths never match.
  const rest = header.slice('diff --git '.length);
  // `a/` + P + ` b/` + P  =>  length 5 + 2·|P|.
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

/** Remove file sections whose paths are already covered (never duplicate a verified file). */
export function withoutCoveredSections(
  root: string,
  patch: string,
  covered: ReadonlySet<string>,
): string {
  const sections = patch.split(/(?=^diff --git )/m);
  return sections
    .filter((section) => {
      if (!section.startsWith('diff --git ')) return section.trim().length > 0;
      const paths = patchCoveredPaths(root, section);
      return ![...paths].some((p) => covered.has(p));
    })
    .join('');
}

/** One repository the backend treats as verified evidence for this turn. */
export interface VerifiedRepository {
  repository: GitDiffRepository;
  source: 'automatic' | 'checkpoint';
  /** Automatic turn capture of the whole root from a recorded baseline. */
  turnVerified: boolean;
  /** IDs actually replayed into this checkpoint, never inferred from paths. */
  evidenceIds?: readonly string[];
}

export interface CoverageInput {
  state: DiffRecoveryRunState | undefined;
  verified: readonly VerifiedRepository[];
  /** Roots authoritatively net-empty (automatic capture) or reverted. */
  unchangedRoots: readonly string[];
  /** Native records whose paths must be covered (all of this run's). */
  records: readonly DiffRecoveryRecord[];
  /** Extra known blocking reasons gathered by the caller. */
  blocking?: readonly string[];
}

export interface CoverageAssessment {
  /** Known allowlisted paths not covered by any verified patch. */
  missing: Map<string, WriteTarget>;
  /** Reasons coverage can never be proven for this turn. */
  blocking: string[];
  /** True only with nothing missing and nothing blocking. */
  complete: boolean;
}

/** Native `reason` text that discloses exclusions (anything but the baseline sentence). */
export function reasonDisclosesExclusion(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason.replace(BASELINE_UNAVAILABLE_REASON, '').trim().length > 0;
}

const isGitLikeKind = (kind: string) => kind.startsWith('git ') || kind === 'patch';

/**
 * Could `write` have changed the (comparable) path `p`? Unknown targets
 * always may; a removal also reaches everything below it. Task bookkeeping
 * needs no coverage of its own but still touches what it names, and a
 * pattern-only entry (task directory not literal) touches that entry of ANY
 * task directory.
 */
function writeMayTouch(write: ShellWriteEvidence, p: string): boolean {
  if (write.unresolved) return true;
  const hits = (path: string, removed: boolean) =>
    comparablePath(path) === p || (removed && pathIsWithin(p, path));
  if (write.targets.some((t) => hits(t.path, t.removed))) return true;
  return (write.auxiliaryTargets ?? []).some((a) => {
    if (a.path) return hits(a.path, a.removed);
    const parts = p.split('/');
    for (let depth = 6; depth <= parts.length; depth++) {
      const prefix = parts.slice(0, depth).join('/');
      const m = TASK_ENTRY_PATH.exec(prefix);
      if (m && m[1] === a.name) return depth === parts.length || a.removed;
    }
    return false;
  });
}

/**
 * Coverage of the known turn evidence by the verified repositories. Missing
 * paths keep the strictest creation/deletion evidence (all writes must agree).
 */
export function coverageAssessment(input: CoverageInput): CoverageAssessment {
  const blocking = [...(input.blocking ?? [])];
  const covered = new Set<string>();
  const automatic = new Set(
    input.verified
      .filter((v) => v.turnVerified)
      .flatMap((v) => [...patchCoveredPaths(v.repository.root, v.repository.patch)]),
  );
  const order = [...(input.state?.issuedToolCalls ?? [])];
  for (const v of input.verified) {
    for (const p of patchCoveredPaths(v.repository.root, v.repository.patch)) {
      if (v.source !== 'checkpoint' || automatic.has(p)) {
        covered.add(p);
        continue;
      }
      const relevant = input.records.filter((r) =>
        r.paths.some((rel) => comparablePath(`${r.root}/${rel}`) === p),
      );
      const ids = new Set(v.evidenceIds ?? []);
      const allReplayed = relevant.length > 0 && relevant.every((r) => ids.has(r.id));
      const latest = Math.max(
        -1,
        ...relevant.filter((r) => ids.has(r.id)).map((r) => order.indexOf(r.toolCallId)),
      );
      const laterWrite = input.state?.writes.some(
        (w) => order.indexOf(w.toolCallId) > latest && writeMayTouch(w, p),
      );
      if (!allReplayed || laterWrite) blocking.push('checkpoint_not_final');
      else covered.add(p);
    }
  }
  const exempt = (path: string) =>
    input.unchangedRoots.some((root) => pathIsWithin(path, root)) ||
    (input.state?.revertedRoots ?? []).some((root) => pathIsWithin(path, root));
  const turnRoots = input.verified.filter((v) => v.turnVerified).map((v) => v.repository.root);
  const missing = new Map<string, WriteTarget>();
  const need = (target: WriteTarget) => {
    const key = comparablePath(target.path);
    if (covered.has(key) || exempt(target.path)) return;
    const prev = missing.get(key);
    missing.set(key, {
      path: prev?.path ?? target.path,
      created: prev ? prev.created && target.created : target.created,
      removed: (prev?.removed ?? false) || target.removed,
    });
  };
  const state = input.state;
  if (state) {
    if (state.omitted > 0) blocking.push('records_over_budget');
    if ((state.nativeOmitted ?? 0) > 0) blocking.push('native_omitted');
    if ((state.replayOmitted ?? 0) > 0) blocking.push('checkpoint_replay_incomplete');
    if ((state.writesOmitted ?? 0) > 0) blocking.push('writes_over_budget');
    for (const write of state.writes) {
      if (write.truncated) blocking.push('write_evidence_truncated');
      if (write.unresolved) blocking.push('write_target_unknown');
      if (write.kinds.some(isGitLikeKind)) {
        // Git/patch operations act on the repository at cwd; only an
        // authoritative whole-root capture (or net-empty root) covers them.
        const cwd = write.cwd;
        const inRoot =
          cwd !== undefined &&
          [...turnRoots, ...input.unchangedRoots].some((root) => pathIsWithin(cwd, root));
        if (!inRoot) blocking.push('write_target_unknown');
      }
      for (const target of write.targets) need(target);
    }
  }
  for (const record of input.records) {
    if (!record.complete) blocking.push('native_record_truncated');
    for (const rel of record.paths) {
      need({
        path: normalizeAbsolutePath(`${record.root}/${rel}`),
        // Only file records carry verified absence/presence hashes.
        created: record.kind === 'file' && record.before === null,
        removed: record.kind === 'file' && record.after === null,
      });
    }
  }
  const unique = [...new Set(blocking)];
  return { missing, blocking: unique, complete: missing.size === 0 && unique.length === 0 };
}
