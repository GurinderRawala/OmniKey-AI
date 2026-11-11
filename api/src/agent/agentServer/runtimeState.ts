import type { PendingShellScript, PendingSteeringMessage, QueuedMessage } from './serverTypes';

// Per-session queuing so user messages sent during an active turn are processed
// in order after the current turn completes rather than running concurrently.
export const activeSessions = new Set<string>();
export const sessionOwners = new Map<string, AbortSignal>();
// Authenticated subscription that owns the active run of a session. Set when a
// queued input starts, removed in that run's finally (guarded by token
// identity). Steering, feedback and queued input from another subscription are
// rejected while the run is active.
export const sessionActiveSubscriptions = new Map<string, { subscriptionId: string }>();
export const sessionQueues = new Map<string, QueuedMessage[]>();
export const sessionSteeringMessages = new Map<string, PendingSteeringMessage[]>();
// Client steering IDs seen (pending, applied or rejected) during the active
// interactive run of a session. Created at run start, deleted at run end, so a
// transport retry of the same steering_id is never enqueued twice.
export const sessionSteeringIds = new Map<string, Set<string>>();

// When the model calls the shell_script tool the tool loop suspends here,
// waiting for the frontend to send back terminal output over the WebSocket.
// The WebSocket message handler resolves the promise rather than starting a
// new agent turn.
export const pendingShellScripts = new Map<string, PendingShellScript>();
