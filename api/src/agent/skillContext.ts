/**
 * Skills v1 runtime activation for the interactive agent (docs/skills-contract.md).
 *
 * Lifecycle:
 * - `startSkillRun` runs once per OUTER interactive run, after authentication
 *   and before any session history, turn counter, model or tool work. A
 *   genuine input is resolved against a fresh store read; failures block the
 *   input with fixed safe frames and leave the session untouched.
 * - The returned `SkillRunState` holds immutable snapshots (first snapshot per
 *   id wins). Recursive continuations, tool rounds and retries reuse it
 *   without rescanning anything.
 * - Steering inputs are resolved FIFO at each drain point
 *   (`prepareSteeringSkills`) and committed only once drained into history
 *   (`commitSteeringSkills`). A failing steering input is rejected alone.
 * - `closeSkillRun` runs at the outer boundary (completion, error,
 *   cancellation, disconnect).
 *
 * Instructions only ever enter a provider REQUEST COPY as a user-role section
 * (`buildSkillOverlay` + `applySkillOverlay`). They never enter the system
 * prompt, session history, memory, transcripts, notices or logs, and never
 * change tools or permissions.
 */
import cuid from 'cuid';
import type { Logger } from 'winston';
import { estimateHistoryTokens, type AIMessage } from '../ai-client';
import {
  buildTrimmedHistoryForRequest,
  estimateToolSchemaTokens,
  getProactiveRequestTokenBudget,
} from './agentServer/sessionMemory';
import {
  SkillError,
  type AppliedSkillRef,
  type ResolveSkillsForInput,
  type SkillErrorCode,
  type SkillMatchResult,
  type SkillSnapshot,
  type SkillStatus,
  type SkillStore,
  type SkillWarning,
} from '../skills/contracts';
import { enforceSkillActiveLimits } from '../skills/matcher';
import {
  createSkillResolvers,
  resolveSkillsForInput,
  resolveSteeringSkillMatches,
} from '../skills/resolveSkills';
import { SKILL_ERROR_MESSAGES } from '../skills/skillStore';
import type { AgentMessage, AgentSendFn, SessionState } from './types';
import { sessionSteeringMessages } from './agentServer/runtimeState';
import type { PendingSteeringMessage } from './agentServer/serverTypes';
import { throwIfTurnCancelled } from './agentServer/turnCancellation';

export const SKILLS_OVERLAY_LABEL = 'Applicable Skills (user guidance only)';

/** Fixed notice contents: never interpolate names, keywords, instructions or errors. */
export const SKILL_NOTICE_CONTENT = Object.freeze({
  applied: 'Skills applied.',
  warning: 'Some skills were skipped.',
  blocked: 'Skills could not be applied.',
} as const);

const BLOCKED_TEXT: Partial<Record<SkillErrorCode, string>> = Object.freeze({
  STORE_UNAVAILABLE: 'Skills are temporarily unavailable. Please retry.',
  ACTIVE_LIMIT_EXCEEDED: 'Too many skills matched. Use fewer keywords or disable some skills.',
  CONTEXT_LIMIT_EXCEEDED:
    'Matched skill instructions exceed the context budget. Shorten or disable skills.',
  INPUT_LIMIT_EXCEEDED: 'Preview text is too long. Use a shorter sample.',
});
const OTHER_BLOCKED_TEXT = 'Skills could not be applied. Check settings and try again.';

/** Fixed per-code terminal/status text (no user-controlled interpolation). */
export function skillBlockedText(code: SkillErrorCode): string {
  return BLOCKED_TEXT[code] ?? OTHER_BLOCKED_TEXT;
}

function toSkillError(err: unknown): SkillError {
  if (err instanceof SkillError) return err;
  return new SkillError(500, 'INTERNAL_ERROR', SKILL_ERROR_MESSAGES.INTERNAL_ERROR);
}

