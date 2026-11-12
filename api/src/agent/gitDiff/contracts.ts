/**
 * Wire contract and limits for Git session diffs (contract v2).
 *
 * Everything here is pure: validation of untrusted native replies happens
 * before any value reaches storage, the model context, logs or rendering.
 * Patch text is data only. It is never logged, never added to provider
 * history, and never interpreted beyond Pierre's escaped renderer.
 */

export const GIT_DIFF_MAX_CANDIDATES = 8;
export const GIT_DIFF_MAX_REPOSITORIES = 8;
export const GIT_DIFF_MAX_PATCH_BYTES = 2 * 1024 * 1024; // combined UTF-8
export const GIT_DIFF_MAX_UNTRACKED_FILES = 300;
export const GIT_DIFF_NATIVE_TIMEOUT_MS = 10_000;
/** Backend wait for the native reply: native budget plus transport slack. */
export const GIT_DIFF_RESPONSE_TIMEOUT_MS = 12_000;
export const GIT_MAX_COMMIT_OBSERVATIONS = 8;
export const GIT_MAX_PATH_LENGTH = 1024;
export const GIT_MAX_REASON_LENGTH = 500;
export const GIT_MAX_REQUEST_ID_LENGTH = 64;

/** Viewer cap: rendered file panels across all repositories of one snapshot. */
export const GIT_DIFF_DISPLAY_LIMIT = 300;
/** Backend wait for a baseline (HEAD-only) reply; it delays the model/shell. */
export const GIT_TURN_BASELINE_TIMEOUT_MS = 6_000;
/** Accepted clock skew for client baseline timestamps. */
export const GIT_TURN_BASELINE_CLOCK_SKEW_MS = 5 * 60_000;
const GIT_MAX_TIMESTAMP_LENGTH = 40;

export type SessionDiffScope = 'working_tree' | 'commit' | 'turn';
export type SessionDiffSummaryScope = SessionDiffScope | 'mixed';
export type GitTurnBaselineSource = 'turn_start' | 'before_tool';
export type GitDiffPhase = 'baseline' | 'final' | 'recover';

// ---------------------------------------------------------------------------
// Contract v4: diff recovery (`supports_diff_recovery: true`).
// ---------------------------------------------------------------------------

/** Records accepted per shell reply and retained per outer run. */
export const DIFF_RECOVERY_MAX_RECORDS = 32;
export const DIFF_RECOVERY_MAX_PATHS = 300;
/** Records one recovery control request may select (first version). */
export const DIFF_RECOVERY_MAX_SELECTED = 6;
/** Whole fallback budget: AI manifest call + native recover request. */
export const DIFF_RECOVERY_TOTAL_TIMEOUT_MS = 20_000;
export const DIFF_RECOVERY_MAX_OUTPUT_TOKENS = 1_000;
export const DIFF_RECOVERY_MAX_LIMITATIONS = 8;
const DIFF_RECOVERY_MAX_ID_LENGTH = 64;
const DIFF_RECOVERY_MAX_TOOL_CALL_ID_LENGTH = 256;
const DIFF_RECOVERY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type DiffRecoveryKind = 'git' | 'file';

/** One native-verified change record (metadata only; no patch or content). */
export interface DiffRecoveryRecord {
  id: string;
  toolCallId: string;
  root: string;
  paths: string[];
  kind: DiffRecoveryKind;
  before: string | null;
  after: string | null;
  complete: boolean;
}

/** Optional on the terminal reply of an outstanding shell_script. */
export interface DiffRecoveryEvidence {
  turn_id: string;
  records: DiffRecoveryRecord[];
  omitted?: number;
}

/** Server -> client `git_diff_request.recovery` (phase "recover"). */
export interface GitDiffRecoveryControl {
  turn_id: string;
  evidence_ids: string[];
}

/** Client -> server `git_diff_response.recovery` echo. */
export interface GitDiffRecoveryReply {
  turn_id: string;
  evidence_ids: string[];
  omitted: number;
}

/**
 * Provenance stored on a recovered snapshot payload. `agent_assisted` replays
 * verified native checkpoints; `ai_reconstructed` contains at least one file
 * reconstructed by the model from this turn's write-like shell scripts
 * (always unverified), optionally merged with a verified base.
 *
 * `complete` is KNOWN COVERAGE only: every change the backend knew about for
 * this turn is represented. It never means the content was verified, and it
 * never claims that changes made by unrecognised scripts are included. New
 * snapshots are only ever saved with `complete: true`; `false` exists solely
 * on older stored payloads (which the viewer route now refuses to serve).
 */
