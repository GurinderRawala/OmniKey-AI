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
import {
  comparablePath,
  countPatchFiles,
  GIT_DIFF_MAX_CANDIDATES,
  GIT_DIFF_RESPONSE_TIMEOUT_MS,
  GIT_MAX_COMMIT_OBSERVATIONS,
  GitDiffValidationError,
  isGitOid,
  isSafeAbsolutePath,
  validateGitDiffResponse,
  type EligibleCommit,
  type GitCommitObservation,
  type GitDiffRepository,
  type GitDiffRequest,
  type GitDiffResponse,
  type SessionDiffPayload,
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
}

export function createGitRunState(input: {
  sessionId: string;
  subscriptionId: string;
  connection?: AbortSignal;
  send: AgentSendFn;
}): GitRunState {
  return {
    runId: `grun_${cuid()}`,
    sessionId: input.sessionId,
    subscriptionId: input.subscriptionId,
    connection: input.connection,
    send: input.send,
    candidates: new CandidateSet(),
    observations: [],
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
    pending.settle(validateGitDiffResponse(raw, pending.request));
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
      settle,
    });
    if (signals.some((s) => s.aborted)) {
      settle(null);
      return;
    }
    for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
    timing.timer = setTimeout(
      () => settle(null),
      Math.min(timeoutMs, GIT_DIFF_RESPONSE_TIMEOUT_MS),
    );
    run.send({
      session_id: run.sessionId,
      sender: 'agent',
      content: '',
      git_diff_request: request,
    });
  });
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
): Promise<SessionDiffSummary> {
  const payload: SessionDiffPayload = {
    version: 1,
    repositories,
    ...(notice ? { notice } : {}),
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

/**
 * Capture, validate and persist the snapshot for the final answer about to be
 * delivered. Returns the summary to attach, or undefined (no button).
 */
export async function captureSessionDiffBeforeFinal(
  run: GitRunState | undefined,
  history: ReadonlyArray<{ role: string; content: unknown }>,
  signal: AbortSignal | undefined,
  log: Logger,
  timeoutMs = GIT_DIFF_RESPONSE_TIMEOUT_MS,
): Promise<SessionDiffSummary | undefined> {
  if (!run || signal?.aborted || run.connection?.aborted) return undefined;
  try {
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
    if (!candidatePaths.length) return undefined;

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
      return undefined;
    }
    const repositories = response.repositories.filter((r) => r.patch.trim().length > 0);
    if (!repositories.length) return undefined;
    const summary = await saveSessionDiff(run, repositories, response.reason);
    log.info('Saved git snapshot for final answer', {
      sessionId: run.sessionId,
      diffId: summary.id,
      repositoryCount: summary.repositoryCount,
      fileCount: summary.fileCount,
      scope: summary.scope,
    });
    return summary;
  } catch (err) {
    log.warn('Git snapshot capture failed; delivering final answer without it', {
      sessionId: run.sessionId,
      error: err instanceof Error ? err.name : 'error',
    });
    return undefined;
  } finally {
    await persistGitRunProvenance(run, log);
  }
}
