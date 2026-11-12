import { AIMessage } from '../ai-client';
import { Subscription } from '../models/subscription';
import type { SkillStatus } from '../skills/contracts';
import type { SkillRunState } from './skillContext';
import type { GitRunState } from './gitDiff/coordinator';
import type { GitDiffRequest, GitDiffShellContext, SessionDiffSummary } from './gitDiff/contracts';

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
  // Invocation-local cancellation and summary backoff; never persisted.
  signal?: AbortSignal;
  memoryRetryAfterHistoryLength?: number;
  // True when the user explicitly chose this session's group. Locked sessions
  // are never (re)classified — we only ever attach them to the chosen group.
  groupLocked?: boolean;
  // Runtime-only Skills state of the outer run this invocation belongs to.
  // Never persisted, never part of history; applied only to provider request copies.
  skillRun?: SkillRunState;
  // Runtime-only Git snapshot evidence of the outer run (supporting macOS
  // clients only). Never persisted as session state, never sent to a model.
  gitRun?: GitRunState;
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
  activity_id?: string;
  activity_phase?: 'pending' | 'started' | 'completed' | 'failed' | 'cancelled';
  is_steering?: boolean;
  steering_id?: string;
  steering_status?: 'received' | 'applied' | 'rejected';
  steering_pending_count?: number;
  platform?: string;
  group_name?: string;
  // Per-turn model override; never updates the shared provider settings.
  model?: string;
  // Client -> server: opt in to nonterminal Skills notices for THIS input only
  // (literal true). Snapshotted per input; never persisted as a preference.
  supports_skill_status?: boolean;
  // Server -> client: Skills status metadata (refs only, never instructions).
  skill_status?: SkillStatus;
  // Client -> server (initial input): the client can collect Git snapshots on
  // its own execution host. Literal true only; never inferred.
  supports_git_diff?: boolean;
  // Client -> server (initial input, contract v3): the client can capture
  // per-turn HEAD baselines (`git_diff_request.phase`). Literal true only.
  supports_git_turn_diff?: boolean;
  // Server -> client control frame sent before a final answer.
  git_diff_request?: GitDiffRequest;
  // Client -> server reply to git_diff_request (validated; never a turn input).
  git_diff_response?: unknown;
  // Server -> client on a shell_script request: verified candidate paths so
  // the client can record HEAD before/after the script.
  git_diff_context?: GitDiffShellContext;
  // Server -> client on a shell_script request: structured directory to run in.
  working_directory?: string;
  // Client -> server on the terminal reply of an outstanding shell_script.
  git_commit_observations?: unknown;
  // Server -> client on a final answer: immutable snapshot summary.
  session_diff?: SessionDiffSummary;
}

export type AgentSendFn = (msg: AgentMessage) => void;
