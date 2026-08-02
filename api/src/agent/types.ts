import { AIMessage } from '../ai-client';
import { Subscription } from '../models/subscription';

// In-memory conversation state per session.
export interface SessionState {
  subscription: Subscription;
  history: AIMessage[];
  // Number of agent turns that have been run for this session.
  turns: number;
  // Persisted group name for this session, if one has already been assigned by
  // the grouping classifier. Used to skip redundant re-classification work at
  // the end of each agent turn.
  groupName?: string | null;
  // Compact memory for the active session. history remains the full raw
  // transcript; this summary is injected into model requests after older turns
  // have been compacted.
  sessionMemory?: string | null;
  sessionMemoryHistoryLength?: number;
  sessionMemoryUpdatedAt?: Date | null;
  // Latest provider-reported prompt tokens for this active session. Used only
  // as an in-memory hint so persisted context remaining includes tool schemas
  // after a model call; compacted-history estimate remains the pre-call fallback.
  lastModelPromptTokens?: number;
  // Model selected from agent_settings for the active turn. Helpers use this
  // to derive hot-reloaded context and per-message budgets.
  activeModel?: string;
  // True when the user explicitly chose this session's group. Locked sessions
  // are never (re)classified — we only ever attach them to the chosen group.
  groupLocked?: boolean;
}

export interface AgentMessage {
  session_id: string;
  sender: string;
  content: string;
  is_terminal_output?: boolean;
  is_error?: boolean;
  is_web_call?: boolean;
  is_image_rendering?: boolean;
  is_mcp_call?: boolean;
  is_steering?: boolean;
  platform?: string;
  group_name?: string;
}

export type AgentSendFn = (msg: AgentMessage) => void;
