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
  platform?: string;
  group_name?: string;
}

export type AgentSendFn = (msg: AgentMessage) => void;
