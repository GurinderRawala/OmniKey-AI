import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getEngagementPath, recordEnhancement } from '../engagementCounter';

let tmpDir: string;
const originalEnv = { ...process.env };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-engagement-'));
  process.env.OMNIKEY_ENGAGEMENT_PATH = path.join(tmpDir, '.omnikey', 'engagement.json');
  delete process.env.OMNIKEY_NO_NAG;
});

afterEach(() => {
  process.env = { ...originalEnv };
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readCount(): number {
  return JSON.parse(fs.readFileSync(getEngagementPath(), 'utf8')).enhancements;
}

describe('engagementCounter', () => {
  it('creates the state file on first enhancement', () => {
    expect(fs.existsSync(getEngagementPath())).toBe(false);
    recordEnhancement();
    expect(readCount()).toBe(1);
  });

  it('increments monotonically across calls', () => {
    for (let i = 0; i < 10; i++) recordEnhancement();
    expect(readCount()).toBe(10);
  });

  it('does nothing when OMNIKEY_NO_NAG is set', () => {
    process.env.OMNIKEY_NO_NAG = '1';
    recordEnhancement();
    expect(fs.existsSync(getEngagementPath())).toBe(false);
  });

  it('recovers from a corrupt state file instead of throwing', () => {
    fs.mkdirSync(path.dirname(getEngagementPath()), { recursive: true });
    fs.writeFileSync(getEngagementPath(), 'not json at all');
    expect(() => recordEnhancement()).not.toThrow();
    expect(readCount()).toBe(1);
  });

  it('never throws when the path is unwritable', () => {
    process.env.OMNIKEY_ENGAGEMENT_PATH = '/proc/definitely/not/writable/engagement.json';
    expect(() => recordEnhancement()).not.toThrow();
  });

  it('writes the file with owner-only permissions', () => {
    recordEnhancement();
    const mode = fs.statSync(getEngagementPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
