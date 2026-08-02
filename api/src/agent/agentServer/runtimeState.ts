import type { PendingShellScript, PendingSteeringMessage, QueuedMessage } from './serverTypes';

// Per-session queuing so user messages sent during an active turn are processed
// in order after the current turn completes rather than running concurrently.
export const activeSessions = new Set<string>();
export const sessionQueues = new Map<string, QueuedMessage[]>();
export const sessionSteeringMessages = new Map<string, PendingSteeringMessage[]>();

// When the model calls the shell_script tool the tool loop suspends here,
// waiting for the frontend to send back terminal output over the WebSocket.
// The WebSocket message handler resolves the promise rather than starting a
// new agent turn.
export const pendingShellScripts = new Map<string, PendingShellScript>();