export interface SessionDiffRecoveryProvenance {
  kind: 'agent_assisted' | 'ai_reconstructed';
  turnId: string;
  evidenceIds: string[];
  complete: boolean;
  limitations: string[];
  /** ai_reconstructed only: the write-like tool calls offered as evidence. */
  toolCallIds?: string[];
  /** ai_reconstructed only: the verified evidence the AI files were merged into. */
  base?: 'automatic' | 'checkpoint';
}

export type SessionDiffRecoveryMethod = 'checkpoint' | 'ai_reconstructed';

/** Outcome of the normal (automatic) capture before a final answer. */
export type SessionDiffCaptureStatus =
  | 'captured'
  | 'no_changes'
  | 'no_repository'
  | 'missing_baseline'
  | 'workspace_unavailable'
  | 'capture_failed';

/** A validated automatic capture that has NOT been persisted yet. */
export interface SessionDiffCandidate {
  repositories: GitDiffRepository[];
  notice?: string;
  /** Native disclosure text (e.g. sensitive exclusion counts). */
  reason?: string;
  /** Present for v3 turn captures. */
  turn?: { baselines: GitTurnBaseline[]; displayLimit: number };
}

export interface SessionDiffCaptureOutcome {
  status: SessionDiffCaptureStatus;
  summary?: SessionDiffSummary;
  /** Deferred capture only: the unsaved snapshot behind status "captured". */
  candidate?: SessionDiffCandidate;
  /** Roots authoritatively checked and reported net-empty by normal capture. */
  unchangedRoots?: string[];
  reason?: string;
}

/**
 * HEAD of one canonical repository root, recorded once per outer run (contract
 * v3). `head: null` means the root was unborn when the baseline was taken.
 * The timestamp is the collector's capture time, not the user's click time.
 */
export interface GitTurnBaseline {
  root: string;
  head: string | null;
  capturedAt: string;
  source: GitTurnBaselineSource;
}

/** Snapshot summary stored on history metadata and sent with the live final. */
export interface SessionDiffSummary {
  id: string;
  fileCount: number;
  repositoryCount: number;
  createdAt: string;
  scope: SessionDiffSummaryScope;
  /** Present only for a single-repository commit snapshot. */
  commit?: string;
  /** Turn snapshots (v3): viewer file-panel cap. */
  displayLimit?: number;
  baselineSource?: GitTurnBaselineSource;
  baselineUnavailable?: boolean;
  /** v4: snapshot was reconstructed by agent-assisted recovery. */
  recovered?: boolean;
  /** v4: the recovered snapshot is known to be partial. */
  recoveryIncomplete?: boolean;
  /** v4: how a recovered snapshot was produced. */
  recoveryMethod?: SessionDiffRecoveryMethod;
}

export interface EligibleCommit {
  root: string;
  commit: string;
}

/** Server -> client control frame, sent before the final answer. */
export interface GitDiffRequest {
  request_id: string;
  candidate_paths: string[];
  eligible_commits: EligibleCommit[];
  /** v3 only. Absent = legacy capture. */
  phase?: GitDiffPhase;
  /** v3 baseline phase: the source the collector must echo on every baseline. */
  baseline_source?: GitTurnBaselineSource;
  /** v3 final phase: baselines recorded for this run. */
  baselines?: GitTurnBaseline[];
  /** v3 final phase: viewer file-panel cap (the patch itself stays complete). */
  display_limit?: number;
  /** v4 recover phase: the run-scoped evidence the native store must replay. */
  recovery?: GitDiffRecoveryControl;
}

export interface GitDiffRepository {
  root: string;
  patch: string;
  scope: SessionDiffScope;
  commit?: string;
  /** scope "turn" only: the recorded baseline and the endpoint HEAD. */
  baselineHead?: string | null;
  head?: string | null;
  baselineCapturedAt?: string;
  baselineSource?: GitTurnBaselineSource;
  /** Stored payloads only: files of this entry were reconstructed by the AI (unverified). */
  reconstructed?: true;
}

export type GitDiffResponseStatus = 'ok' | 'not_repository' | 'unavailable';

/** Client -> server reply to a GitDiffRequest. */
export interface GitDiffResponse {
  request_id: string;
  status: GitDiffResponseStatus;
  repositories: GitDiffRepository[];
  reason?: string;
  /** v3 baseline phase only. */
  baselines?: GitTurnBaseline[];
  /** v4 recover phase only. */
  recovery?: GitDiffRecoveryReply;
}

