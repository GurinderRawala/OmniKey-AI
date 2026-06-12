/**
 * Result of stripping injected wrappers. We keep the user-typed body and
 * the extracted context-root fallback lines as separate fields so the
 * caller can truncate the body alone — the fallback line is small and
 * must always survive truncation. Otherwise we lose the only
 * deterministic project-path signal on long path-free turns.
 */
export interface StrippedInput {
  body: string;
  contextPathsLine: string;
}

/**
 * Strip server-injected wrappers from inside a user message AND extract
 * the previously-stored project root from any `<project_context>` block.
 *
 * The agent server prepends a `<project_context>` block (carrying the
 * group's stored absolute path) to every user turn for an already-grouped
 * session. Naively re-feeding the WHOLE block into the classifier would
 * make stale paths sticky forever, but naively dropping the block would
 * leave path-free turns with no path signal at all.
 *
 * We do something more conservative: pull the `Project root:` (legacy) or
 * `Working directory:` (current) sentence out of every block, re-append
 * each path as a `[context root] <path>` line, and strip the surrounding
 * prose. The tagged line contributes exactly ONE vote to
 * extractProjectPath's frequency count — so any path the user actually
 * types still wins by frequency, but path-free turns get a deterministic
 * fallback instead of an LLM hallucination.
 */
export function stripInjectedWrappersRich(text: string): StrippedInput {
  const contextPaths: string[] = [];
  const withContextPathsExtracted = text.replace(
    /<project_context[^>]*>([\s\S]*?)<\/project_context>/gi,
    (_full, inner: string) => {
      const m = /(?:Project root|Working directory):\s*(\/[^\s.,;:!?)<>"'`]+)/i.exec(inner);
      if (m) contextPaths.push(m[1]);
      return '';
    },
  );
  const body = withContextPathsExtracted
    .replace(/<stored_instructions>[\s\S]*?<\/stored_instructions>/gi, '')
    .replace(/<user_input>([\s\S]*?)<\/user_input>/gi, '$1')
    .replace(/@omniagent/gi, '')
    .trim();
  const contextPathsLine = contextPaths.length
    ? contextPaths.map((p) => `[context root] ${p}`).join('\n')
    : '';
  return { body, contextPathsLine };
}

/**
 * Convenience wrapper that re-joins the rich variant back into a single
 * string. Used by tests and by extractUserInputs.
 */
export function stripInjectedWrappers(text: string): string {
  const r = stripInjectedWrappersRich(text);
  return r.contextPathsLine ? `${r.body}\n${r.contextPathsLine}`.trim() : r.body;
}

/**
 * Extract user-typed text from a session's persisted history. Skips
 * server-injected feedback messages (TERMINAL OUTPUT, COMMAND ERROR, ...)
 * and unwraps the `<user_input>` tags. Each surviving message is capped
 * at 400 characters; the `[context root]` fallback line is always
 * appended in full so it cannot be sliced off the end of a long turn.
 */
export function extractUserInputs(historyJson: string): string[] {
  try {
    const history = JSON.parse(historyJson) as Array<{ role: string; content: unknown }>;
    const inputs: string[] = [];

    for (const msg of history) {
      if (msg.role !== 'user') continue;
      const raw = typeof msg.content === 'string' ? msg.content : '';
      if (!raw) continue;

      // Skip injected feedback / control messages.
      if (raw.startsWith('TERMINAL OUTPUT:')) continue;
      if (raw.startsWith('COMMAND ERROR:')) continue;
      if (raw.startsWith('Web research is complete')) continue;
      if (raw.startsWith('IMPORTANT: The web search tool failed')) continue;
      if (raw.startsWith('Content was truncated')) continue;

      // Unwrap <user_input>, then strip injected wrappers from the inner
      // text. The body is capped at 400 chars; the fallback line is
      // appended in full so it always survives the cap.
      const match = /<user_input>([\s\S]*?)<\/user_input>/i.exec(raw);
      const inner = match ? match[1] : raw;
      const { body, contextPathsLine } = stripInjectedWrappersRich(inner);
      const truncatedBody = body.slice(0, 400);
      const combined = contextPathsLine
        ? truncatedBody
          ? `${truncatedBody}\n${contextPathsLine}`
          : contextPathsLine
        : truncatedBody;
      if (combined.length > 5) {
        inputs.push(combined);
      }
    }

    return inputs.slice(0, 8);
  } catch {
    return [];
  }
}
