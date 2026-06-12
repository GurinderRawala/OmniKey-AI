import {
  HOME_CONTAINER_SEGMENTS,
  HOME_ROOT_SEGMENTS,
  NON_ROOT_SEGMENTS,
  firstSegmentLooksLikeDomain,
  isLocalLookingPath,
  looksLikeFile,
} from './pathExtraction';

/**
 * Normalise a raw absolute path candidate to a likely project root, or
 * return `null` if the candidate is not a plausible local project root.
 *
 * The normalisation:
 *   - Rejects URL-shaped pseudo-paths whose first segment is a domain.
 *   - Rejects paths that don't start with a known local-computer prefix
 *     (`/Users/<x>/`, `/home/<x>/`, `/opt/<x>/`, `/Volumes/<vol>/`, ...).
 *   - Strips a trailing file segment when present.
 *   - Walks up through known non-root subdirs (`src`, `lib`, `dist`,
 *     `__tests__`, `node_modules`, …).
 *   - Bails when only the home-directory chain (`/Users/<x>`,
 *     `/Users/<x>/Documents`, …) remains, since those are not projects.
 */
export function trimToProjectRoot(path: string): string | null {
  let parts = path.split('/').filter(Boolean);
  // Belt: URL-shaped pseudo-paths up front.
  if (parts.length > 0 && firstSegmentLooksLikeDomain(parts[0])) {
    return null;
  }
  // Allow-list: only paths rooted under a known local-computer prefix.
  if (!isLocalLookingPath('/' + parts.join('/'))) {
    return null;
  }
  // Strip a trailing file segment, if any.
  if (parts.length && looksLikeFile(parts[parts.length - 1])) {
    parts = parts.slice(0, -1);
  }
  // Walk up while the deepest segment is a non-root folder (src, lib, dist, ...).
  while (parts.length > 1 && NON_ROOT_SEGMENTS.has(parts[parts.length - 1].toLowerCase())) {
    parts = parts.slice(0, -1);
  }
  // Require at least one segment past the home-root + username + container chain.
  let firstProjectIdx = 0;
  if (parts.length > 0 && HOME_ROOT_SEGMENTS.has(parts[0].toLowerCase())) {
    firstProjectIdx = Math.min(2, parts.length);
  }
  while (
    firstProjectIdx < parts.length &&
    HOME_CONTAINER_SEGMENTS.has(parts[firstProjectIdx].toLowerCase())
  ) {
    firstProjectIdx++;
  }
  if (firstProjectIdx >= parts.length) return null;
  if (parts.length < 2) return null;
  return '/' + parts.join('/');
}