/** Optional on a shell_script request (server -> client). */
export interface GitDiffShellContext {
  candidate_paths: string[];
  /** v4 (`supports_diff_recovery`): the outer run id evidence must echo. */
  turn_id?: string;
  /** v4: the provider tool call id of this shell request. */
  tool_call_id?: string;
}

/** Optional on the terminal reply of an outstanding shell_script. */
export interface GitCommitObservation {
  root: string;
  before: string | null;
  after: string;
}

/** Stored, compressed snapshot payload (AgentSessionDiff.payload). */
export interface SessionDiffPayload {
  version: 1;
  repositories: GitDiffRepository[];
  notice?: string;
  /** v3 turn snapshots: every baseline recorded for the run, and the cap. */
  baselines?: GitTurnBaseline[];
  displayLimit?: number;
  /** v4: present only on an agent-assisted recovered snapshot. */
  recovery?: SessionDiffRecoveryProvenance;
}

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// eslint-disable-next-line no-control-regex
const REASON_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

export function isGitOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

/**
 * Absolute POSIX path with no control characters, no relative segments and a
 * bounded length. Never resolves against the server filesystem.
 */
export function isSafeAbsolutePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!value.startsWith('/') || value.length > GIT_MAX_PATH_LENGTH || value === '/') return false;
  if (CONTROL_RE.test(value)) return false;
  const segments = value.split('/');
  return !segments.some((segment) => segment === '.' || segment === '..');
}

/** Collapse duplicate and trailing slashes without touching the filesystem. */
export function normalizeAbsolutePath(value: string): string {
  const collapsed = value.replace(/\/+/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/$/, '') : collapsed;
}

/** macOS exposes /tmp, /var and /etc through /private; compare both forms. */
export function comparablePath(value: string): string {
  return normalizeAbsolutePath(value).replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, '');
}

export function pathIsWithin(child: string, parent: string): boolean {
  const c = comparablePath(child);
  const p = comparablePath(parent);
  return c === p || c.startsWith(`${p}/`);
}

