import type { Logger } from 'winston';
import type { AITool } from '../../ai-client';
import type { Subscription } from '../../models/subscription';
import type { AgentMessage, AgentSendFn } from '../types';

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
  isCronJob?: boolean;
  skipGrouping?: boolean;
  disableWebTools?: boolean;
  extraTools?: AITool[];
  toolHandlers?: Map<string, CustomToolHandler>;
}

export interface QueuedMessage {
  message: AgentMessage;
  send: AgentSendFn;
  subscription: Subscription;
  log: Logger;
}

export interface PendingSteeringMessage {
  content: string;
  receivedAt: string;
  platform?: string;
  groupName?: string;
}

export type PendingShellScript = {
  resolve: (output: string) => void;
  filterKeywords: string[];
};