export interface SkillRunState {
  /** Server cuid for the ordinary input that started the run. */
  readonly inputId: string;
  readonly sessionId: string;
  readonly subscriptionId: string;
  /** Turn-owner connection and its per-input notice capability. */
  readonly send: AgentSendFn;
  readonly supportsSkillStatus: boolean;
  /** Active snapshots in application order; first snapshot per id wins. */
  readonly active: SkillSnapshot[];
  readonly activeIds: Set<string>;
  /** Content of the latest genuine user message (ordinary or steering) in history. */
  anchorContent?: string;
  /** `${input_id}\0${status}` keys already notified. */
  readonly sentNotices: Set<string>;
  /**
   * Turn-owner applied/warning notices resolved but not yet confirmed: sent
   * only once a request carrying them was accepted by the provider, and
   * discarded on a preflight/provider failure, block or close.
   */
  readonly pendingNotices: SkillStatus[];
  /**
   * Deferred durable checkpoint (history + first-turn title) of the genuine
   * input that started this run. Flushed once the first request passed the
   * Skills budget check, so an initial budget rejection persists nothing.
   */
  pendingInputCheckpoint?: () => Promise<void>;
  /** Overlay token reservation of the latest request (context-remaining hint). */
  reservedTokensHint?: number;
  closed: boolean;
}

// Ordinary input/preview: budgeted. Steering: unbudgeted over the SAME store;
// prepareSteeringSkills enforces the limits on the first-snapshot union.
let resolver: ResolveSkillsForInput = resolveSkillsForInput;
let steeringResolver: ResolveSkillsForInput = resolveSteeringSkillMatches;

/**
 * Test seam: replace the resolvers; returns a restore function. When only one
 * resolver is given it is used for steering too.
 */
export function setSkillResolverForTesting(
  next: ResolveSkillsForInput,
  nextSteering: ResolveSkillsForInput = next,
): () => void {
  const previous = [resolver, steeringResolver] as const;
  resolver = next;
  steeringResolver = nextSteering;
  return () => {
    [resolver, steeringResolver] = previous;
  };
}

/** Test seam: bind both production resolvers to one injected store. */
export function setSkillStoreForTesting(getStore: () => Promise<SkillStore>): () => void {
  const { ordinary, steering } = createSkillResolvers(getStore);
  return setSkillResolverForTesting(ordinary, steering);
}

/**
 * Ordinary inputs that may activate skills: sent by a client, and not
 * terminal/error feedback or an internal continuation.
 */
export function isGenuineSkillInput(message: AgentMessage): boolean {
  return (
    message.sender === 'client' &&
    !message.is_terminal_output &&
    !message.is_error &&
    !message.is_web_call
  );
}

/**
 * Raised when a request carrying the Skills overlay cannot be guaranteed to
 * fit the model input budget. Never carries names, keywords or instructions.
 */
export class SkillContextBudgetError extends Error {
  readonly code = 'CONTEXT_LIMIT_EXCEEDED' as const;
  constructor() {
    super('Skills overlay does not fit the model input budget');
    this.name = 'SkillContextBudgetError';
  }
}

/**
 * Trim the overlay-free request view with the Skills reservation and verify
 * that history + overlay + tool schemas fit the model's safe input budget.
 * Throws SkillContextBudgetError (fail closed) when the budget is unknown or
 * nonpositive, when the reservation alone exhausts it, or when trimming cannot
 * shrink the irreducible history enough. Returns the trimmed base history.
 *
 * Bounds: overlay = UTF-8 bytes (conservative upper bound); history and tool
 * schemas = the repo's existing estimator. Not exact provider tokenization.
 */
export function assertSkillRequestFits(
  session: SessionState,
  model: string,
  sessionId: string,
  tools: readonly unknown[] | undefined,
  log?: Logger,
): AIMessage[] {
  const overlay = buildSkillOverlay(session);
  const budget = getProactiveRequestTokenBudget(model);
  const reserved = (overlay?.reservedTokens ?? 0) + estimateToolSchemaTokens(tools);
  if (!Number.isFinite(budget) || budget <= 0 || reserved >= budget) {
    throw new SkillContextBudgetError();
  }
  const base = buildTrimmedHistoryForRequest(session, model, sessionId, log, reserved);
  if (estimateHistoryTokens(base) + reserved > budget) throw new SkillContextBudgetError();
  if (session.skillRun) session.skillRun.reservedTokensHint = reserved;
  return base;
}

