/**
 * Catch-all group names we refuse to create. A group must correspond to a
 * single real project; dumping unrelated sessions into a generic bucket like
 * "Other" or "General" is exactly the drift we want to avoid. When a session
 * does not clearly belong to a project it should be left UNGROUPED instead, so
 * a later pass (with more context, or after the user works in it again) can
 * classify it properly.
 */
const CATCH_ALL_WORDS = new Set([
  'other',
  'others',
  'misc',
  'miscellaneous',
  'general',
  'uncategorized',
  'uncategorised',
  'ungrouped',
  'none',
  'various',
  'unknown',
  'unsorted',
  'default',
  'temp',
  'temporary',
  'random',
  'stuff',
  'assorted',
]);

/**
 * True when `name` is (or begins with) a generic catch-all word — e.g. "Other",
 * "Other Projects", "Misc Scripts", "General", "Uncategorized". Real
 * project-derived names ("Grafana", "OmniKey Mac App") are not affected.
 */
export function isCatchAllGroupName(name: string | null | undefined): boolean {
  if (!name) return false;
  const words = name
    .trim()
    .toLowerCase()
    .replace(/[_\-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  return CATCH_ALL_WORDS.has(words[0]);
}
