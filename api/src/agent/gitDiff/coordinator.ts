import { AgentSession } from '../../models/agentSession';
/**
 * Bounded Git snapshot capture coordinator.
 *
 * Before a final answer is persisted and delivered, the backend sends one
 * `git_diff_request` control frame on the run's own authenticated WebSocket
 * and waits (<= GIT_DIFF_RESPONSE_TIMEOUT_MS) for the matching
 * `git_diff_response`. The request and reply are never model, tool or
 * transcript messages. A reply settles only the outstanding request whose id,
 * session, subscription AND connection all match; anything else is ignored.
 * Timeout, abort and disconnect settle promptly with "no snapshot" so a final
 * answer is never lost or delayed beyond the bound.
 */
import cuid from 'cuid';
import { Op } from 'sequelize';
import type { Logger } from 'winston';
import { compressString, decompressString } from '../../compression';
import { AgentSessionDiff, AgentSessionGitRun } from '../../models/agentSessionDiff';
import type { AgentMessage, AgentSendFn } from '../types';
import { CandidateSet, projectContextDirectory } from './candidates';
import type { ShellWriteEvidence } from './writeEvidence';
import {
  comparablePath,
  countPatchFiles,
  GIT_DIFF_DISPLAY_LIMIT,
  GIT_DIFF_MAX_CANDIDATES,
  GIT_DIFF_MAX_REPOSITORIES,
  GIT_DIFF_RESPONSE_TIMEOUT_MS,
  GIT_MAX_REASON_LENGTH,
  GIT_TURN_BASELINE_TIMEOUT_MS,
  GIT_MAX_COMMIT_OBSERVATIONS,
  GitDiffValidationError,
  isGitOid,
  isSafeAbsolutePath,
  validateGitBaselineResponse,
  validateGitDiffResponse,
  validateGitTurnFinalResponse,
  type EligibleCommit,
  type GitCommitObservation,
  type GitDiffRepository,
  type GitDiffRequest,
  type GitDiffResponse,
  type GitTurnBaseline,
  type GitTurnBaselineSource,
  type DiffRecoveryRecord,
  type SessionDiffCaptureOutcome,
  type SessionDiffPayload,
  type SessionDiffRecoveryProvenance,
  type SessionDiffSummary,
  type SessionDiffSummaryScope,
} from './contracts';

/** Runtime-only per-run state; never persisted as session state or sent to a model. */
export interface GitRunState {
  runId: string;
  sessionId: string;
  subscriptionId: string;
  /** The connection that started (and receives frames for) this run. */
  connection?: AbortSignal;
  send: AgentSendFn;
  candidates: CandidateSet;
  observations: GitCommitObservation[];
  /**
   * Contract v3 (`supports_git_turn_diff: true`): one immutable set of HEAD
   * baselines per outer run, reused by every recursion/steering continuation
   * and never reset or rebased within the run.
   */
  turnDiff: boolean;
  startedAt: number;
  turnStartRequested: boolean;
  /** At most one baseline per canonical root (first verified wins). */
  baselines: GitTurnBaseline[];
  /** Candidate paths a baseline was already requested for (never retried). */
  baselineAttempted: Set<string>;
  /** Count of baseline requests that failed (timeout/invalid/unavailable). */
  baselineFailures: number;
  /**
   * Contract v4 (`supports_diff_recovery: true`): run-local verified change
   * metadata. Absent for clients without the capability. Never persisted.
   */
  recovery?: DiffRecoveryRunState;
}

/** Runtime-only v4 recovery evidence of one outer run (turn_id = runId). */
export interface DiffRecoveryRunState {
  /** Latest verified metadata per opaque native id, in first-seen order. */
  records: Map<string, DiffRecoveryRecord>;
  /** Provider tool call ids issued to the client with this run's turn id. */
  issuedToolCalls: Set<string>;
  /** New records dropped because the per-run backend budget was full. */
  omitted: number;
  /** Largest `omitted` count the native store reported for this run. */
  nativeOmitted?: number;
  /** Fallback runs at most once per outer run. */
  attempted: boolean;
  /** Trimmed text of this run's own user input (never prior history). */
  input?: string;
  /** Write-like shells of this run, recorded only after the client replied. */
  writes: ShellWriteEvidence[];
  priorNonShellTool?: boolean;
  /** Write-like shells dropped because the per-run evidence budget was full. */
  writesOmitted?: number;
  /** Roots the normal capture authoritatively reported net-empty. */
  revertedRoots: string[];
}

