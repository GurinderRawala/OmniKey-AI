import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { SessionState } from '../agent/types';

const mocks = vi.hoisted(() => ({
  configPath: '',
  log: { info: vi.fn(), warn: vi.fn() },
  protect: vi.fn(async (_file: string): Promise<void> => undefined),
}));
vi.mock('../agent/agentServer/checkpointPermissions', () => ({
  protectEmptyCheckpoint: mocks.protect,
}));
vi.mock('../localConfigFile', () => ({ getLocalConfigPath: () => mocks.configPath }));
import {
  deleteSessionCheckpoint,
  restoreSessionCheckpoint,
  saveSessionCheckpoint,
  sessionCheckpointPath,
} from '../agent/agentServer/sessionCheckpoint';

let temporaryRoot: string;
const log = mocks.log as any;
function state(): SessionState {
  return {
    subscription: { id: 'account' } as any,
    turns: 1,
    history: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'Fix a bug' },
      { role: 'assistant', content: 'Found the bug' },
    ],
    sessionMemory: '## Goal\nFix a bug.\n\n## Findings\nLocated the bug.',
    sessionMemoryHistoryLength: 3,
    sessionMemoryUpdatedAt: new Date(),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'omnikey-checkpoint-test-'));
  mocks.configPath = path.join(temporaryRoot, 'config.json');
});
afterEach(async () => {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
});

describe('session Markdown checkpoints', () => {
  it('never writes content or publishes a file before permissions are verified', async () => {
    mocks.protect.mockImplementationOnce(async (file) => {
      expect(await fs.readFile(file, 'utf8')).toBe('');
      throw new Error('Windows ACL verification failed');
    });
    await saveSessionCheckpoint('session', state(), log);
    const file = sessionCheckpointPath('account', 'session');
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.dirname(file))).toEqual([]);
    expect(mocks.log.warn).toHaveBeenCalled();
  });
  it('writes a private Markdown file and restores matching context without replaying it as extra history', async () => {
    const original = state();
    await saveSessionCheckpoint('session', original, log);
    const file = sessionCheckpointPath('account', 'session');
    expect(await fs.readFile(file, 'utf8')).toContain('## Goal\nFix a bug.');
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    const resumed = state();
    resumed.sessionMemory = null;
    resumed.history[0].content = 'refreshed system';
    resumed.history.push({ role: 'user', content: 'Continue' });
    await restoreSessionCheckpoint('session', resumed, log);
    expect(resumed.sessionMemory).toBe(original.sessionMemory);
    expect(resumed.sessionMemoryHistoryLength).toBe(3);
    expect(resumed.history).toHaveLength(4);
    expect(mocks.log.info).toHaveBeenCalled();
  });

  it('does not overwrite database memory or import a different history', async () => {
    await saveSessionCheckpoint('session', state(), log);
    const authoritative = state();
    authoritative.sessionMemory = 'newer database memory';
    await restoreSessionCheckpoint('session', authoritative, log);
    expect(authoritative.sessionMemory).toBe('newer database memory');
    const changed = state();
    changed.sessionMemory = null;
    changed.history[1].content = 'Different task';
    await restoreSessionCheckpoint('session', changed, log);
    expect(changed.sessionMemory).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('isolates accounts and prevents ID path traversal', async () => {
    const first = sessionCheckpointPath('account', '../../escape');
    const other = sessionCheckpointPath('other-account', '../../escape');
    expect(first.startsWith(path.join(temporaryRoot, 'session-context') + path.sep)).toBe(true);
    expect(first).not.toBe(other);
    await saveSessionCheckpoint('session', state(), log);
    const otherState = state();
    otherState.subscription = { id: 'other-account' } as any;
    otherState.sessionMemory = null;
    await restoreSessionCheckpoint('session', otherState, log);
    expect(otherState.sessionMemory).toBeNull();
  });

  it.each(['corrupt', 'oversized', 'modified'])(
    'ignores %s checkpoints without interrupting the session',
    async (kind) => {
      await saveSessionCheckpoint('session', state(), log);
      const file = sessionCheckpointPath('account', 'session');
      const text =
        kind === 'corrupt'
          ? 'invalid'
          : kind === 'oversized'
            ? 'x'.repeat(40_000)
            : (await fs.readFile(file, 'utf8')).replace('Located the bug.', 'Invented a result.');
      await fs.writeFile(file, text);
      const resumed = state();
      resumed.sessionMemory = null;
      await expect(restoreSessionCheckpoint('session', resumed, log)).resolves.toBeUndefined();
      expect(resumed.sessionMemory).toBeNull();
    },
  );

  it('tolerates missing/unwritable files and skips transient helper sessions', async () => {
    const resumed = state();
    resumed.sessionMemory = null;
    await restoreSessionCheckpoint('missing', resumed, log);
    expect(mocks.log.warn).not.toHaveBeenCalled();
    await fs.writeFile(path.join(temporaryRoot, 'session-context'), 'not a directory');
    await expect(saveSessionCheckpoint('session', state(), log)).resolves.toBeUndefined();
    expect(mocks.log.warn).toHaveBeenCalled();
    mocks.log.warn.mockClear();
    await saveSessionCheckpoint('grouping-account', state(), log);
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it('does not follow checkpoint symlinks and deletes only the requested checkpoint', async () => {
    await saveSessionCheckpoint('session', state(), log);
    await saveSessionCheckpoint('other', state(), log);
    const file = sessionCheckpointPath('account', 'session');
    const other = sessionCheckpointPath('account', 'other');
    await fs.unlink(file);
    await fs.symlink(other, file);
    const resumed = state();
    resumed.sessionMemory = null;
    await restoreSessionCheckpoint('session', resumed, log);
    expect(resumed.sessionMemory).toBeNull();
    await deleteSessionCheckpoint('account', 'session', log);
    expect(await fs.readFile(other, 'utf8')).toContain('## Goal');
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
