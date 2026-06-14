import { extractStoredProjectPath } from './extractStoredProjectPath';

/**
 * Pick the existing group whose stored project root EXACTLY equals the
 * current session's extracted project root. Equality is intentional —
 * ancestor or descendant matches do NOT count, because the original bug
 * was a session inside `/Users/me/Repo/cli` auto-merging into a group
 * whose stored root was the parent `/Users/me/Repo`.
 */
export function findGroupByExactPath(
  currentPath: string | null,
  existingGroups: Array<{ groupName: string; groupDescription: string | null }>,
): { groupName: string; groupDescription: string } | null {
  if (!currentPath) return null;
  for (const g of existingGroups) {
    const stored = extractStoredProjectPath(g.groupDescription);
    if (stored && stored === currentPath) {
      return {
        groupName: g.groupName,
        groupDescription: g.groupDescription ?? '',
      };
    }
  }
  return null;
}
