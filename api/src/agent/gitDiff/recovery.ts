/**
 * Contract v4: agent-assisted diff recovery (`supports_diff_recovery: true`).
 *
 * While a run executes, the native client checkpoints the roots/files each
 * shell demonstrably touched and reports only METADATA (opaque ids, roots,
 * relative paths, OIDs/content hashes) on the terminal reply of that exact
 * shell request. Patches stay on the client.
 *
 * When the normal automatic capture produced no snapshot and this run holds
 * verified records, exactly one restricted model call (no tools, fixed system
 * prompt, current input + record metadata only) chooses WHICH verified ids
 * belong to the task. The model never produces a patch, path, OID or command.
 * One `git_diff_request { phase: "recover" }` then asks the native store to
 * replay its own stored patches for those ids. Everything is bounded by one
 * 20 s budget, the run's abort signal and its connection; any failure means
 * "no snapshot", never a lost or rewritten final answer.
 *
 * Coverage orchestration (see coverage.ts): no snapshot is saved or attached
 * before its KNOWN coverage is checked. A normal capture that is known partial
 * (baseline unavailable, disclosed exclusions, current-turn writes or verified
 * record paths outside its patch, unknown write targets) is not saved; it
 * becomes the verified base of a bounded recovery: at most one manifest call
 * (verified records) and one AI reconstruction call for the still-missing
 * known paths, both under the same 20 s budget. AI files are merged into the
 * verified base (never replacing or duplicating a verified file). If any
 * known path stays uncovered or any blocking uncertainty remains, nothing is
 * attached. Verified native records always take precedence over AI.
 */
import cuid from 'cuid';
import type { Logger } from 'winston';
import {
  aiClient,
  type AICompletionResult,
  type AIMessage,
  type CompletionOptions,
} from '../../ai-client';
import type { AgentSendFn } from '../types';
import {
  DIFF_RECOVERY_MAX_LIMITATIONS,
  DIFF_RECOVERY_MAX_OUTPUT_TOKENS,
  DIFF_RECOVERY_MAX_RECORDS,
  DIFF_RECOVERY_MAX_SELECTED,
  DIFF_RECOVERY_TOTAL_TIMEOUT_MS,
  GIT_DIFF_DISPLAY_LIMIT,
  GIT_DIFF_RESPONSE_TIMEOUT_MS,
  GitDiffValidationError,
  isSafeToolCallId,
  comparablePath,
  validateDiffRecoveryEvidence,
  validateGitRecoveryResponse,
  GIT_DIFF_MAX_PATCH_BYTES,
  GIT_DIFF_MAX_REPOSITORIES,
  type DiffRecoveryRecord,
  type GitDiffRepository,
  type GitDiffRequest,
  type GitDiffShellContext,
  type SessionDiffCandidate,
  type SessionDiffRecoveryProvenance,
  type SessionDiffCaptureOutcome,
  type SessionDiffSummary,
} from './contracts';
import {
  DIFF_RECONSTRUCTION_MAX_FILES,
  DIFF_RECONSTRUCTION_MAX_OUTPUT_TOKENS,
  buildReconstructionMessages,
  parseReconstructionFiles,
  parseReplyObject,
  reconstructionLimitations,
  reconstructionRepositories,
} from './aiReconstruction';
import {
  captureSessionDiffCandidate,
  requestGitControl,
  saveSessionDiff,
  saveSessionDiffCandidate,
  type GitRunState,
} from './coordinator';
import {
  coverageAssessment,
  patchCoveredPaths,
  reasonDisclosesExclusion,
  withoutCoveredSections,
  type VerifiedRepository,
} from './coverage';
import type { WriteTarget } from './writeEvidence';

/** Fixed, literal system prompt of the manifest call. */
export const DIFF_RECOVERY_SYSTEM_PROMPT = [
  'You select change-evidence records for a read-only diff viewer.',
  'You never write patches, file contents, paths, commit ids or commands.',
  'Reply with exactly one JSON object and nothing else, either:',
  `{"evidenceIds":["<id>", ...]} listing 1 to ${DIFF_RECOVERY_MAX_SELECTED} ids, copied exactly from the provided records, of the changes that belong to the user's task;`,
  'or {"unavailable":true} if no record applies.',
  'Prefer selecting every provided record unless it is clearly unrelated to the task.',
  'steeringUpdates, when present, are later instructions from the same user during this task and supersede userInput where they conflict.',
].join('\n');

