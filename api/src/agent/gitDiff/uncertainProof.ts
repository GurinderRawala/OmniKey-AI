/**
 * Proof gate for an AI reconstruction whose KNOWN coverage is uncertain (not
 * known partial). Some turns run write-like commands whose targets the backend
 * cannot resolve (`write_target_unknown`) or whose excerpt was cut
 * (`write_evidence_truncated`). Such a turn may still be shown as an
 * "Unverified — coverage uncertain" AI viewer, but only when:
 *
 * - every other blocking reason is absent (exclusions, budget overflow, native
 *   omissions/truncation, stale checkpoints, missing baselines all still
 *   withhold: they are known gaps or policy limits, never uncertainty);
 * - no uncertain write carries redacted/withheld (sensitive) evidence;
 * - the backend holds independent, current-turn PROOF that something changed.
 *   A successful write-like exit is not proof (cp/mkdir/touch/no-op may change
 *   nothing) and neither is anything the model says. Proof is one of:
 *     - `verified_patch`: a non-empty turn-scoped automatic patch or a native
 *       checkpoint replay of this turn;
 *     - `native_record`: a complete native `file` record of one path whose
 *       before/after content hashes differ;
 *     - `exclusive_create`: a literal target of a succeeded first shell with
 *       verified creation evidence (`WriteTarget.created`) and no removal.
 *
 * Proven paths that are not already in a verified patch must then appear as a
 * changed AI file, so a viewer never consists of guesses alone. The allowlist
 * is never widened here: unknown writes stay invisible and the model may only
 * address the known missing paths.
 */
import {
  COVERAGE_UNCERTAINTIES,
  comparablePath,
  type ChangeProofSource,
  type CoverageUncertainty,
  type DiffRecoveryRecord,
} from './contracts';
import type { DiffRecoveryRunState } from './coordinator';
import { patchCoveredPaths, type VerifiedRepository } from './coverage';
import type { WriteTarget } from './writeEvidence';

export interface UncertainCoverageGate {
  uncertainty: CoverageUncertainty[];
  proof: ChangeProofSource[];
  /** A verified patch already shows a proven change. */
  verifiedChange: boolean;
  /** Comparable missing paths whose change is proven; one must be shown changed. */
  provenPaths: Set<string>;
}

const isGitLikeKind = (kind: string) => kind.startsWith('git ') || kind === 'patch';

/**
 * Undefined = keep withholding. Never called for complete coverage. `missing`
 * is the strict known allowlist the model will be asked about.
 */
export function uncertainCoverageGate(input: {
  state: DiffRecoveryRunState;
  verified: readonly VerifiedRepository[];
  records: readonly DiffRecoveryRecord[];
  missing: ReadonlyMap<string, WriteTarget>;
  blocking: readonly string[];
}): UncertainCoverageGate | undefined {
  const { state, missing } = input;
  if (!input.blocking.length || !input.blocking.every((b) => COVERAGE_UNCERTAINTIES.has(b)))
    return undefined;
  // An uncertain write whose excerpt was redacted or withheld (sensitive
  // target) is a policy limit: never shown as mere uncertainty.
  if (
    state.writes.some(
      (w) => w.redacted && (w.truncated || w.unresolved || w.kinds.some(isGitLikeKind)),
    )
  )
    return undefined;
  // No known path: nothing the model could validly reconstruct.
  if (!missing.size) return undefined;
  const proof = new Set<ChangeProofSource>();
  const provenPaths = new Set<string>();
  const verifiedChange = input.verified.some(
    (v) =>
      (v.turnVerified || v.source === 'checkpoint') &&
      patchCoveredPaths(v.repository.root, v.repository.patch).size > 0,
  );
  if (verifiedChange) proof.add('verified_patch');
  const order = [...state.issuedToolCalls];
  const laterUnknown = (tool: string, includeSame: boolean) => {
    const at = order.indexOf(tool);
    return (
      at < 0 ||
      state.writes.some((w) => {
        const index = order.indexOf(w.toolCallId);
        return (
          (index < 0 || (includeSame ? index >= at : index > at)) &&
          (w.unresolved || w.kinds.some(isGitLikeKind))
        );
      })
    );
  };
  for (const r of input.records) {
    if (
      r.kind !== 'file' ||
      !r.complete ||
      r.paths.length !== 1 ||
      r.before === r.after ||
      laterUnknown(r.toolCallId, false)
    )
      continue;
    const key = comparablePath(`${r.root}/${r.paths[0]}`);
    if (!missing.has(key)) continue; // covered by a verified patch already
    proof.add('native_record');
    provenPaths.add(key);
  }
  for (const w of state.writes) {
    if (w.status !== 'succeeded' || laterUnknown(w.toolCallId, true)) continue;
    for (const t of w.targets) {
      const key = comparablePath(t.path);
      const merged = missing.get(key);
      if (!t.created || !merged?.created || merged.removed) continue;
      proof.add('exclusive_create');
      provenPaths.add(key);
    }
  }
  if (!proof.size) return undefined;
  return {
    uncertainty: [...new Set(input.blocking)] as CoverageUncertainty[],
    proof: [...proof],
    verifiedChange,
    provenPaths,
  };
}

/** True when the reconstructed files show at least one proven change. */
export function proofShown(
  gate: UncertainCoverageGate,
  files: ReadonlyArray<{ path: string }>,
): boolean {
  return gate.verifiedChange || files.some((f) => gate.provenPaths.has(comparablePath(f.path)));
}

/** Leading, honest limitation line of an uncertain-coverage snapshot. */
export function uncertaintyLimitation(gate: UncertainCoverageGate): string {
  const why = gate.uncertainty.includes('write_target_unknown')
    ? 'some write commands of this turn had targets the backend could not determine'
    : 'some write command evidence of this turn was truncated';
  return `Coverage uncertain: ${why}; changes they made may be missing from this view.`;
}