export function createGitRunState(input: {
  sessionId: string;
  subscriptionId: string;
  connection?: AbortSignal;
  send: AgentSendFn;
  turnDiff?: boolean;
  diffRecovery?: boolean;
}): GitRunState {
  return {
    runId: `grun_${cuid()}`,
    sessionId: input.sessionId,
    subscriptionId: input.subscriptionId,
    connection: input.connection,
    send: input.send,
    candidates: new CandidateSet(),
    observations: [],
    turnDiff: input.turnDiff === true,
    startedAt: Date.now(),
    turnStartRequested: false,
    baselines: [],
    baselineAttempted: new Set(),
    baselineFailures: 0,
    ...(input.diffRecovery === true
      ? {
          recovery: {
            records: new Map(),
            issuedToolCalls: new Set(),
            omitted: 0,
            attempted: false,
            writes: [],
            revertedRoots: [],
          },
        }
      : {}),
  };
}

/** Record accepted HEAD transitions; the latest transition per root wins. */
export function recordCommitObservations(
  run: GitRunState,
  observations: readonly GitCommitObservation[],
): void {
  for (const observation of observations) {
    const key = comparablePath(observation.root);
    const index = run.observations.findIndex((o) => comparablePath(o.root) === key);
    if (index >= 0) run.observations.splice(index, 1);
    run.observations.push(observation);
    if (run.observations.length > GIT_MAX_COMMIT_OBSERVATIONS) run.observations.shift();
  }
}

type PendingCapture = {
  sessionId: string;
  subscriptionId: string;
  connection?: AbortSignal;
  request: GitDiffRequest;
  validate: (raw: unknown) => GitDiffResponse;
  settle: (response: GitDiffResponse | null) => void;
};

const pendingCaptures = new Map<string, PendingCapture>();

export function pendingGitDiffCaptureCount(): number {
  return pendingCaptures.size;
}

/**
 * Route a `git_diff_response` frame. Returns true when the frame was a Git
 * reply (consumed, never a turn input), whether or not it matched.
 */
export function handleGitDiffResponseFrame(
  message: AgentMessage,
  subscriptionId: string,
  connection: AbortSignal,
  log: Logger,
): boolean {
  if (message.git_diff_response === undefined) return false;
  const raw = message.git_diff_response as { request_id?: unknown } | null;
  const requestId = raw && typeof raw === 'object' ? raw.request_id : undefined;
  const pending = typeof requestId === 'string' ? pendingCaptures.get(requestId) : undefined;
  if (
    !pending ||
    pending.sessionId !== message.session_id ||
    pending.subscriptionId !== subscriptionId ||
    (pending.connection !== undefined && pending.connection !== connection)
  ) {
    log.warn('Ignored unexpected or stale git diff reply', { sessionId: message.session_id });
    return true;
  }
  try {
    pending.settle(pending.validate(raw));
  } catch (err) {
    log.warn('Rejected invalid git diff reply', {
      sessionId: message.session_id,
      reason: err instanceof GitDiffValidationError ? err.message : 'invalid',
    });
    pending.settle(null);
  }
  return true;
}