function refs(snapshots: readonly SkillSnapshot[]): AppliedSkillRef[] {
  return snapshots.map(({ id, name, keyword, revision }) => ({ id, name, keyword, revision }));
}

function safeWarnings(warnings: readonly SkillWarning[]): SkillWarning[] {
  return warnings.map(({ code, skillId, message }) => ({
    code,
    ...(skillId !== undefined ? { skillId } : {}),
    message,
  }));
}

/**
 * Nonterminal status notice, only to an opted-in receiving connection and at
 * most once per input id + status.
 */
function sendSkillNotice(
  target: { send: AgentSendFn; supportsSkillStatus: boolean; sentNotices?: Set<string> },
  sessionId: string,
  status: SkillStatus,
): void {
  if (!target.supportsSkillStatus) return;
  const key = `${status.input_id}\u0000${status.status}`;
  if (target.sentNotices?.has(key)) return;
  target.sentNotices?.add(key);
  target.send({
    session_id: sessionId,
    sender: 'agent',
    content: SKILL_NOTICE_CONTENT[status.status],
    is_terminal_output: false,
    is_error: false,
    skill_status: status,
  });
}

function blockedStatus(inputId: string, error: SkillError): SkillStatus {
  return {
    input_id: inputId,
    status: 'blocked',
    skills: [],
    warnings: [],
    error: { code: error.code, message: skillBlockedText(error.code) },
  };
}

function noticeKey(status: SkillStatus): string {
  return `${status.input_id}\u0000${status.status}`;
}

/** Queue a turn-owner notice until the provider accepts a request (deduped). */
function queueRunNotice(run: SkillRunState, status: SkillStatus): void {
  if (!run.supportsSkillStatus || run.closed) return;
  const key = noticeKey(status);
  if (run.sentNotices.has(key)) return;
  if (run.pendingNotices.some((queued) => noticeKey(queued) === key)) return;
  run.pendingNotices.push(status);
}

function queueResolutionNotices(
  run: SkillRunState,
  inputId: string,
  added: readonly SkillSnapshot[],
  warnings: readonly SkillWarning[],
): void {
  if (added.length > 0) {
    queueRunNotice(run, {
      input_id: inputId,
      status: 'applied',
      skills: refs(added),
      warnings: [],
    });
  }
  if (warnings.length > 0) {
    queueRunNotice(run, {
      input_id: inputId,
      status: 'warning',
      skills: [],
      warnings: safeWarnings(warnings),
    });
  }
}

/**
 * Send queued applied/warning notices once the provider accepted a request
 * carrying the active skills. Each input id + status is sent at most once per
 * run lifetime (ordinary input, steering, retries and continuations).
 */
export function flushSkillNotices(run: SkillRunState | undefined): void {
  if (!run || run.closed || run.pendingNotices.length === 0) return;
  const queued = run.pendingNotices.splice(0);
  for (const status of queued) sendSkillNotice(run, run.sessionId, status);
}

export interface StartSkillRunParams {
  sessionId: string;
  subscriptionId: string;
  message: AgentMessage;
  send: AgentSendFn;
  supportsSkillStatus: boolean;
  log: Logger;
  signal?: AbortSignal;
}

/**
 * Opted-in blocked notice, then the fixed terminal error frame to the turn
 * owner. Nothing is persisted by this helper.
 */
function sendBlockedFrames(run: SkillRunState, inputId: string, error: SkillError): void {
  // The run stops: unconfirmed applied/warning notices never become true.
  run.pendingNotices.length = 0;
  sendSkillNotice(run, run.sessionId, blockedStatus(inputId, error));
  run.send({
    session_id: run.sessionId,
    sender: 'agent',
    content: `<final_answer>\n${skillBlockedText(error.code)}\n</final_answer>`,
    is_terminal_output: false,
    is_error: true,
  });
}

