import { buildAbsolutePathRegex, stripUrls, tildeExpand } from './pathExtraction';
import { trimToProjectRoot } from './trimToProjectRoot';

/**
 * Extract the dominant project root path from a slab of user-typed text.
 * Returns `null` when no plausible local project path is referenced.
 *
 * The pipeline is:
 *   1. Tilde-expand `~/...` to `$HOME/...` so a user-typed `~/foo` is
 *      treated the same as `/Users/<name>/foo`.
 *   2. Strip URL-shaped tokens BEFORE running the path regex so a URL
 *      never contributes a project-root vote.
 *   3. Match remaining text against the unbounded absolute-path regex.
 *   4. Strip trailing sentence punctuation from each captured path.
 *   5. Normalise each path via trimToProjectRoot (drops trailing file
 *      segments, walks up through src/lib/dist/..., rejects non-local
 *      paths).
 *   6. Count DIRECT votes per normalised root. We deliberately do NOT roll
 *      up votes to ancestors — that's how the user's home directory or an
 *      enclosing parent repo used to beat the actual project.
 *   7. Pick the candidate with the most votes. Ties go to the DEEPER path
 *      because the longer one is the most-specific common reference and
 *      is more likely the project root the user means.
 */
export function extractProjectPath(texts: string[]): string | null {
  const combined = stripUrls(tildeExpand(texts.join(' ')));

  const pathRe = buildAbsolutePathRegex();
  const rawMatches = Array.from(combined.matchAll(pathRe), (m) => m[1])
    // Strip trailing sentence punctuation that the regex greedily included
    // (e.g. "see /Users/x/MyApp/cli, please edit ..." → /Users/x/MyApp/cli).
    .map((raw) => raw.replace(/[.,;:!?)\]]+$/, ''))
    .filter((raw) => raw.length > 1);
  if (!rawMatches.length) return null;

  const normalised: string[] = [];
  for (const raw of rawMatches) {
    const trimmed = trimToProjectRoot(raw);
    if (trimmed) normalised.push(trimmed);
  }
  if (!normalised.length) return null;

  const directVotes = new Map<string, number>();
  for (const path of normalised) {
    directVotes.set(path, (directVotes.get(path) ?? 0) + 1);
  }

  const entries = Array.from(directVotes.entries()).sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0].split('/').length - a[0].split('/').length;
  });

  // winner came from `normalised`, which is itself a list of
  // trimToProjectRoot outputs, so the path is already in canonical form.
  return entries[0][0];
}
