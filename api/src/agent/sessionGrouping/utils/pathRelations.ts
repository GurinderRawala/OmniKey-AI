/**
 * `a` is an ancestor of `b` (or equal). Pure string comparison — assumes
 * both inputs are already absolute, normalised paths.
 */
export function isAncestorOrEqualPath(a: string, b: string): boolean {
  return a === b || b.startsWith(a.endsWith('/') ? a : a + '/');
}

/**
 * Two paths are "related" iff one is an ancestor of the other (in either
 * direction). Used by buildProjectContext to flag medium confidence when
 * the stored group root and the current input root are in the same tree
 * but at different depths.
 */
export function pathsRelated(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return isAncestorOrEqualPath(a, b) || isAncestorOrEqualPath(b, a);
}