/**
 * Fixed CONTEXT_LIMIT_EXCEEDED frames for a run whose request cannot fit the
 * model budget (initial or mid-run). No history, memory or transcript write.
 */
export function sendSkillContextLimitFrames(run: SkillRunState): void {
  sendBlockedFrames(
    run,
    run.inputId,
    new SkillError(413, 'CONTEXT_LIMIT_EXCEEDED', skillBlockedText('CONTEXT_LIMIT_EXCEEDED')),
  );
}

/**
 * Flush the deferred durable checkpoint of the run's genuine input, at most
 * once. Safe to call when there is none.
 */
export async function flushSkillInputCheckpoint(run: SkillRunState | undefined): Promise<void> {
  const checkpoint = run?.pendingInputCheckpoint;
  if (!run || !checkpoint) return;
  run.pendingInputCheckpoint = undefined;
  await checkpoint();
}

/**
 * Start the Skills state of an outer interactive run. Genuine inputs are
 * resolved from the raw text (the matcher strips the routing prefix itself).
 * Returns 'blocked' when the input is blocked: an opted-in blocked notice and
 * the fixed terminal error frame have then been sent, and nothing was
 * persisted. Returns 'cancelled' (nothing sent or persisted) when the signal
 * aborted before or during resolution.
 */
export async function startSkillRun(
  params: StartSkillRunParams,
): Promise<SkillRunState | 'blocked' | 'cancelled'> {
  const { sessionId, subscriptionId, message, send, supportsSkillStatus, log, signal } = params;
  if (signal?.aborted) return 'cancelled';
  const run: SkillRunState = {
    inputId: cuid(),
    sessionId,
    subscriptionId,
    send,
    supportsSkillStatus,
    active: [],
    activeIds: new Set(),
    sentNotices: new Set(),
    pendingNotices: [],
    closed: false,
  };
  if (!isGenuineSkillInput(message)) return run;

  let result: SkillMatchResult;
  try {
    const rawText = typeof message.content === 'string' ? message.content : '';
    result = await resolver(subscriptionId, rawText);
    enforceSkillActiveLimits(result.matches);
  } catch (err) {
    // The store read cannot be aborted; a cancellation during it wins quietly.
    if (signal?.aborted) return 'cancelled';
    const error = toSkillError(err);
    log.warn('Skills blocked agent input', { sessionId, inputId: run.inputId, code: error.code });
    sendBlockedFrames(run, run.inputId, error);
    return 'blocked';
  }
  if (signal?.aborted) return 'cancelled';

  for (const snapshot of result.matches) {
    if (run.activeIds.has(snapshot.id)) continue;
    run.activeIds.add(snapshot.id);
    run.active.push(snapshot);
  }
  if (run.active.length > 0 || result.warnings.length > 0) {
    log.info('Skills resolved for agent input', {
      sessionId,
      inputId: run.inputId,
      skillIds: run.active.map((s) => s.id),
      warningCount: result.warnings.length,
    });
  }
  // Notified only after the provider accepts the first request with them.
  queueResolutionNotices(run, run.inputId, run.active, result.warnings);
  return run;
}

/** Outer-boundary cleanup; later request builds see no overlay. */
export function closeSkillRun(run: SkillRunState): void {
  run.closed = true;
  run.pendingNotices.length = 0;
  run.active.length = 0;
  run.activeIds.clear();
  run.anchorContent = undefined;
  run.pendingInputCheckpoint = undefined;
  run.reservedTokensHint = undefined;
}

/** Associate the overlay with the latest genuine user message just pushed to history. */
export function anchorSkillsToLatestUserMessage(session: SessionState): void {
  const run = session.skillRun;
  if (!run || run.closed) return;
  // Index instead of Array#at: the runtime package still supports Node 14.
  const last = session.history[session.history.length - 1];
  if (last?.role === 'user' && typeof last.content === 'string') run.anchorContent = last.content;
}