export class GitDiffValidationError extends Error {
  constructor(reason: string) {
    super(`Invalid git diff reply: ${reason}`);
    this.name = 'GitDiffValidationError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a native reply against the request it answers. `ok` must be a
 * complete bounded capture; only repositories whose commit scope matches an
 * issued eligibility are accepted. Throws GitDiffValidationError otherwise.
 */
export function validateGitDiffResponse(
  raw: unknown,
  request: Pick<GitDiffRequest, 'request_id' | 'eligible_commits'> &
    Partial<Pick<GitDiffRequest, 'candidate_paths'>>,
): GitDiffResponse {
  if (!isPlainObject(raw)) throw new GitDiffValidationError('not an object');
  if (raw.request_id !== request.request_id) throw new GitDiffValidationError('request id');
  const status = raw.status;
  if (status !== 'ok' && status !== 'not_repository' && status !== 'unavailable') {
    throw new GitDiffValidationError('status');
  }
  let reason: string | undefined;
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') throw new GitDiffValidationError('reason');
    reason = raw.reason.replace(REASON_CONTROL_RE, '').slice(0, GIT_MAX_REASON_LENGTH);
  }
  const rawRepositories = raw.repositories ?? [];
  if (!Array.isArray(rawRepositories)) throw new GitDiffValidationError('repositories');
  if (status !== 'ok') {
    // A failed or limited capture never carries a partial patch.
    if (rawRepositories.length > 0) throw new GitDiffValidationError('patch on failure');
    return { request_id: request.request_id, status, repositories: [], reason };
  }
  if (rawRepositories.length > GIT_DIFF_MAX_REPOSITORIES) {
    throw new GitDiffValidationError('too many repositories');
  }
  const eligible = new Map<string, string>();
  for (const item of request.eligible_commits) {
    eligible.set(`${comparablePath(item.root)}\0${item.commit}`, item.commit);
  }
  const seenRoots = new Set<string>();
  let totalBytes = 0;
  const repositories: GitDiffRepository[] = [];
  for (const entry of rawRepositories) {
    if (!isPlainObject(entry)) throw new GitDiffValidationError('repository');
    const { root, patch } = entry;
    if (!isSafeAbsolutePath(root)) throw new GitDiffValidationError('root');
    if (
      request.candidate_paths &&
      !request.candidate_paths.some(
        (candidate) => pathIsWithin(candidate, root) || pathIsWithin(root, candidate),
      )
    ) {
      throw new GitDiffValidationError('root not related to requested candidates');
    }
    if (typeof patch !== 'string') throw new GitDiffValidationError('patch');
    const key = comparablePath(root);
    if (seenRoots.has(key)) throw new GitDiffValidationError('duplicate root');
    seenRoots.add(key);
    totalBytes += Buffer.byteLength(patch, 'utf8');
    if (totalBytes > GIT_DIFF_MAX_PATCH_BYTES) throw new GitDiffValidationError('patch too large');
    const scope = entry.scope ?? 'working_tree';
    if (scope === 'working_tree') {
      if (entry.commit !== undefined) throw new GitDiffValidationError('commit on working tree');
      repositories.push({ root: normalizeAbsolutePath(root), patch, scope });
    } else if (scope === 'commit') {
      if (!isGitOid(entry.commit)) throw new GitDiffValidationError('commit oid');
      if (!eligible.has(`${key}\0${entry.commit}`)) {
        throw new GitDiffValidationError('commit not eligible');
      }
      repositories.push({ root: normalizeAbsolutePath(root), patch, scope, commit: entry.commit });
    } else {
      throw new GitDiffValidationError('scope');
    }
  }
  return { request_id: request.request_id, status, repositories, reason };
}

function isBaselineSource(value: unknown): value is GitTurnBaselineSource {
  return value === 'turn_start' || value === 'before_tool';
}

function relatedToAny(root: string, candidates: readonly string[]): boolean {
  return candidates.some(
    (candidate) => pathIsWithin(candidate, root) || pathIsWithin(root, candidate),
  );
}

/**
 * Normalize a bounded collector timestamp. It must parse, and lie between the
 * run start and now (with clock-skew slack). Returns the ISO form or null.
 */
export function normalizeBaselineTimestamp(
  value: unknown,
  bounds: { notBefore: number; now: number },
): string | null {
  if (typeof value !== 'string' || value.length > GIT_MAX_TIMESTAMP_LENGTH) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (ms < bounds.notBefore - GIT_TURN_BASELINE_CLOCK_SKEW_MS) return null;
  if (ms > bounds.now + GIT_TURN_BASELINE_CLOCK_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * Validate a v3 `phase: "baseline"` reply. `ok` carries no patch and at most
 * 8 baselines, each for a safe root related to the requested candidates,
 * with a valid OID or null (unborn), a bounded timestamp and exactly the
 * requested source. Anything else throws (the whole reply is rejected, so a
 * partial/forged set never becomes a baseline).
 */
export function validateGitBaselineResponse(
  raw: unknown,
  request: Pick<GitDiffRequest, 'request_id' | 'candidate_paths' | 'baseline_source'>,
  bounds: { notBefore: number; now: number },
  recorded: readonly GitTurnBaseline[] = [],
): GitDiffResponse {
  if (!isPlainObject(raw)) throw new GitDiffValidationError('not an object');
  if (raw.request_id !== request.request_id) throw new GitDiffValidationError('request id');
  const status = raw.status;
  if (status !== 'ok' && status !== 'not_repository' && status !== 'unavailable') {
    throw new GitDiffValidationError('status');
  }
  const rawRepositories = raw.repositories ?? [];
  if (!Array.isArray(rawRepositories) || rawRepositories.length > 0) {
    throw new GitDiffValidationError('baseline carries repositories');
  }
  const rawBaselines = raw.baselines ?? [];
  if (!Array.isArray(rawBaselines)) throw new GitDiffValidationError('baselines');
  if (status !== 'ok') {
    if (rawBaselines.length > 0) throw new GitDiffValidationError('baselines on failure');
    return { request_id: request.request_id, status, repositories: [], baselines: [] };
  }
  if (rawBaselines.length > GIT_DIFF_MAX_REPOSITORIES) {
    throw new GitDiffValidationError('too many baselines');
  }
  const seen = new Set<string>();
  const baselines: GitTurnBaseline[] = [];
  for (const entry of rawBaselines) {
    if (!isPlainObject(entry)) throw new GitDiffValidationError('baseline');
    const { root, head, capturedAt, source } = entry;
    if (!isSafeAbsolutePath(root)) throw new GitDiffValidationError('baseline root');
    const existing = recorded.find(
      (b) =>
        comparablePath(b.root) === comparablePath(root) &&
        b.head === head &&
        b.source === source &&
        Date.parse(b.capturedAt) === Date.parse(String(capturedAt)),
    );
    if (!existing && !relatedToAny(root, request.candidate_paths)) {
      throw new GitDiffValidationError('baseline root not related to requested candidates');
    }
    if (head !== null && !isGitOid(head)) throw new GitDiffValidationError('baseline head');
    if (!isBaselineSource(source) || (!existing && source !== request.baseline_source)) {
      throw new GitDiffValidationError('baseline source');
    }
    const timestamp = normalizeBaselineTimestamp(capturedAt, bounds);
    if (!timestamp) throw new GitDiffValidationError('baseline timestamp');
    const key = comparablePath(root);
    if (seen.has(key)) throw new GitDiffValidationError('duplicate baseline root');
    seen.add(key);
    baselines.push({ root: normalizeAbsolutePath(root), head, capturedAt: timestamp, source });
  }
  return { request_id: request.request_id, status, repositories: [], baselines };
}

/**
 * Validate a v3 `phase: "final"` reply. A root with a recorded baseline may
 * only be reported as scope "turn" echoing exactly that baseline; a root
 * without one may only be "working_tree" (current uncommitted changes).
 * Commit scope is never accepted (no latest-commit fallback in this mode).
 */
export function validateGitTurnFinalResponse(
  raw: unknown,
  request: Pick<GitDiffRequest, 'request_id' | 'candidate_paths' | 'baselines'>,
): GitDiffResponse {
  const recorded = new Map<string, GitTurnBaseline>();
  for (const baseline of request.baselines ?? []) {
    recorded.set(comparablePath(baseline.root), baseline);
  }
  const candidatePaths = [
    ...request.candidate_paths,
    ...(request.baselines ?? []).map((b) => b.root),
  ];
  if (!isPlainObject(raw)) throw new GitDiffValidationError('not an object');
  const rawRepositories = raw.repositories;
  const stripped: unknown[] = [];
  const turnEntries = new Map<number, Record<string, unknown>>();
  if (Array.isArray(rawRepositories)) {
    rawRepositories.forEach((entry, index) => {
      if (isPlainObject(entry) && entry.scope === 'turn') {
        turnEntries.set(index, entry);
        // Validated as a bounded working-tree entry first (root, size,
        // duplicates, no commit), then re-typed against its baseline.
        stripped.push({
          root: entry.root,
          patch: entry.patch,
          scope: 'working_tree',
          ...(entry.commit !== undefined ? { commit: entry.commit } : {}),
        });
      } else {
        stripped.push(entry);
      }
    });
  }
  const base = validateGitDiffResponse(
    { ...raw, repositories: Array.isArray(rawRepositories) ? stripped : rawRepositories },
    { request_id: request.request_id, eligible_commits: [], candidate_paths: candidatePaths },
  );
  if (base.status !== 'ok') return base;
  const repositories = base.repositories.map((repository, index) => {
    const baseline = recorded.get(comparablePath(repository.root));
    const entry = turnEntries.get(index);
    if (!entry) {
      if (baseline) throw new GitDiffValidationError('baselined root without turn scope');
      return repository;
    }
    if (!baseline) throw new GitDiffValidationError('turn scope without recorded baseline');
    const { baselineHead, head, baselineCapturedAt, baselineSource } = entry;
    if (
      baselineHead !== baseline.head ||
      baselineSource !== baseline.source ||
      typeof baselineCapturedAt !== 'string' ||
      Date.parse(baselineCapturedAt) !== Date.parse(baseline.capturedAt)
    ) {
      throw new GitDiffValidationError('turn baseline mismatch');
    }
    if (head !== null && !isGitOid(head)) throw new GitDiffValidationError('turn head');
    // An unborn endpoint is only possible from an unborn baseline.
    if (head === null && baseline.head !== null) throw new GitDiffValidationError('turn head');
    return {
      root: repository.root,
      patch: repository.patch,
      scope: 'turn' as const,
      baselineHead: baseline.head,
      head,
      baselineCapturedAt: baseline.capturedAt,
      baselineSource: baseline.source,
    };
  });
  return { ...base, repositories };
}

/** Literal, conservative detection of a direct `git commit` invocation. */
export function scriptInvokesGitCommit(script: string): boolean {
  // `git [-C <path>]... [-c k=v]... commit` at a command position. Scripted
  // or indirect commits (aliases, functions, eval, sub-scripts) never match.
  if (script.length > 128 * 1024) return false;
  const commandStart = String.raw`(?:^|[;&|(\n]|&&|\|\||\bthen\b|\bdo\b)\s*`;
  const globalOpt = String.raw`(?:\s+(?:-C\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;&|"']+)|-c\s+[^\s;&|"']+|--no-pager))*`;
  const re = new RegExp(`${commandStart}git${globalOpt}\\s+commit(?=\\s|$|;|&|\\|)`, 'm');
  return re.test(script);
}

/**
 * Validate optional `git_commit_observations` on a terminal reply. Only
 * HEAD transitions for roots inside the candidate paths issued with that
 * shell request, from a script that literally invokes `git commit`, survive.
 */
export function validateCommitObservations(
  raw: unknown,
  issuedCandidates: readonly string[],
  script: string,
): GitCommitObservation[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > GIT_MAX_COMMIT_OBSERVATIONS) return [];
  if (!issuedCandidates.length || !scriptInvokesGitCommit(script)) return [];
  const result: GitCommitObservation[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isPlainObject(entry)) return [];
    const { root, before, after } = entry;
    if (!isSafeAbsolutePath(root) || !isGitOid(after)) return [];
    if (before !== null && !isGitOid(before)) return [];
    if (before === after) continue;
    const related = issuedCandidates.some(
      (candidate) => pathIsWithin(candidate, root) || pathIsWithin(root, candidate),
    );
    if (!related) continue;
    const key = comparablePath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ root: normalizeAbsolutePath(root), before: before ?? null, after });
  }
  return result;
}

