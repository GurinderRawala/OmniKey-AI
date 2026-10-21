import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Counts successful enhancements in a local file so the CLI can show a single
 * "star the repo" nudge at a milestone. Local only: nothing is transmitted,
 * and no content of any kind is recorded — just an integer.
 */

export function getEngagementPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return process.env.OMNIKEY_ENGAGEMENT_PATH || path.join(home, '.omnikey', 'engagement.json');
}

export function recordEnhancement(): void {
  if (process.env.OMNIKEY_NO_NAG === '1' || process.env.OMNIKEY_NO_NAG === 'true') return;

  try {
    const filePath = getEngagementPath();
    let state: { enhancements: number; milestonesShown: number[] } = {
      enhancements: 0,
      milestonesShown: [],
    };

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      state = {
        enhancements: Number(parsed?.enhancements) || 0,
        milestonesShown: Array.isArray(parsed?.milestonesShown) ? parsed.milestonesShown : [],
      };
    } catch {
      // first run, or unreadable file: start from zero
    }

    state.enhancements += 1;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // Counting must never affect the request path.
  }
}
