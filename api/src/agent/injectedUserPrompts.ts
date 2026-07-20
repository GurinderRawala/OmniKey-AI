/**
 * Server-injected `role: 'user'` prompts.
 *
 * The agent loop persists a handful of `role: 'user'` messages into the
 * session history that are NOT things the human typed — they are directives
 * the server writes to steer the model back onto a valid response format
 * after certain edge cases (web tool failure, over-length output, missing
 * response tag, ...). See `pushToSessionHistory(logger, session, { role:
 * 'user', ... })` sites in `agentServer.ts`.
 *
 * These messages are essential mid-turn (the model relies on them for
 * recovery) but they must NEVER be rendered as user chat bubbles when a
 * session is later resumed and must NEVER be treated as user input for
 * session grouping / classification. Both call sites (the resumed-chat
 * transcript builder and the grouping input extractor) filter them out
 * using the shared predicate below so the two paths cannot drift.
 *
 * Terminal feedback messages (`TERMINAL OUTPUT:` and `COMMAND ERROR:`) are
 * ALSO server-injected user turns, but they are handled separately: the
 * transcript builder promotes them into `terminalOutput` assistant blocks,
 * and the grouping extractor skips them explicitly. Keeping those two
 * prefixes in the same list here would break the transcript builder's
 * terminal-output rendering, so they are intentionally NOT included.
 */
const INJECTED_USER_PROMPT_PREFIXES: readonly string[] = [
  // agentServer.ts — web tool loop resolution (both branches share these
  // opening lines depending on whether the web call failed).
  'IMPORTANT: The web search tool failed',
  'Web research is complete',
  // agentServer.ts — length-limit recovery after a truncated assistant turn.
  'Your previous response exceeded the output length limit',
  // agentServer.ts — untagged-response recovery when the model replied
  // with plain text instead of a tool call or <final_answer>.
  'Your response was plain text',
  // Legacy prefix kept for older sessions persisted before the current
  // wording. Cheap to check and future-proof against re-introducing the
  // wording under a slightly different opening.
  'Content was truncated',
];

/**
 * Returns true if `content` is a server-injected `role: 'user'` control
 * prompt that should be hidden from the resumed transcript and skipped by
 * grouping. Matches on the leading, non-whitespace text so trivial leading
 * newlines introduced by future edits do not defeat the filter.
 */
export function isInjectedUserPrompt(content: string): boolean {
  if (!content) return false;
  const head = content.trimStart();
  for (const prefix of INJECTED_USER_PROMPT_PREFIXES) {
    if (head.startsWith(prefix)) return true;
  }
  return false;
}

/** Exposed for tests that want to assert the exact wordings we filter on. */
export const __injectedUserPromptPrefixes = INJECTED_USER_PROMPT_PREFIXES;