export function isSessionDiffSummary(value: unknown): value is SessionDiffSummary {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === 'string' &&
    /^sdiff_[A-Za-z0-9]{8,64}$/.test(value.id) &&
    Number.isInteger(value.fileCount) &&
    (value.fileCount as number) >= 0 &&
    Number.isInteger(value.repositoryCount) &&
    (value.repositoryCount as number) >= 0 &&
    typeof value.createdAt === 'string' &&
    (value.scope === 'working_tree' ||
      value.scope === 'commit' ||
      value.scope === 'turn' ||
      value.scope === 'mixed') &&
    (value.commit === undefined || isGitOid(value.commit)) &&
    (value.displayLimit === undefined ||
      (Number.isInteger(value.displayLimit) &&
        (value.displayLimit as number) > 0 &&
        (value.displayLimit as number) <= 1000))
  );
}

/** Copy only the contract fields so arbitrary metadata never propagates. */
export function cleanSessionDiffSummary(value: unknown): SessionDiffSummary | undefined {
  if (!isSessionDiffSummary(value)) return undefined;
  return {
    id: value.id,
    fileCount: value.fileCount,
    repositoryCount: value.repositoryCount,
    createdAt: value.createdAt,
    scope: value.scope,
    ...(value.commit ? { commit: value.commit } : {}),
    ...(value.displayLimit !== undefined ? { displayLimit: value.displayLimit } : {}),
    ...(isBaselineSource(value.baselineSource) ? { baselineSource: value.baselineSource } : {}),
    ...(typeof value.baselineUnavailable === 'boolean'
      ? { baselineUnavailable: value.baselineUnavailable }
      : {}),
    ...(value.recovered === true ? { recovered: true } : {}),
    ...(value.recovered === true && typeof value.recoveryIncomplete === 'boolean'
      ? { recoveryIncomplete: value.recoveryIncomplete }
      : {}),
    ...(value.recovered === true &&
    (value.recoveryMethod === 'checkpoint' || value.recoveryMethod === 'ai_reconstructed')
      ? { recoveryMethod: value.recoveryMethod }
      : {}),
  };
}

