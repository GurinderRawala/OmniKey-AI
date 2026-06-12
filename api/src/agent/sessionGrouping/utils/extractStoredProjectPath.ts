import { trimToProjectRoot } from './trimToProjectRoot';

/**
 * Recover the project root path from a previously-stored group description.
 * Descriptions written by this module start with `Project root: <abs path>.`
 * so we just need to grab that span and run it through the same
 * normalisation as fresh inputs.
 *
 * Returns `null` when the description has no `Project root:` sentence OR
 * when the stored path fails normalisation (e.g. a stored URL-shaped
 * pseudo-path from before the URL-rejection landed). In the latter case
 * we explicitly want callers to treat the description as "no stored path"
 * so the LLM/cron get a chance to rewrite it with a real root.
 */
export function extractStoredProjectPath(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = /Project root:\s*(\/[^\s.,;:!?)<>"'`]+)/i.exec(description);
  if (!match) return null;
  return trimToProjectRoot(match[1]);
}