export interface SkillOverlay {
  /** `Applicable Skills (user guidance only)` + LF + JSON array. */
  readonly content: string;
  /** Conservative token upper bound to reserve before trimming. */
  readonly reservedTokens: number;
  readonly anchorContent?: string;
}

// Allowance for the role/message framing of a separately inserted overlay
// message (anchored overlays need less; the larger bound is always reserved).
const OVERLAY_FRAMING_TOKENS = 16;

/**
 * Conservative token upper bound for overlay text: its UTF-8 byte length plus
 * framing. Byte-level BPE tokenizers (and SentencePiece with byte fallback)
 * never emit a token covering less than one byte, so bytes >= tokens. This is
 * NOT exact provider tokenization (the repo has no tokenizer); it overcounts
 * ASCII roughly 3-4x and, unlike a chars/N heuristic, never undercounts CJK,
 * emoji or escaped JSON.
 */
export function skillOverlayTokenUpperBound(text: string): number {
  return Buffer.byteLength(text, 'utf8') + OVERLAY_FRAMING_TOKENS;
}

/** Overlay snapshot for one provider request, or null when no skill is active. */
export function buildSkillOverlay(session: SessionState): SkillOverlay | null {
  const run = session.skillRun;
  if (!run || run.closed || run.active.length === 0) return null;
  const content = `${SKILLS_OVERLAY_LABEL}\n${JSON.stringify(
    run.active.map(({ id, name, keyword, revision, instructions }) => ({
      id,
      name,
      keyword,
      revision,
      instructions,
    })),
  )}`;
  return {
    content,
    // Two LF separators are added when appended to the anchor message.
    reservedTokens: skillOverlayTokenUpperBound(`\n\n${content}`),
    anchorContent: run.anchorContent,
  };
}

/**
 * Return a request copy with exactly one overlay. Appended to the latest
 * genuine user message when present; otherwise inserted as one user message
 * at the end, never between an assistant tool call and its results. The
 * input array and its messages are never mutated.
 */
export function applySkillOverlay(history: AIMessage[], overlay: SkillOverlay | null): AIMessage[] {
  if (!overlay) return history;
  const copy = history.map((message) => ({ ...message }));
  if (overlay.anchorContent !== undefined) {
    for (let index = copy.length - 1; index >= 0; index--) {
      const message = copy[index];
      if (message.role === 'user' && message.content === overlay.anchorContent) {
        copy[index] = { ...message, content: `${message.content}\n\n${overlay.content}` };
        return copy;
      }
    }
  }
  let position = copy.length;
  const last = copy[position - 1];
  if (last?.role === 'assistant' && last.tool_calls?.length) position -= 1;
  copy.splice(position, 0, { role: 'user', content: overlay.content });
  return copy;
}

function rejectSteering(
  sessionId: string,
  run: SkillRunState,
  message: PendingSteeringMessage,
  error: SkillError,
  log: Logger,
): void {
  const pending = sessionSteeringMessages.get(sessionId) ?? [];
  const remaining = pending.filter((entry) => entry !== message);
  if (remaining.length > 0) sessionSteeringMessages.set(sessionId, remaining);
  else sessionSteeringMessages.delete(sessionId);

  const target = {
    send: message.replyTo ?? run.send,
    supportsSkillStatus: message.supportsSkillStatus === true,
    sentNotices: run.sentNotices,
  };
  sendSkillNotice(target, sessionId, blockedStatus(message.steeringId, error));
  target.send({
    session_id: sessionId,
    sender: 'agent',
    content: skillBlockedText(error.code),
    is_terminal_output: false,
    is_error: true,
    is_steering: true,
    steering_id: message.steeringId,
    steering_status: 'rejected',
  });
  log.warn('Skills rejected steering input', { sessionId, code: error.code });
}

/** True when the active run has pending steering not yet resolved for Skills. */
export function hasUnpreparedSteering(sessionId: string, session: SessionState): boolean {
  const run = session.skillRun;
  if (!run || run.closed) return false;
  return (sessionSteeringMessages.get(sessionId) ?? []).some((m) => !m.skillsPrepared);
}