/**
 * A summary the backend knows is partial: an incomplete recovery, or a turn
 * snapshot in which some root had no baseline (uncommitted changes only).
 * Such summaries are never attached or re-served.
 */
export function isKnownPartialSummary(summary: SessionDiffSummary | undefined): boolean {
  return summary?.recoveryIncomplete === true || summary?.baselineUnavailable === true;
}

/**
 * Stored payload counterpart of `isKnownPartialSummary`. Legacy working-tree
 * payloads (no baselines, no recovery provenance) carry no such claim.
 */
export function isKnownPartialPayload(payload: SessionDiffPayload): boolean {
  // Recovered payloads are judged by their own coverage verdict (their
  // checkpoint/AI entries are working-tree scoped by design).
  if (payload.recovery) return payload.recovery.complete !== true;
  if (Array.isArray(payload.baselines)) return payload.repositories.some((r) => r.scope !== 'turn');
  return false;
}

// ---------------------------------------------------------------------------
// Contract v4 validators.
// ---------------------------------------------------------------------------

export function isDiffRecoveryId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= DIFF_RECOVERY_MAX_ID_LENGTH &&
    DIFF_RECOVERY_ID_RE.test(value)
  );
}

/** Provider tool call ids are opaque; bound them and forbid control chars. */
export function isSafeToolCallId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= DIFF_RECOVERY_MAX_TOOL_CALL_ID_LENGTH &&
    !CONTROL_RE.test(value)
  );
}