const MAX_INPUT_CHARS = 2_000;
/** Applied steering of this run: total characters and entries offered to the model. */
const MAX_STEERING_CHARS = 2_000;
const MAX_STEERING_ENTRIES = 8;
const MAX_PROMPT_PATHS_PER_RECORD = 20;
const MAX_ISSUED_TOOL_CALLS = 512;
const USAGE_RECORD_TIMEOUT_MS = 2_000;

type CompleteFn = (
  model: string,
  messages: AIMessage[],
  options: CompletionOptions,
) => Promise<AICompletionResult>;

interface RecoveryDeps {
  complete: CompleteFn;
  totalTimeoutMs: number;
}

const defaultDeps: RecoveryDeps = {
  complete: (model, messages, options) => aiClient.complete(model, messages, options),
  totalTimeoutMs: DIFF_RECOVERY_TOTAL_TIMEOUT_MS,
};
let deps: RecoveryDeps = defaultDeps;

/** Test seam: inject the provider call and/or the total budget. */
export function setDiffRecoveryDepsForTesting(overrides: Partial<RecoveryDeps>): () => void {
  deps = { ...defaultDeps, ...overrides };
  return () => {
    deps = defaultDeps;
  };
}

/** Record this run's own user input (first non-feedback input only). */
export function setDiffRecoveryInput(run: GitRunState | undefined, content: string): void {
  if (!run?.recovery || run.recovery.input !== undefined) return;
  // eslint-disable-next-line no-control-regex
  const clean = content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  run.recovery.input = clean.slice(0, MAX_INPUT_CHARS);
}

/**
 * Record steering text that was actually applied to this outer run (drained
 * into its history). Queued, rejected or other runs' steering never reaches
 * here. Bounded: at most MAX_STEERING_ENTRIES entries / MAX_STEERING_CHARS
 * characters in total; later entries beyond the budget are dropped (the
 * earliest task changes are kept, nothing from prior runs is added).
 */
export function addDiffRecoverySteering(
  run: GitRunState | undefined,
  contents: readonly string[],
): void {
  const state = run?.recovery;
  if (!state) return;
  const steering = (state.steering ??= []);
  let used = steering.reduce((n, s) => n + s.length, 0);
  for (const content of contents) {
    if (steering.length >= MAX_STEERING_ENTRIES || used >= MAX_STEERING_CHARS) return;
    // eslint-disable-next-line no-control-regex
    const clean = content.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
    if (!clean) continue;
    const text = clean.slice(0, MAX_STEERING_CHARS - used);
    steering.push(text);
    used += text.length;
  }
}

/**
 * Correlation fields added to `git_diff_context` of a shell request. Only for
 * capable runs; the tool call id is remembered as issued for this run.
 */
export function shellRecoveryContext(
  run: GitRunState | undefined,
  toolCallId: string,
): Pick<GitDiffShellContext, 'turn_id' | 'tool_call_id'> | undefined {
  const state = run?.recovery;
  if (!run || !state || !isSafeToolCallId(toolCallId)) return undefined;
  if (!state.issuedToolCalls.has(toolCallId)) {
    if (state.issuedToolCalls.size >= MAX_ISSUED_TOOL_CALLS) return undefined;
    state.issuedToolCalls.add(toolCallId);
  }
  return { turn_id: run.runId, tool_call_id: toolCallId };
}

/**
 * Accept `diff_recovery_evidence` from the terminal reply of the outstanding
 * shell (the WebSocket layer already proved session/subscription/connection
 * ownership). Records must name exactly this run and this tool call; matching
 * ids are replaced by the latest metadata. Returns the number accepted.
 */
