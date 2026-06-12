/**
 * Render a Date (or ISO string) as `YYYY-MM-DD HH:MM UTC` — a compact,
 * timezone-stable format suitable for embedding in the `<project_context>`
 * block. Returns `'unknown time'` when the input is null/invalid.
 */
export function formatSessionTimestamp(d: Date | string | null | undefined): string {
  if (!d) return 'unknown time';
  const date = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return 'unknown time';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
