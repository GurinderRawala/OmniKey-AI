import fs from 'fs';
import path from 'path';
import { getConfigDir } from './utils';

/**
 * Lightweight, local-only engagement state used to show a single, opt-out
 * "star the repo" nudge once a user has gotten real value out of OmniKey.
 *
 * Nothing here leaves the machine. The file lives next to config.json.
 */

const REPO_URL = 'https://github.com/GurinderRawala/OmniKey-AI';
const DISCUSSIONS_URL = 'https://github.com/GurinderRawala/OmniKey-AI/discussions';

/** Enhancement counts at which a nudge is shown (at most once each). */
const MILESTONES = [10, 100] as const;

export type EngagementState = {
  enhancements: number;
  milestonesShown: number[];
};

const EMPTY: EngagementState = { enhancements: 0, milestonesShown: [] };

export function getEngagementPath(): string {
  return path.join(getConfigDir(), 'engagement.json');
}

/** True when the user has opted out of all nudges. */
export function nudgesDisabled(): boolean {
  const flag = process.env.OMNIKEY_NO_NAG;
  return flag === '1' || flag === 'true';
}

export function readEngagement(): EngagementState {
  try {
    const raw = fs.readFileSync(getEngagementPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<EngagementState>;
    return {
      enhancements: Number(parsed.enhancements) || 0,
      milestonesShown: Array.isArray(parsed.milestonesShown)
        ? parsed.milestonesShown.map(Number).filter((n) => Number.isFinite(n))
        : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function writeEngagement(state: EngagementState): void {
  try {
    const dir = getConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(getEngagementPath(), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // Never let telemetry-free bookkeeping break a command.
  }
}

/**
 * Returns the milestone that has been reached but not yet acknowledged,
 * or null when there is nothing to show.
 */
export function pendingMilestone(state: EngagementState = readEngagement()): number | null {
  if (nudgesDisabled()) return null;
  const due = MILESTONES.filter(
    (m) => state.enhancements >= m && !state.milestonesShown.includes(m),
  );
  return due.length > 0 ? due[due.length - 1] : null;
}

export function acknowledgeMilestone(milestone: number): void {
  const state = readEngagement();
  if (!state.milestonesShown.includes(milestone)) {
    state.milestonesShown.push(milestone);
    writeEngagement(state);
  }
}

export function renderStarPrompt(milestone: number): string {
  const noun = milestone === 1 ? 'enhancement' : 'enhancements';
  return [
    '',
    `  ✨ You have run ${milestone} ${noun} with OmniKey.`,
    `     If it saved you time, a star genuinely helps: ${REPO_URL}`,
    `     Ideas, bugs, or MCP recipes: ${DISCUSSIONS_URL}`,
    '     (silence this with OMNIKEY_NO_NAG=1)',
    '',
  ].join('\n');
}

/** Prints the nudge at most once per milestone. Safe to call from any command. */
export function maybeShowStarPrompt(): void {
  const milestone = pendingMilestone();
  if (milestone === null) return;
  console.log(renderStarPrompt(milestone));
  acknowledgeMilestone(milestone);
}

/** Shown unconditionally at the end of onboarding. */
export function renderWelcomeCta(): string {
  return [
    '',
    '  OmniKey is free and MIT licensed.',
    `  ⭐ Star the repo:   ${REPO_URL}`,
    `  💬 Ask / suggest:  ${DISCUSSIONS_URL}`,
    '',
  ].join('\n');
}