export function recordDiffRecoveryEvidence(
  run: GitRunState | undefined,
  toolCallId: string,
  raw: unknown,
  log?: Logger,
): number {
  const state = run?.recovery;
  if (!run || !state || raw === undefined || raw === null) return 0;
  if (run.connection?.aborted || !state.issuedToolCalls.has(toolCallId)) return 0;
  const evidence = validateDiffRecoveryEvidence(raw, { turnId: run.runId, toolCallId });
  if (!evidence) {
    log?.warn('Rejected invalid diff recovery evidence', { sessionId: run.sessionId });
    return 0;
  }
  let accepted = 0;
  for (const record of evidence.records) {
    if (state.records.has(record.id)) {
      state.records.set(record.id, record);
      accepted += 1;
    } else if (state.records.size < DIFF_RECOVERY_MAX_RECORDS) {
      state.records.set(record.id, record);
      accepted += 1;
    } else {
      state.omitted += 1;
    }
  }
  state.nativeOmitted = Math.max(state.nativeOmitted ?? 0, evidence.omitted ?? 0);
  return accepted;
}

/**
 * Fallback only once per run, only without a saved summary, and only with
 * verified records or (for AI reconstruction) current-turn write evidence.
 * A known-partial automatic candidate always qualifies (see
 * captureFinalSessionDiff).
 */
export function shouldAttemptDiffRecovery(
  run: GitRunState | undefined,
  outcome: SessionDiffCaptureOutcome,
): boolean {
  const state = run?.recovery;
  return Boolean(
    state &&
    !state.attempted &&
    outcome.status !== 'captured' &&
    (state.records.size > 0 || state.writes.length > 0),
  );
}

/**
 * Strict manifest parser: exactly `{"evidenceIds":[...]}` (1..6 unique ids
 * from the allowlist) or `{"unavailable":true}`. Anything else is invalid.
 */
export function parseRecoveryManifest(
  content: string,
  allowed: ReadonlySet<string>,
): { evidenceIds: string[] } | { unavailable: true } | null {
  let text = (content ?? '').trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith('{') || text.length > 4_096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  const value = parsed as Record<string, unknown>;
  if (keys.length === 1 && keys[0] === 'unavailable') {
    return value.unavailable === true ? { unavailable: true } : null;
  }
  if (keys.length !== 1 || keys[0] !== 'evidenceIds') return null;
  const ids = value.evidenceIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > DIFF_RECOVERY_MAX_SELECTED) {
    return null;
  }
  if (!ids.every((id) => typeof id === 'string' && allowed.has(id))) return null;
  if (new Set(ids).size !== ids.length) return null;
  return { evidenceIds: [...(ids as string[])] };
}