/**
 * Resolve pending steering FIFO against a fresh store read and validate each
 * against the accumulated union (active first snapshots + earlier prepared
 * additions). Matching is unbudgeted; the limits apply only to that
 * deduplicated union. A failing input is rejected alone; the active run is
 * unchanged. Nothing is committed here.
 *
 * `discardExpired` drops TTL-expired pending steering (keeping their seen
 * IDs); it runs before every preparation and again after each store read, so
 * expired input never counts toward the union nor receives a Skills verdict.
 */
export async function prepareSteeringSkills(
  sessionId: string,
  session: SessionState,
  log: Logger,
  discardExpired: () => void = () => undefined,
  validateCandidate: (
    snapshots: readonly SkillSnapshot[],
    pending: readonly PendingSteeringMessage[],
  ) => void = () => undefined,
): Promise<void> {
  const run = session.skillRun;
  if (!run || run.closed) return;
  for (;;) {
    throwIfTurnCancelled(session.signal);
    discardExpired();
    const next = (sessionSteeringMessages.get(sessionId) ?? []).find((m) => !m.skillsPrepared);
    if (!next) return;
    let result: SkillMatchResult | undefined;
    let failure: SkillError | undefined;
    try {
      // Non-client guidance must not activate skills, but still consumes
      // model context when delivered into an already-active run.
      result =
        next.skillsEligible === false
          ? { matches: [], warnings: [] }
          : await steeringResolver(run.subscriptionId, next.content);
    } catch (err) {
      failure = toSkillError(err);
    }
    // Nothing is emitted or decided after cancellation.
    throwIfTurnCancelled(session.signal);
    discardExpired();
    const current = sessionSteeringMessages.get(sessionId) ?? [];
    if (run.closed) return;
    // Drained, expired or cleared while resolving: nothing to decide.
    if (!current.includes(next)) continue;

    if (result) {
      const known = new Set(run.activeIds);
      const union: SkillSnapshot[] = [...run.active];
      for (const earlier of current) {
        if (earlier === next || !earlier.skillsPrepared) continue;
        for (const snapshot of earlier.skillAdditions ?? []) {
          if (known.has(snapshot.id)) continue;
          known.add(snapshot.id);
          union.push(snapshot);
        }
      }
      const additions = result.matches.filter((snapshot) => !known.has(snapshot.id));
      try {
        const candidate = [...union, ...additions];
        enforceSkillActiveLimits(candidate);
        validateCandidate(
          candidate,
          current.filter((message) => message === next || message.skillsPrepared),
        );
        next.skillsPrepared = true;
        next.skillAdditions = Object.freeze(additions);
        // A row that became invalid after activation keeps its frozen, still
        // valid first snapshot for this run: no "skipped" warning for it.
        next.skillWarnings = Object.freeze(
          result.warnings.filter((w) => w.skillId === undefined || !known.has(w.skillId)),
        );
        continue;
      } catch (err) {
        failure = toSkillError(err);
      }
    }
    rejectSteering(sessionId, run, next, failure!, log);
  }
}

/**
 * Commit the prepared additions of steering that was actually drained into
 * history, notify the turn owner about NEW skills only, and move the overlay
 * anchor to the merged/added steering message.
 */
export function commitSteeringSkills(
  session: SessionState,
  applied: readonly PendingSteeringMessage[],
): void {
  const run = session.skillRun;
  if (!run || run.closed || applied.length === 0) return;
  for (const message of applied) {
    const added: SkillSnapshot[] = [];
    for (const snapshot of message.skillAdditions ?? []) {
      if (run.activeIds.has(snapshot.id)) continue;
      run.activeIds.add(snapshot.id);
      run.active.push(snapshot);
      added.push(snapshot);
    }
    queueResolutionNotices(run, message.steeringId, added, message.skillWarnings ?? []);
  }
  anchorSkillsToLatestUserMessage(session);
}