/** Repository-relative path: no leading slash, no relative segments. */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > GIT_MAX_PATH_LENGTH) {
    return false;
  }
  if (value.startsWith('/') || CONTROL_RE.test(value) || value.includes('\\')) return false;
  return !value.split('/').some((s) => s === '' || s === '.' || s === '..');
}

function isRecordStateHash(kind: DiffRecoveryKind, value: unknown): boolean {
  if (value === null) return true;
  return kind === 'git' ? isGitOid(value) : typeof value === 'string' && SHA256_RE.test(value);
}

/**
 * Validate optional `diff_recovery_evidence` on the terminal reply of the
 * outstanding shell. Fail closed: any malformed record, a foreign turn id, a
 * record not attributed to exactly the issued tool call, or an over-budget
 * list rejects the whole reply (returns null). Never carries patch/content.
 */
export function validateDiffRecoveryEvidence(
  raw: unknown,
  expected: { turnId: string; toolCallId: string },
): DiffRecoveryEvidence | null {
  if (raw === undefined || raw === null || !isPlainObject(raw)) return null;
  if (raw.turn_id !== expected.turnId) return null;
  const rawRecords = raw.records;
  if (!Array.isArray(rawRecords) || rawRecords.length > DIFF_RECOVERY_MAX_RECORDS) return null;
  let omitted = 0;
  if (raw.omitted !== undefined) {
    if (!Number.isInteger(raw.omitted) || (raw.omitted as number) < 0) return null;
    omitted = Math.min(raw.omitted as number, 10_000);
  }
  const seen = new Set<string>();
  const records: DiffRecoveryRecord[] = [];
  for (const entry of rawRecords) {
    if (!isPlainObject(entry)) return null;
    const { id, toolCallId, root, paths, kind, before, after, complete } = entry;
    if (!isDiffRecoveryId(id) || seen.has(id)) return null;
    seen.add(id);
    if (toolCallId !== expected.toolCallId) return null;
    if (!isSafeAbsolutePath(root)) return null;
    if (kind !== 'git' && kind !== 'file') return null;
    if (!Array.isArray(paths) || paths.length > DIFF_RECOVERY_MAX_PATHS) return null;
    if (!paths.every(isSafeRelativePath)) return null;
    if (new Set(paths).size !== paths.length) return null;
    if (!isRecordStateHash(kind, before) || !isRecordStateHash(kind, after)) return null;
    if (before === undefined || after === undefined) return null;
    if (typeof complete !== 'boolean') return null;
    records.push({
      id,
      toolCallId,
      root: normalizeAbsolutePath(root),
      paths: [...(paths as string[])],
      kind,
      before: before as string | null,
      after: after as string | null,
      complete,
    });
  }
  return { turn_id: expected.turnId, records, ...(omitted ? { omitted } : {}) };
}

/**
 * Validate a v4 `phase: "recover"` reply. The echo must match the exact turn
 * id and the exact selected evidence id set; every repository must be a
 * bounded `working_tree` patch for a root of a selected record (no commit,
 * no baseline claims, no duplicates, combined patch cap).
 */
