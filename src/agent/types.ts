import { AIMessage } from '../ai-client';
import { Subscription } from '../models/subscription';

// In-memory conversation state per session.
export interface SessionState {
  subscription: Subscription;
  history: AIMessage[];
  // Number of agent turns that have been run for this session.
  turns: number;
}

export interface AgentMessage {
  session_id: string;
  sender: string;
  content: string;
  is_terminal_output?: boolean;
  is_error?: boolean;
  is_web_call?: boolean;
  platform?: string;
}

export type AgentSendFn = (msg: AgentMessage) => void;
