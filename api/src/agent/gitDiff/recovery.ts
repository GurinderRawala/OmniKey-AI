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
  type DiffRecoveryRecord,
  type GitDiffRequest,
  type GitDiffShellContext,
  type SessionDiffCaptureOutcome,
  type SessionDiffSummary,
} from './contracts';
import {
  captureSessionDiffOutcome,
  requestGitControl,
  saveSessionDiff,
  type GitRunState,
} from './coordinator';

/** Fixed, literal system prompt of the manifest call. */
export const DIFF_RECOVERY_SYSTEM_PROMPT = [
  'You select change-evidence records for a read-only diff viewer.',
  'You never write patches, file contents, paths, commit ids or commands.',
  'Reply with exactly one JSON object and nothing else, either:',
  `{"evidenceIds":["<id>", ...]} listing 1 to ${DIFF_RECOVERY_MAX_SELECTED} ids, copied exactly from the provided records, of the changes that belong to the user's task;`,
  'or {"unavailable":true} if no record applies.',
  'Prefer selecting every provided record unless it is clearly unrelated to the task.',
].join('\n');

const MAX_INPUT_CHARS = 2_000;
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

/** Fallback only once per run, only with verified records, only without a summary. */
export function shouldAttemptDiffRecovery(
  run: GitRunState | undefined,
  outcome: SessionDiffCaptureOutcome,
): boolean {
  const state = run?.recovery;
  return Boolean(
    state && !state.attempted && outcome.status !== 'captured' && state.records.size > 0,
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

/**
 * Run the fallback once. Returns the saved recovered summary, or undefined.
 * Never throws; never stores or attaches anything after cancel/deadline.
 */
export async function recoverSessionDiff(
  run: GitRunState,
  options: DiffRecoveryOptions,
): Promise<SessionDiffSummary | undefined> {
  const state = run.recovery;
  if (!state || state.attempted || !state.records.size) return undefined;
  state.attempted = true;
  const { log } = options;
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
  try {
    if (budget.signal.aborted) return undefined;
    const all = [...state.records.values()];
    const offered = all.slice(0, DIFF_RECOVERY_MAX_RECORDS);
    options.send?.({
      session_id: run.sessionId,
      sender: 'agent',
      content: 'Recovering changes…',
      is_terminal_output: false,
      is_error: false,
    });

    const result = await untilAborted(
      deps.complete(options.model, buildManifestMessages(run, offered), {
        signal: budget.signal,
        maxTokens: DIFF_RECOVERY_MAX_OUTPUT_TOKENS,
      }),
      budget.signal,
    );
    if (options.onUsage) {
      // Usage accounting is bounded and can never fail the final answer.
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
    if (budget.signal.aborted) return undefined;

    const manifest = parseRecoveryManifest(result.content, new Set(offered.map((r) => r.id)));
    if (!manifest || 'unavailable' in manifest) {
      log.info('Diff recovery manifest produced no selection', {
        sessionId: run.sessionId,
        result: manifest ? 'unavailable' : 'invalid',
      });
      return undefined;
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
      budget.signal,
      Math.min(remaining(), GIT_DIFF_RESPONSE_TIMEOUT_MS),
      (raw) => validateGitRecoveryResponse(raw, request, selected),
    );
    // Late, cancelled or failed: nothing is stored or attached.
    if (budget.signal.aborted || !response || response.status !== 'ok') {
      log.info('Diff recovery returned no snapshot', {
        sessionId: run.sessionId,
        status: budget.signal.aborted ? 'deadline' : (response?.status ?? 'no_reply'),
      });
      return undefined;
    }
    const repositories = response.repositories.filter((r) => r.patch.trim().length > 0);
    if (!repositories.length) return undefined;

    const limitations: string[] = [];
    const unselected = all.length - selected.length;
    if (unselected > 0) {
      limitations.push(
        `${plural(unselected, 'verified change record was', 'verified change records were')} not selected for recovery.`,
      );
    }
    const nativeOmitted = Math.max(state.nativeOmitted ?? 0, response.recovery?.omitted ?? 0);
    if (nativeOmitted > 0) {
      limitations.push(
        `The native checkpoint store omitted ${plural(nativeOmitted, 'record', 'records')}.`,
      );
    }
    if (state.omitted > 0) {
      limitations.push(
        `${plural(state.omitted, 'record exceeded', 'records exceeded')} the per-turn evidence budget.`,
      );
    }
    if (selected.some((r) => !r.complete)) {
      limitations.push('Some selected records were truncated by native limits.');
    }
    const selectedRoots = new Set(selected.map((r) => r.root));
    const missingRoots = selectedRoots.size - repositories.length;
    if (missingRoots > 0) {
      limitations.push(
        `${plural(missingRoots, 'selected root', 'selected roots')} returned no patch.`,
      );
    }
    const bounded = limitations.slice(0, DIFF_RECOVERY_MAX_LIMITATIONS);
    const complete = bounded.length === 0;
    const notice = complete
      ? 'Recovered from native per-command checkpoints recorded during this turn; edits made outside recorded commands are not included.'
      : `Partial recovery from native per-command checkpoints recorded during this turn. ${bounded.join(' ')}`;
    if (budget.signal.aborted) return undefined;
    // Bound persistence too. A DB adapter cannot cancel an in-flight insert,
    // but late completion must never attach a snapshot or delay the answer.
    const summary = await untilAborted(
      saveSessionDiff(run, repositories, notice, undefined, {
        kind: 'agent_assisted',
        turnId: run.runId,
        evidenceIds: [...manifest.evidenceIds],
        complete,
        limitations: bounded,
      }),
      budget.signal,
    );
    if (budget.signal.aborted) return undefined;
    log.info('Saved recovered git snapshot for final answer', {
      sessionId: run.sessionId,
      diffId: summary.id,
      repositoryCount: summary.repositoryCount,
      fileCount: summary.fileCount,
      complete,
      displayLimit: GIT_DIFF_DISPLAY_LIMIT,
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

/**
 * The single final-capture helper used by both the success and the failure
 * final paths: the normal automatic capture first; the agent-assisted
 * fallback only for a capable run with verified records and no snapshot.
 */
export async function captureFinalSessionDiff(
  run: GitRunState | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  options: DiffRecoveryOptions,
): Promise<SessionDiffSummary | undefined> {
  if (!run || options.signal?.aborted || run.connection?.aborted) return undefined;
  try {
    const outcome = await captureSessionDiffOutcome(run, history, options.signal, options.log);
    if (outcome.summary) return outcome.summary;
    // A successful net-empty automatic capture is newer evidence than the
    // last shell checkpoint. Do not resurrect Git edits reverted since it.
    if (outcome.unchangedRoots?.length && run.recovery) {
      const emptyRoots = new Set(outcome.unchangedRoots.map(comparablePath));
      for (const [id, record] of run.recovery.records) {
        if (record.kind === 'git' && emptyRoots.has(comparablePath(record.root)))
          run.recovery.records.delete(id);
      }
    }
    if (!shouldAttemptDiffRecovery(run, outcome)) return undefined;
    if (options.signal?.aborted || run.connection?.aborted) return undefined;
    return await recoverSessionDiff(run, options);
  } catch {
    return undefined;
  }
}