export function validateGitRecoveryResponse(
  raw: unknown,
  request: Pick<GitDiffRequest, 'request_id' | 'recovery'>,
  selected: readonly Pick<DiffRecoveryRecord, 'id' | 'root' | 'paths'>[],
): GitDiffResponse {
  if (!request.recovery) throw new GitDiffValidationError('not a recovery request');
  if (!isPlainObject(raw)) throw new GitDiffValidationError('not an object');
  if (raw.request_id !== request.request_id) throw new GitDiffValidationError('request id');
  const status = raw.status;
  if (status !== 'ok' && status !== 'not_repository' && status !== 'unavailable') {
    throw new GitDiffValidationError('status');
  }
  const rawRepositories = raw.repositories ?? [];
  if (!Array.isArray(rawRepositories)) throw new GitDiffValidationError('repositories');
  if (status !== 'ok') {
    if (rawRepositories.length > 0) throw new GitDiffValidationError('patch on failure');
    return { request_id: request.request_id, status, repositories: [] };
  }
  const echo = raw.recovery;
  if (!isPlainObject(echo) || echo.turn_id !== request.recovery.turn_id) {
    throw new GitDiffValidationError('recovery turn');
  }
  const ids = echo.evidence_ids;
  const wanted = request.recovery.evidence_ids;
  if (
    !Array.isArray(ids) ||
    ids.length !== wanted.length ||
    new Set(ids).size !== ids.length ||
    !ids.every((id) => typeof id === 'string' && wanted.includes(id))
  ) {
    throw new GitDiffValidationError('recovery evidence ids');
  }
  if (!Number.isInteger(echo.omitted) || (echo.omitted as number) < 0) {
    throw new GitDiffValidationError('recovery omitted');
  }
  if (rawRepositories.length > GIT_DIFF_MAX_REPOSITORIES) {
    throw new GitDiffValidationError('too many repositories');
  }
  const roots = new Set(selected.map((r) => comparablePath(r.root)));
  const seen = new Set<string>();
  let totalBytes = 0;
  const repositories: GitDiffRepository[] = [];
  for (const entry of rawRepositories) {
    if (!isPlainObject(entry)) throw new GitDiffValidationError('repository');
    const allowed = new Set(['root', 'patch', 'scope']);
    if (Object.keys(entry).some((key) => !allowed.has(key))) {
      throw new GitDiffValidationError('recovery repository fields');
    }
    const { root, patch } = entry;
    if (!isSafeAbsolutePath(root)) throw new GitDiffValidationError('root');
    const key = comparablePath(root);
    if (!roots.has(key)) throw new GitDiffValidationError('root not selected');
    if (seen.has(key)) throw new GitDiffValidationError('duplicate root');
    seen.add(key);
    if (entry.scope !== 'working_tree') throw new GitDiffValidationError('scope');
    if (typeof patch !== 'string') throw new GitDiffValidationError('patch');
    totalBytes += Buffer.byteLength(patch, 'utf8');
    if (totalBytes > GIT_DIFF_MAX_PATCH_BYTES) throw new GitDiffValidationError('patch too large');
    const allowedPaths = new Set(
      selected.filter((r) => comparablePath(r.root) === key).flatMap((r) => r.paths),
    );
    const headers = patch.match(/^diff --git .+$/gm) ?? [];
    if (patch.trim() && !headers.length) throw new GitDiffValidationError('recovery patch format');
    for (const header of headers) {
      // Match only a header that can be composed from the selected paths.
      // Git C-quoted unusual paths fail closed rather than expand the scope.
      let matched = false;
      for (const oldPath of allowedPaths) {
        const prefix = `diff --git a/${oldPath} b/`;
        if (header.startsWith(prefix) && allowedPaths.has(header.slice(prefix.length))) {
          matched = true;
          break;
        }
      }
      if (!matched) throw new GitDiffValidationError('recovery patch path not selected');
    }
    // Check file metadata before each hunk, not +/- code lines in a hunk.
    let inHunk = false;
    for (const line of patch.split('\n')) {
      if (line.startsWith('diff --git ')) {
        inHunk = false;
        continue;
      }
      if (line.startsWith('@@')) {
        inHunk = true;
        continue;
      }
      if (inHunk) continue;
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const value = line.slice(4).replace(/\t$/, '');
        if (
          value !== '/dev/null' &&
          ![...allowedPaths].some((p) => value === `a/${p}` || value === `b/${p}`)
        ) {
          throw new GitDiffValidationError('recovery file path not selected');
        }
      }
      if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
        const value = line.slice(line.startsWith('rename from ') ? 12 : 10);
        if (!allowedPaths.has(value))
          throw new GitDiffValidationError('recovery rename path not selected');
      }
    }
    repositories.push({ root: normalizeAbsolutePath(root), patch, scope: 'working_tree' });
  }
  return {
    request_id: request.request_id,
    status,
    repositories,
    recovery: {
      turn_id: request.recovery.turn_id,
      evidence_ids: [...wanted],
      omitted: Math.min(echo.omitted as number, 10_000),
    },
  };
}

/** Number of `diff --git` file sections in a patch (Git's own summary lines). */
export function countPatchFiles(patch: string): number {
  const matches = patch.match(/^diff --git /gm);
  return matches ? matches.length : 0;
}
