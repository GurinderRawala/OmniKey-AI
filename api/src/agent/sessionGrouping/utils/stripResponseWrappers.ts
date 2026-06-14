/**
 * Some LLMs wrap their JSON in `<final_answer>` tags or markdown code fences.
 * `stripResponseWrappers` strips those wrappers so the caller can hand the
 * raw inner text straight to `JSON.parse`.
 */
export function stripResponseWrappers(text: string): string {
  return text
    .trim()
    .replace(/^<final_answer>\s*/i, '')
    .replace(/\s*<\/final_answer>$/i, '')
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}
