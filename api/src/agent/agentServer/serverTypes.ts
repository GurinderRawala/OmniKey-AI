import type { Logger } from 'winston';
import type { AITool } from '../../ai-client';
import type { Subscription } from '../../models/subscription';
import type { AgentMessage, AgentSendFn } from '../types';
import type { SkillSnapshot, SkillWarning } from '../../skills/contracts';

// A server-side tool handler injected for a single agent invocation (see
// AgentTurnOptions.toolHandlers). Receives the parsed tool arguments and
// returns the string that is fed back to the model as the tool result.
export type CustomToolHandler = (args: Record<string, unknown>, log: Logger) => Promise<string>;

// Options accepted by runAgentTurn. `extraTools` + `toolHandlers` let an
// internal caller (e.g. the session-grouping cron) hand the agent a bespoke
// server-side tool for one invocation without exposing it to normal chat
// sessions. `skipGrouping` disables the end-of-turn group classification for
// runs that are not real user sessions.
export interface AgentTurnOptions {
  signal?: AbortSignal;
  isCronJob?: boolean;
  skipGrouping?: boolean;
  disableWebTools?: boolean;
  extraTools?: AITool[];
  toolHandlers?: Map<string, CustomToolHandler>;
  // Set only by the interactive WebSocket queue. Genuine interactive inputs and
  // their steering may activate Skills; cron/internal/direct callers never do.
  interactiveInput?: boolean;
  // Notice capability of the connection that sent this input (and receives
  // its frames). Literal-true opt-in, per input.
  supportsSkillStatus?: boolean;
  // Literal-true Git snapshot capability of the connection that sent this input.
  supportsGitDiff?: boolean;
  // Literal-true per-turn baseline capability (contract v3) of that connection.
  supportsGitTurnDiff?: boolean;
  // Literal-true diff recovery capability (contract v4) of that connection.
  supportsDiffRecovery?: boolean;
}

export interface QueuedMessage {
  signal?: AbortSignal;
  message: AgentMessage;
  send: AgentSendFn;
  subscription: Subscription;
  log: Logger;
}

export interface PendingSteeringMessage {
  steeringId: string;
  content: string;
  receivedAt: string;
  platform?: string;
  groupName?: string;
  // Sender connection and its per-input Skills notice capability (runtime only).
  replyTo?: AgentSendFn;
  supportsSkillStatus?: boolean;
  // False when the steering was not client-originated: it is still delivered
  // as steering but never activates skills (runtime only).
  skillsEligible?: boolean;
  // Set once Skills resolution for this steering input succeeded (runtime only).
  skillsPrepared?: boolean;
  skillAdditions?: readonly SkillSnapshot[];
  skillWarnings?: readonly SkillWarning[];
}

export type PendingShellScript = {
  // `gitCommitObservations` and `diffRecoveryEvidence` are raw, unvalidated
  // reply fields; the tool loop validates them against the shell request it
  // issued (turn id + tool call id).
  resolve: (
    output: string,
    isError: boolean | undefined,
    gitCommitObservations?: unknown,
    diffRecoveryEvidence?: unknown,
  ) => void;
  filterKeywords: string[];
};