function buildManifestMessages(
  run: GitRunState,
  records: readonly DiffRecoveryRecord[],
): AIMessage[] {
  const payload = {
    userInput: run.recovery?.input ?? '',
    ...(run.recovery?.steering?.length ? { steeringUpdates: [...run.recovery.steering] } : {}),
    maxSelect: DIFF_RECOVERY_MAX_SELECTED,
    records: records.map((r) => ({
      id: r.id,
      toolCallId: r.toolCallId,
      kind: r.kind,
      root: r.root,
      paths: r.paths.slice(0, MAX_PROMPT_PATHS_PER_RECORD),
      pathCount: r.paths.length,
      complete: r.complete,
    })),
  };
  return [
    { role: 'system', content: DIFF_RECOVERY_SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

class RecoveryDeadline extends Error {
  constructor() {
    super('Diff recovery budget exhausted');
    this.name = 'RecoveryDeadline';
  }
}

/** Resolve `work`, or reject as soon as `signal` aborts (never waits longer). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new RecoveryDeadline());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RecoveryDeadline());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface DiffRecoveryOptions {
  model: string;
  signal: AbortSignal | undefined;
  log: Logger;
  onUsage?: (result: AICompletionResult) => Promise<void>;
  send?: AgentSendFn;
}

/** Context of the final-answer capture handed to the recovery phase. */
export interface DiffRecoveryContext {
  /** Validated, unsaved automatic capture (known partial), if any. */
  base?: SessionDiffCandidate;
  /** Roots the automatic capture authoritatively reported net-empty. */
  unchangedRoots?: string[];
}

/** Repositories of an automatic candidate the backend treats as verified. */
function verifiedBase(base: SessionDiffCandidate | undefined): {
  verified: VerifiedRepository[];
  missingBaseline: GitDiffRepository[];
} {
  const verified: VerifiedRepository[] = [];
  const missingBaseline: GitDiffRepository[] = [];
  for (const repository of base?.repositories ?? []) {
    // In turn mode a non-turn entry is "working tree vs HEAD" only: not
    // evidence of what this turn changed, so never a verified base.
    if (base?.turn && repository.scope !== 'turn') missingBaseline.push(repository);
    else
      verified.push({ repository, source: 'automatic', turnVerified: repository.scope === 'turn' });
  }
  return { verified, missingBaseline };
}

/**
 * Coverage of a normal automatic candidate (no model call). Complete means it
 * may be saved and attached exactly as before.
 */
export function assessAutomaticCandidate(
  run: GitRunState,
  candidate: SessionDiffCandidate,
  unchangedRoots: readonly string[],
) {
  const { verified, missingBaseline } = verifiedBase(candidate);
  const blocking: string[] = [];
  if (missingBaseline.length) blocking.push('baseline_unavailable');
  if (reasonDisclosesExclusion(candidate.reason)) blocking.push('native_exclusion');
  return coverageAssessment({
    state: run.recovery,
    verified,
    unchangedRoots,
    records: run.recovery ? [...run.recovery.records.values()] : [],
    blocking,
  });
}

/**
 * Run the bounded recovery once. Returns the saved summary, or undefined.
 * Never throws; never stores or attaches anything after cancel/deadline, and
 * never stores a snapshot whose known coverage is incomplete.
 */
export async function recoverSessionDiff(
  run: GitRunState,
  options: DiffRecoveryOptions,
  context: DiffRecoveryContext = {},
): Promise<SessionDiffSummary | undefined> {
  const state = run.recovery;
  if (!state || state.attempted) return undefined;
  if (!context.base && !state.records.size && !state.writes.length) return undefined;
  state.attempted = true;
  const { log } = options;
  const unchangedRoots = context.unchangedRoots ?? [];
  const startedAt = Date.now();
  const budget = new AbortController();
  const abort = () => budget.abort();
  const signals = [options.signal, run.connection].filter((s): s is AbortSignal => Boolean(s));
  for (const s of signals) {
    if (s.aborted) budget.abort();
    s.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(abort, deps.totalTimeoutMs);
  const remaining = () => Math.max(0, deps.totalTimeoutMs - (Date.now() - startedAt));
  // At most two tool-free provider calls (manifest + reconstruction) share the
  // one budget; usage accounting is bounded and can never fail the answer.
  const callModel = async (messages: AIMessage[], maxTokens: number) => {
    const result = await untilAborted(
      deps.complete(options.model, messages, { signal: budget.signal, maxTokens }),
      budget.signal,
    );
    if (options.onUsage) {
      const usageDeadline = new AbortController();
      const usageTimer = setTimeout(
        () => usageDeadline.abort(),
        Math.min(USAGE_RECORD_TIMEOUT_MS, Math.max(remaining(), 1)),
      );
      await untilAborted(
        Promise.resolve().then(() => options.onUsage!(result)),
        usageDeadline.signal,
      )
        .catch(() =>
          log.warn('Diff recovery usage accounting failed', { sessionId: run.sessionId }),
        )
        .finally(() => clearTimeout(usageTimer));
    }
    return result;
  };
  // Bound persistence too. A DB adapter cannot cancel an in-flight insert,
  // but late completion must never attach a snapshot or delay the answer.
  const save = (
    repositories: GitDiffRepository[],
    notice: string,
    turn: SessionDiffCandidate['turn'],
    provenance: SessionDiffRecoveryProvenance,
  ) => untilAborted(saveSessionDiff(run, repositories, notice, turn, provenance), budget.signal);
  try {
    if (budget.signal.aborted) return undefined;
    options.send?.({
      session_id: run.sessionId,
      sender: 'agent',
      content: 'Recovering changes…',
      is_terminal_output: false,
      is_error: false,
    });
    const { verified, missingBaseline } = verifiedBase(context.base);
    const blocking: string[] = [];
    if (reasonDisclosesExclusion(context.base?.reason)) blocking.push('native_exclusion');
    const records = [...state.records.values()];

    // Phase 1 (verified records not already covered): manifest + native replay.
    let evidenceIds: string[] = [];
    let checkpointLimitations: string[] = [];
    const recordsCoverage = coverageAssessment({
      state: undefined,
      verified,
      unchangedRoots,
      records,
    });
    if (records.length && !recordsCoverage.complete) {
      const replay = await replayCheckpoints(
        run,
        records,
        verified,
        callModel,
        budget.signal,
        remaining,
        log,
      );
      if (budget.signal.aborted) return undefined;
      evidenceIds = replay.evidenceIds;
      checkpointLimitations = replay.limitations;
      verified.push(...replay.repositories);
    }

    // Phase 2: what is still known-missing after the verified evidence?
    const coverage = coverageAssessment({ state, verified, unchangedRoots, records, blocking });
    // A root without a turn baseline is only acceptable when the turn's own
    // evidence explains every file of its uncommitted diff: either a verified
    // checkpoint already covers it (replayed turn-relative) or a known write
    // still requires it (reconstructed turn-relative). Otherwise its content
    // is unattributable. Its working-tree patch itself is never saved.
    const checkpointCovered = new Set<string>();
    for (const v of verified) {
      if (v.source !== 'checkpoint') continue;
      for (const p of patchCoveredPaths(v.repository.root, v.repository.patch)) {
        checkpointCovered.add(p);
      }
    }
    for (const repo of missingBaseline) {
      const paths = patchCoveredPaths(repo.root, repo.patch);
      const sections = repo.patch
        .split(/(?=^diff --git )/m)
        .filter((s) => s.startsWith('diff --git '));
      if (
        !sections.length ||
        sections.some((s) => !patchCoveredPaths(repo.root, s).size) ||
        ![...paths].every((p) => coverage.missing.has(p) || checkpointCovered.has(p))
      ) {
        coverage.blocking.push('baseline_unavailable');
        break;
      }
    }
    const checkpointUsed = verified.some((v) => v.source === 'checkpoint');
    if (!coverage.missing.size && !coverage.blocking.length) {
      if (!verified.length) {
        logResult(log, run, 'nothing_to_show');
        return undefined;
      }
      if (!checkpointUsed) {
        // Only reachable with an automatic base that became complete because
        // a baseline-less root was dropped without known changes in it.
        return await untilAborted(
          saveSessionDiffCandidate(
            run,
            {
              ...context.base!,
              notice: undefined,
              reason: undefined,
              repositories: verified.map((v) => v.repository),
            },
            log,
          ),
          budget.signal,
        );
      }
      const summary = await save(
        verified.map((v) => v.repository),
        'Recovered from native per-command checkpoints recorded during this turn; edits made outside recognised commands are not included.',
        context.base?.turn,
        {
          kind: 'agent_assisted',
          turnId: run.runId,
          evidenceIds,
          complete: true,
          limitations: checkpointLimitations,
        },
      );
      if (budget.signal.aborted) return undefined;
      logResult(log, run, 'saved_checkpoint', { diffId: summary.id, fileCount: summary.fileCount });
      return summary;
    }

    // Phase 3: known partial => always one AI attempt for the missing paths.
    if (coverage.missing.size > DIFF_RECONSTRUCTION_MAX_FILES) {
      coverage.blocking.push('too_many_missing_paths');
    }
    const allow = new Map<string, WriteTarget>(
      [...coverage.missing].slice(0, DIFF_RECONSTRUCTION_MAX_FILES),
    );
    const result = await callModel(
      buildReconstructionMessages(state, allow),
      DIFF_RECONSTRUCTION_MAX_OUTPUT_TOKENS,
    );
    if (budget.signal.aborted) return undefined;
    if (coverage.blocking.length) {
      logResult(log, run, 'withheld_uncertain', {
        blocking: coverage.blocking,
        missing: coverage.missing.size,
      });
      return undefined;
    }
    const reply = parseReplyObject(result?.content ?? '');
    const parsed =
      reply && 'files' in reply
        ? parseReconstructionFiles(reply, allow, { requireAll: true })
        : null;
    if (!parsed) {
      const unavailable = reply?.unavailable === true && Object.keys(reply).length === 1;
      logResult(log, run, unavailable ? 'unavailable' : 'invalid_or_incomplete', {
        missing: allow.size,
      });
      return undefined;
    }
    if (parsed.limitations.length) {
      // The model disclosed something it could not reconstruct.
      logResult(log, run, 'model_reported_gaps', { missing: allow.size });
      return undefined;
    }
    const cwds = [...new Set(state.writes.map((w) => w.cwd).filter((c): c is string => !!c))];
    const built = reconstructionRepositories(
      parsed.files,
      cwds,
      verified.map((v) => v.repository.root),
    );
    if (built.dropped || built.redactedDropped) {
      logResult(log, run, 'dropped', { dropped: built.dropped, redacted: built.redactedDropped });
      return undefined;
    }
    const merged = [...verified.map((v) => v.repository), ...built.repositories];
    const distinctRoots = new Set(merged.map((r) => comparablePath(r.root))).size;
    const totalBytes = merged.reduce((n, r) => n + Buffer.byteLength(r.patch, 'utf8'), 0);
    if (
      !merged.some((r) => r.patch.trim()) ||
      distinctRoots > GIT_DIFF_MAX_REPOSITORIES ||
      totalBytes > GIT_DIFF_MAX_PATCH_BYTES * 2
    ) {
      logResult(log, run, 'nothing_renderable');
      return undefined;
    }
    const baseKind = checkpointUsed ? 'checkpoint' : verified.length ? 'automatic' : undefined;
    const limitations = reconstructionLimitations(state, parsed.files, {
      base: baseKind,
      unchanged: allow.size - parsed.files.length,
      checkpointLimitations,
    });
    if (budget.signal.aborted) return undefined;
    const summary = await save(
      merged,
      'AI-reconstructed turn changes; known coverage complete but unverified.',
      verified.some((v) => v.repository.scope === 'turn') ? context.base?.turn : undefined,
      {
        kind: 'ai_reconstructed',
        turnId: run.runId,
        evidenceIds,
        toolCallIds: state.writes.map((w) => w.toolCallId),
        complete: true,
        limitations,
        ...(baseKind ? { base: baseKind } : {}),
      },
    );
    if (budget.signal.aborted) return undefined;
    logResult(log, run, 'saved_ai', {
      diffId: summary.id,
      fileCount: summary.fileCount,
      reconstructed: parsed.files.length,
      base: baseKind ?? 'none',
    });
    return summary;
  } catch (err) {
    log.warn('Diff recovery failed; delivering final answer without it', {
      sessionId: run.sessionId,
      error:
        err instanceof RecoveryDeadline || err instanceof GitDiffValidationError
          ? err.name
          : err instanceof Error
            ? err.name
            : 'error',
    });
    return undefined;
  } finally {
    clearTimeout(timer);
    for (const s of signals) s.removeEventListener('abort', abort);
  }
}

function logResult(
  log: Logger,
  run: GitRunState,
  result: string,
  extra: Record<string, unknown> = {},
): void {
  log.info('Diff recovery finished', {
    sessionId: run.sessionId,
    result,
    writeCommands: run.recovery?.writes.length ?? 0,
    records: run.recovery?.records.size ?? 0,
    displayLimit: GIT_DIFF_DISPLAY_LIMIT,
    ...extra,
  });
}

/**
 * Manifest call over the verified records, then one native `recover` replay.
 * Returns the verified checkpoint repositories (file sections already covered
 * by the automatic base removed) and honest limitation lines. Unselected or
 * unreplayed record paths simply stay uncovered for the coverage check.
 */
async function replayCheckpoints(
  run: GitRunState,
  all: DiffRecoveryRecord[],
  verified: readonly VerifiedRepository[],
  callModel: (messages: AIMessage[], maxTokens: number) => Promise<AICompletionResult>,
  signal: AbortSignal,
  remaining: () => number,
  log: Logger,
): Promise<{ repositories: VerifiedRepository[]; evidenceIds: string[]; limitations: string[] }> {
  const state = run.recovery!;
  const none = { repositories: [], evidenceIds: [], limitations: [] };
  const offered = all.slice(0, DIFF_RECOVERY_MAX_RECORDS);
  const result = await callModel(
    buildManifestMessages(run, offered),
    DIFF_RECOVERY_MAX_OUTPUT_TOKENS,
  );
  if (signal.aborted) return none;
  const manifest = parseRecoveryManifest(result?.content ?? '', new Set(offered.map((r) => r.id)));
  if (!manifest || 'unavailable' in manifest) {
    log.info('Diff recovery manifest produced no selection', {
      sessionId: run.sessionId,
      result: manifest ? 'unavailable' : 'invalid',
    });
    return none;
  }
  const selected = manifest.evidenceIds.map((id) => state.records.get(id)!);
  const request: GitDiffRequest = {
    request_id: cuid(),
    candidate_paths: [],
    eligible_commits: [],
    phase: 'recover',
    recovery: { turn_id: run.runId, evidence_ids: [...manifest.evidenceIds] },
  };
  const response = await requestGitControl(
    run,
    request,
    signal,
    Math.min(remaining(), GIT_DIFF_RESPONSE_TIMEOUT_MS),
    (raw) => validateGitRecoveryResponse(raw, request, selected),
  );
  if (signal.aborted || !response || response.status !== 'ok') {
    log.info('Diff recovery returned no snapshot', {
      sessionId: run.sessionId,
      status: signal.aborted ? 'deadline' : (response?.status ?? 'no_reply'),
    });
    return none;
  }
  // Records the native replay could not reproduce (e.g. a file no longer
  // matches its checkpoint hash). Distinct from store omissions reported with
  // shell evidence (`nativeOmitted`); both still block an incomplete card.
  const replayOmitted = response.recovery?.omitted ?? 0;
  if (replayOmitted > 0) state.replayOmitted = Math.max(state.replayOmitted ?? 0, replayOmitted);
  const covered = new Set<string>();
  for (const v of verified) {
    for (const p of patchCoveredPaths(v.repository.root, v.repository.patch)) covered.add(p);
  }
  const repositories: VerifiedRepository[] = [];
  for (const repo of response.repositories) {
    const patch = withoutCoveredSections(repo.root, repo.patch, covered);
    if (!patch.trim()) continue;
    repositories.push({
      repository: { ...repo, patch },
      source: 'checkpoint',
      turnVerified: false,
      evidenceIds: manifest.evidenceIds,
    });
  }
  const limitations: string[] = [];
  const unselected = all.length - selected.length;
  if (unselected > 0) {
    // Their paths stay required: coverage proves them by other evidence or withholds.
    limitations.push(
      `${plural(unselected, 'verified change record was', 'verified change records were')} not replayed; ${unselected === 1 ? 'its files are' : 'their files are'} shown from other evidence.`,
    );
  }
  return {
    repositories,
    evidenceIds: [...manifest.evidenceIds],
    limitations: limitations.slice(0, DIFF_RECOVERY_MAX_LIMITATIONS),
  };
}

/**
 * The single final-capture helper used by both the success and the failure
 * final paths. The normal automatic capture is persisted only when its known
 * coverage is complete (no extra model call); otherwise the bounded recovery
 * runs with it as the verified base. Undefined = no button, final unchanged.
 */
export async function captureFinalSessionDiff(
  run: GitRunState | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  options: DiffRecoveryOptions,
): Promise<SessionDiffSummary | undefined> {
  if (!run || options.signal?.aborted || run.connection?.aborted) return undefined;
  try {
    const outcome = await captureSessionDiffCandidate(run, history, options.signal, options.log);
    const unchangedRoots = outcome.unchangedRoots ?? [];
    // A successful net-empty automatic capture is newer evidence than the
    // last shell checkpoint. Do not resurrect Git edits reverted since it.
    if (unchangedRoots.length && run.recovery) {
      const emptyRoots = new Set(unchangedRoots.map(comparablePath));
      for (const [id, record] of run.recovery.records) {
        if (record.kind === 'git' && emptyRoots.has(comparablePath(record.root)))
          run.recovery.records.delete(id);
      }
      // Never let AI reconstruction revive writes inside those roots either.
      run.recovery.revertedRoots.push(...unchangedRoots);
    }
    const candidate = outcome.candidate;
    if (candidate) {
      const assessment = assessAutomaticCandidate(run, candidate, unchangedRoots);
      if (assessment.complete) return await saveSessionDiffCandidate(run, candidate, options.log);
      options.log.info('Automatic git snapshot is known partial; not attached as is', {
        sessionId: run.sessionId,
        missing: assessment.missing.size,
        blocking: assessment.blocking,
      });
      // Without the v4 capability there is no evidence to complete it with.
      if (!run.recovery || run.recovery.attempted) return undefined;
    } else if (!shouldAttemptDiffRecovery(run, outcome)) {
      return undefined;
    }
    if (options.signal?.aborted || run.connection?.aborted) return undefined;
    return await recoverSessionDiff(run, options, { base: candidate, unchangedRoots });
  } catch {
    return undefined;
  }
}
