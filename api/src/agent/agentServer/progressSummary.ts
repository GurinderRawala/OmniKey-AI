const MAX_PROGRESS_SUMMARY_WORDS = 150;

/**
 * Applies the same safety boundary to live and replayed progress summaries.
 * The persisted assistant payload is untrusted display input: normalize it,
 * remove markup, redact common credential shapes, and enforce the wire limit.
 */
export function sanitizeProgressSummary(text: string): string | null {
  const oneParagraph = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!oneParagraph) return null;

  const redacted = oneParagraph
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*([^\s,;]+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  const words = redacted.split(/\s+/);
  return words.length > MAX_PROGRESS_SUMMARY_WORDS
    ? `${words.slice(0, MAX_PROGRESS_SUMMARY_WORDS).join(' ')}…`
    : redacted;
}

/** Extracts only the deliberately user-visible summary tag. */
export function extractProgressSummary(content: string): string | null {
  const match = content.match(/<progress_summary[^>]*>([\s\S]*?)<\/progress_summary>/i);
  return match?.[1] ? sanitizeProgressSummary(match[1]) : null;
}