function awaitCapture(
  run: GitRunState,
  request: GitDiffRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  validate: (raw: unknown) => GitDiffResponse = (raw) => validateGitDiffResponse(raw, request),
  maxTimeoutMs = GIT_DIFF_RESPONSE_TIMEOUT_MS,
): Promise<GitDiffResponse | null> {
  return new Promise((resolve) => {
    const timing: { timer?: ReturnType<typeof setTimeout> } = {};
    const signals = [signal, run.connection].filter((s): s is AbortSignal => Boolean(s));
    const settle = (response: GitDiffResponse | null) => {
      if (pendingCaptures.get(request.request_id)?.settle !== settle) return;
      pendingCaptures.delete(request.request_id);
      if (timing.timer) clearTimeout(timing.timer);
      for (const s of signals) s.removeEventListener('abort', onAbort);
      resolve(response);
    };
    const onAbort = () => settle(null);
    pendingCaptures.set(request.request_id, {
      sessionId: run.sessionId,
      subscriptionId: run.subscriptionId,
      connection: run.connection,
      request,
      validate,
      settle,
    });
    if (signals.some((s) => s.aborted)) {
      settle(null);
      return;
    }
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
    timing.timer = setTimeout(() => settle(null), Math.min(timeoutMs, maxTimeoutMs));
    run.send({
      session_id: run.sessionId,
      sender: 'agent',
      content: '',
      git_diff_request: request,
    });
  });
}

/**
 * Send one validated control request on the run's own connection and await
 * its bounded reply (null on timeout/abort/disconnect/invalid). Never throws.
 */
export function requestGitControl(
  run: GitRunState,
  request: GitDiffRequest,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  validate: (raw: unknown) => GitDiffResponse,
): Promise<GitDiffResponse | null> {
  return awaitCapture(run, request, signal, timeoutMs, validate);
}

function parseCommits(json: string | null | undefined): GitCommitObservation[] {
  try {
    const parsed = JSON.parse(json || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (o): o is GitCommitObservation =>
          !!o &&
          typeof o === 'object' &&
          isSafeAbsolutePath((o as GitCommitObservation).root) &&
          isGitOid((o as GitCommitObservation).after),
      )
      .slice(0, GIT_MAX_COMMIT_OBSERVATIONS);
  } catch {
    return [];
  }
}

function parseCandidates(json: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(json || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is string => isSafeAbsolutePath(p))
      .slice(0, GIT_DIFF_MAX_CANDIDATES);
  } catch {
    return [];
  }
}

/** Observed commits and candidates of the immediately previous saved run. */
export async function previousRunProvenance(
  run: GitRunState,
): Promise<{ commits: GitCommitObservation[]; candidates: string[] }> {
  if (allProvenanceUncertain || uncertainProvenance.has(provenanceKey(run)))
    return { commits: [], candidates: [] };
  const row = await AgentSessionGitRun.findOne({
    where: {
      sessionId: run.sessionId,
      subscriptionId: run.subscriptionId,
      id: { [Op.ne]: run.runId },
    },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    attributes: ['commitsJson', 'candidatesJson'],
  });
  return {
    commits: parseCommits(row?.commitsJson),
    candidates: parseCandidates(row?.candidatesJson),
  };
}

const MAX_SAVED_RUNS_PER_SESSION = 10;

/** Persist this run's observed provenance (also when empty). Idempotent per run. */
const uncertainProvenance = new Set<string>();
let allProvenanceUncertain = false;
const provenanceKey = (run: GitRunState) => `${run.subscriptionId}:${run.sessionId}`;

