/**
 * Truncate `text` to at most `maxLen` characters but never mid-word. Prefers
 * the last sentence terminator (.!?) followed by whitespace inside the
 * budget; otherwise backs off to the last whitespace and synthesises a
 * trailing period. May exceed `maxLen` by one character when appending the
 * synthetic period — callers that need a hard cap should size their budget
 * accordingly.
 */
export function truncateOnSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const slice = text.slice(0, maxLen);
  // Prefer the last sentence terminator followed by a space (or end).
  const sentenceMatch = /[.!?](?=\s|$)(?!.*[.!?](?=\s|$))/s.exec(slice);
  if (sentenceMatch && sentenceMatch.index > maxLen * 0.5) {
    return slice.slice(0, sentenceMatch.index + 1).trimEnd();
  }
  // Otherwise back off to the last whitespace so we don't cut a word.
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.5) {
    return (
      slice
        .slice(0, lastSpace)
        .trimEnd()
        .replace(/[,;:]$/, '') + '.'
    );
  }
  // Last resort: hard truncate, but always end on a period.
  return slice.trimEnd().replace(/[,;:.!?]+$/, '') + '.';
}