export async function persistGitRunProvenance(
  run: GitRunState,
  log: Logger,
  timeoutMs = 2000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    await Promise.race([
      writeGitRunProvenance(run, () => expired),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new Error('ProvenanceDeadline'));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (uncertainProvenance.size < 1024) uncertainProvenance.add(provenanceKey(run));
    else allProvenanceUncertain = true;
    log.warn('Failed to persist git run provenance', {
      sessionId: run.sessionId,
      error: err instanceof Error ? err.name : 'error',
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeGitRunProvenance(run: GitRunState, expired: () => boolean): Promise<void> {
  // An ownership-refused/deleted session must not leave provenance rows.
  const owner = await AgentSession.findOne({
    where: { id: run.sessionId, subscriptionId: run.subscriptionId },
    attributes: ['id'],
  });
  if (!owner || expired()) return;
  const commitsJson = JSON.stringify(run.observations.slice(-GIT_MAX_COMMIT_OBSERVATIONS));
  const candidatesJson = JSON.stringify(run.candidates.list(GIT_DIFF_MAX_CANDIDATES));
  const existing = await AgentSessionGitRun.findOne({
    where: { id: run.runId, sessionId: run.sessionId, subscriptionId: run.subscriptionId },
    attributes: ['id'],
  });
  if (expired()) return;
  if (existing) {
    await AgentSessionGitRun.update(
      { commitsJson, candidatesJson },
      { where: { id: run.runId, subscriptionId: run.subscriptionId } },
    );
  } else {
    await AgentSessionGitRun.create({
      id: run.runId,
      sessionId: run.sessionId,
      subscriptionId: run.subscriptionId,
      commitsJson,
      candidatesJson,
    });
    if (expired()) return;
    const stale = await AgentSessionGitRun.findAll({
      where: { sessionId: run.sessionId, subscriptionId: run.subscriptionId },
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
      offset: MAX_SAVED_RUNS_PER_SESSION,
      attributes: ['id'],
    });
    if (!expired() && stale.length) {
      await AgentSessionGitRun.destroy({
        where: { id: stale.map((r) => r.id), subscriptionId: run.subscriptionId },
      });
    }
  }
}

function summaryScope(repositories: GitDiffRepository[]): SessionDiffSummaryScope {
  const scopes = new Set(repositories.map((r) => r.scope));
  return scopes.size === 1 ? repositories[0].scope : 'mixed';
}

/** Create the immutable snapshot row and return its summary. */
export async function saveSessionDiff(
  run: GitRunState,
  repositories: GitDiffRepository[],
  notice: string | undefined,
  turn?: { baselines: GitTurnBaseline[]; displayLimit: number },
  recovery?: SessionDiffRecoveryProvenance,
): Promise<SessionDiffSummary> {
  const payload: SessionDiffPayload = {
    version: 1,
    repositories,
    ...(notice ? { notice } : {}),
    ...(turn ? { baselines: turn.baselines, displayLimit: turn.displayLimit } : {}),
    ...(recovery ? { displayLimit: GIT_DIFF_DISPLAY_LIMIT, recovery } : {}),
  };
  const scope = summaryScope(repositories);
  const commit =
    scope === 'commit' && repositories.length === 1 ? repositories[0].commit : undefined;
  const fileCount = repositories.reduce((sum, r) => sum + countPatchFiles(r.patch), 0);
  const row = await AgentSessionDiff.create({
    id: `sdiff_${cuid()}`,
    sessionId: run.sessionId,
    subscriptionId: run.subscriptionId,
    runId: run.runId,
    scope,
    commitOid: commit ?? null,
    fileCount,
    repositoryCount: repositories.length,
    payload: compressString(JSON.stringify(payload)),
  });
  return {
    id: row.id,
    fileCount,
    repositoryCount: repositories.length,
    createdAt: (row.createdAt ?? new Date()).toISOString(),
    scope,
    ...(commit ? { commit } : {}),
    ...(turn
      ? {
          displayLimit: turn.displayLimit,
          baselineSource: repositories.some((r) => r.baselineSource === 'before_tool')
            ? ('before_tool' as const)
            : ('turn_start' as const),
          baselineUnavailable: repositories.some((r) => r.scope !== 'turn'),
        }
      : {}),
    ...(recovery
      ? {
          displayLimit: GIT_DIFF_DISPLAY_LIMIT,
          recovered: true,
          recoveryIncomplete: !recovery.complete,
          recoveryMethod:
            recovery.kind === 'ai_reconstructed'
              ? ('ai_reconstructed' as const)
              : ('checkpoint' as const),
        }
      : {}),
  };
}

/** Owner-scoped read of a stored payload. Null when absent or not owned. */
export async function loadSessionDiffPayload(
  sessionId: string,
  subscriptionId: string,
  diffId: string,
): Promise<{ row: AgentSessionDiff; payload: SessionDiffPayload } | null> {
  const row = await AgentSessionDiff.findOne({
    where: { id: diffId, sessionId, subscriptionId },
  });
  if (!row) return null;
  const json = decompressString(row.payload);
  if (!json) return null;
  try {
    const payload = JSON.parse(json) as SessionDiffPayload;
    if (payload?.version !== 1 || !Array.isArray(payload.repositories)) return null;
    return { row, payload };
  } catch {
    return null;
  }
}

function latestProjectDirectory(history: ReadonlyArray<{ role: string; content: unknown }>) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    const directory = projectContextDirectory(message.content);
    if (directory) return directory;
  }
  return null;
}

export function eligibleCommitsFor(
  current: readonly GitCommitObservation[],
  previous: readonly GitCommitObservation[],
): EligibleCommit[] {
  const seen = new Set<string>();
  const result: EligibleCommit[] = [];
  for (const observation of [...current].reverse().concat([...previous].reverse())) {
    const key = `${comparablePath(observation.root)}\0${observation.after}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ root: observation.root, commit: observation.after });
    if (result.length >= GIT_MAX_COMMIT_OBSERVATIONS) break;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Contract v3: per-turn baselines.
// ---------------------------------------------------------------------------

const MAX_BASELINE_ATTEMPTS = GIT_DIFF_MAX_CANDIDATES * 8;

/** Record verified baselines once per canonical root; never overwrite. */
export function recordTurnBaselines(
  run: GitRunState,
  baselines: readonly GitTurnBaseline[],
): number {
  let added = 0;
  for (const baseline of baselines) {
    const key = comparablePath(baseline.root);
    if (run.baselines.some((existing) => comparablePath(existing.root) === key)) continue;
    if (run.baselines.length >= GIT_DIFF_MAX_REPOSITORIES) break;
    run.baselines.push({ ...baseline });
    added += 1;
  }
  return added;
}

function hasBaselineFor(run: GitRunState, path: string): boolean {
  const key = comparablePath(path);
  return run.baselines.some((b) => comparablePath(b.root) === key);
}

/**
 * Request HEAD baselines for candidate paths not yet attempted in this run and
 * await the bounded reply. Each path is attempted at most once, so a repeated
 * shell in the same directory never rebases, and a failed attempt is never
 * retried later (it would no longer be a baseline). Never throws.
 */
export async function captureTurnBaselines(
  run: GitRunState | undefined,
  paths: readonly string[],
  source: GitTurnBaselineSource,
  signal: AbortSignal | undefined,
  log: Logger,
  timeoutMs = GIT_TURN_BASELINE_TIMEOUT_MS,
): Promise<void> {
  if (!run?.turnDiff) return;
  const fresh: string[] = [];
  for (const path of paths) {
    const key = comparablePath(path);
    if (run.baselineAttempted.has(key) || hasBaselineFor(run, path)) continue;
    if (fresh.some((p) => comparablePath(p) === key)) continue;
    if (run.baselineAttempted.size >= MAX_BASELINE_ATTEMPTS) break;
    fresh.push(path);
    if (fresh.length >= GIT_DIFF_MAX_CANDIDATES) break;
  }
  if (!fresh.length) return;
  for (const path of fresh) run.baselineAttempted.add(comparablePath(path));
  if (signal?.aborted || run.connection?.aborted) {
    run.baselineFailures += 1;
    return;
  }
  const request: GitDiffRequest = {
    request_id: cuid(),
    candidate_paths: fresh,
    eligible_commits: [],
    phase: 'baseline',
    baseline_source: source,
    baselines: [],
  };
  try {
    const response = await awaitCapture(
      run,
      request,
      signal,
      timeoutMs,
      (raw) =>
        validateGitBaselineResponse(
          raw,
          request,
          { notBefore: run.startedAt, now: Date.now() },
          run.baselines,
        ),
      GIT_TURN_BASELINE_TIMEOUT_MS,
    );
    if (!response || response.status === 'unavailable') {
      run.baselineFailures += 1;
      log.info('Git turn baseline unavailable', {
        sessionId: run.sessionId,
        source,
        status: response?.status ?? 'no_reply',
      });
      return;
    }
    const added = recordTurnBaselines(run, response.baselines ?? []);
    log.info('Recorded git turn baselines', {
      sessionId: run.sessionId,
      source,
      added,
      total: run.baselines.length,
    });
  } catch (err) {
    run.baselineFailures += 1;
    log.warn('Git turn baseline failed', {
      sessionId: run.sessionId,
      error: err instanceof Error ? err.name : 'error',
    });
  }
}

/**
 * Once per outer run, after the session ownership check and before the first
 * model request or tool: baseline the project context, the paths the user
 * typed, and the immediately previous run's candidates.
 */
export async function captureTurnStartBaselines(
  run: GitRunState | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  signal: AbortSignal | undefined,
  log: Logger,
  timeoutMs = GIT_TURN_BASELINE_TIMEOUT_MS,
): Promise<void> {
  if (!run?.turnDiff || run.turnStartRequested) return;
  run.turnStartRequested = true;
  try {
    run.candidates.add(latestProjectDirectory(history), 'project');
    const previous = await previousRunProvenance(run).catch(() => ({
      commits: [] as GitCommitObservation[],
      candidates: [] as string[],
    }));
    run.candidates.addAll(previous.candidates, 'previous_run');
  } catch {
    // Evidence is best-effort; the request below uses whatever is known.
  }
  await captureTurnBaselines(
    run,
    run.candidates.list(GIT_DIFF_MAX_CANDIDATES),
    'turn_start',
    signal,
    log,
    timeoutMs,
  );
}

function turnNotice(
  repositories: readonly GitDiffRepository[],
  reason: string | undefined,
): string | undefined {
  const parts: string[] = [];
  const missing = repositories.filter((r) => r.scope === 'working_tree');
  if (missing.length) {
    parts.push(
      `Turn baseline unavailable for ${missing.map((r) => r.root).join(', ')}; showing only current uncommitted changes there (no commit history is inferred).`,
    );
  }
  if (reason) parts.push(reason);
  const notice = parts.join(' ').slice(0, GIT_MAX_REASON_LENGTH * 3);
  return notice || undefined;
}

function noSnapshotStatus(
  status: GitDiffResponse['status'] | undefined,
): SessionDiffCaptureOutcome['status'] {
  if (status === 'not_repository') return 'no_repository';
  if (status === 'unavailable') return 'workspace_unavailable';
  return 'capture_failed';
}

async function captureTurnSnapshot(
  run: GitRunState,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  signal: AbortSignal | undefined,
  log: Logger,
  timeoutMs: number,
): Promise<SessionDiffCaptureOutcome> {
  run.candidates.add(latestProjectDirectory(history), 'project');
  const previous = await previousRunProvenance(run).catch(() => ({
    commits: [] as GitCommitObservation[],
    candidates: [] as string[],
  }));
  run.candidates.addAll(previous.candidates, 'previous_run');
  const ordered: string[] = [];
  for (const path of [...run.baselines.map((b) => b.root), ...run.candidates.list()]) {
    if (!ordered.some((p) => comparablePath(p) === comparablePath(path))) ordered.push(path);
  }
  const candidatePaths = ordered.slice(0, GIT_DIFF_MAX_CANDIDATES);
  if (!candidatePaths.length) return { status: 'no_repository', reason: 'no candidates' };
  const baselines = run.baselines.map((b) => ({ ...b }));
  const request: GitDiffRequest = {
    request_id: cuid(),
    candidate_paths: candidatePaths,
    // Never a latest-commit fallback in turn mode.
    eligible_commits: [],
    phase: 'final',
    baselines,
    display_limit: GIT_DIFF_DISPLAY_LIMIT,
  };
  const response = await awaitCapture(run, request, signal, timeoutMs, (raw) =>
    validateGitTurnFinalResponse(raw, request),
  );
  if (!response || response.status !== 'ok') {
    log.info('No git turn snapshot for final answer', {
      sessionId: run.sessionId,
      status: response?.status ?? 'no_reply',
    });
    return { status: noSnapshotStatus(response?.status), reason: response?.status ?? 'no_reply' };
  }
  const repositories = response.repositories.filter((r) => r.patch.trim().length > 0);
  if (!repositories.length) {
    return {
      status: !baselines.length && run.baselineFailures > 0 ? 'missing_baseline' : 'no_changes',
      unchangedRoots: [
        ...new Set([...baselines.map((b) => b.root), ...response.repositories.map((r) => r.root)]),
      ],
    };
  }
  const summary = await saveSessionDiff(
    run,
    repositories,
    turnNotice(repositories, response.reason),
    {
      baselines,
      displayLimit: GIT_DIFF_DISPLAY_LIMIT,
    },
  );
  log.info('Saved git turn snapshot for final answer', {
    sessionId: run.sessionId,
    diffId: summary.id,
    repositoryCount: summary.repositoryCount,
    fileCount: summary.fileCount,
    scope: summary.scope,
    baselineCount: baselines.length,
  });
  return { status: 'captured', summary };
}

/**
 * Structured outcome of the normal (automatic) capture for the final answer
 * about to be delivered. Never throws; provenance is persisted either way.
 */
export async function captureSessionDiffOutcome(
  run: GitRunState | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  signal: AbortSignal | undefined,
  log: Logger,
  timeoutMs = GIT_DIFF_RESPONSE_TIMEOUT_MS,
): Promise<SessionDiffCaptureOutcome> {
  if (!run) return { status: 'workspace_unavailable', reason: 'no capability' };
  if (signal?.aborted || run.connection?.aborted) {
    return { status: 'workspace_unavailable', reason: 'cancelled' };
  }
  try {
    if (run.turnDiff) return await captureTurnSnapshot(run, history, signal, log, timeoutMs);
    run.candidates.add(latestProjectDirectory(history), 'project');
    const previous = await previousRunProvenance(run).catch(() => ({
      commits: [] as GitCommitObservation[],
      candidates: [] as string[],
    }));
    run.candidates.addAll(previous.candidates, 'previous_run');
    const eligible = eligibleCommitsFor(run.observations, previous.commits);
    for (const commit of previous.commits) run.candidates.add(commit.root, 'previous_run');
    for (const commit of run.observations) run.candidates.add(commit.root, 'command');
    const candidatePaths = run.candidates.list(GIT_DIFF_MAX_CANDIDATES);
    if (!candidatePaths.length) return { status: 'no_repository', reason: 'no candidates' };

    const request: GitDiffRequest = {
      request_id: cuid(),
      candidate_paths: candidatePaths,
      eligible_commits: eligible,
    };
    const response = await awaitCapture(run, request, signal, timeoutMs);
    if (!response || response.status !== 'ok') {
      log.info('No git snapshot for final answer', {
        sessionId: run.sessionId,
        status: response?.status ?? 'no_reply',
      });
      return { status: noSnapshotStatus(response?.status), reason: response?.status ?? 'no_reply' };
    }
    const repositories = response.repositories.filter((r) => r.patch.trim().length > 0);
    if (!repositories.length) return { status: 'no_changes' };
    const summary = await saveSessionDiff(run, repositories, response.reason);
    log.info('Saved git snapshot for final answer', {
      sessionId: run.sessionId,
      diffId: summary.id,
      repositoryCount: summary.repositoryCount,
      fileCount: summary.fileCount,
      scope: summary.scope,
    });
    return { status: 'captured', summary };
  } catch (err) {
    log.warn('Git snapshot capture failed; delivering final answer without it', {
      sessionId: run.sessionId,
      error: err instanceof Error ? err.name : 'error',
    });
    return { status: 'capture_failed', reason: err instanceof Error ? err.name : 'error' };
  } finally {
    await persistGitRunProvenance(run, log);
  }
}

/**
 * Legacy API: capture, validate and persist the snapshot for the final answer
 * about to be delivered. Returns the summary to attach, or undefined (no button).
 */
export async function captureSessionDiffBeforeFinal(
  run: GitRunState | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  signal: AbortSignal | undefined,
  log: Logger,
  timeoutMs = GIT_DIFF_RESPONSE_TIMEOUT_MS,
): Promise<SessionDiffSummary | undefined> {
  if (!run || signal?.aborted || run.connection?.aborted) return undefined;
  return (await captureSessionDiffOutcome(run, history, signal, log, timeoutMs)).summary;
}
