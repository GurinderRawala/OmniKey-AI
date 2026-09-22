import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('child_process', () => ({ execFile: mocks.execFile }));
import { protectEmptyCheckpoint } from '../agent/agentServer/checkpointPermissions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Windows checkpoint privacy', () => {
  it('applies and verifies the owner-only DACL using a literal path, not shell interpolation', async () => {
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(null));
    const file = "C:\\Users\\O'Brien\\.omnikey\\session.tmp";
    await protectEmptyCheckpoint(file, 'win32');
    const [command, args, options] = mocks.execFile.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args.at(-1)).toContain('SetAccessRuleProtection($true, $false)');
    expect(args.at(-1)).toContain('GetAccessRules');
    expect(args.at(-1)).toContain('$rules.Count -ne 1');
    expect(args.at(-1)).not.toContain(file);
    expect(options.env.OMNIKEY_CHECKPOINT_FILE).toBe(file);
    expect(options.timeout).toBe(10000);
  });

  it('fails closed when ACL enforcement or verification fails', async () => {
    mocks.execFile.mockImplementation((_command, _args, _options, callback) =>
      callback(new Error('ACL failure')),
    );
    await expect(protectEmptyCheckpoint('C:\\session.tmp', 'win32')).rejects.toThrow(
      'private Windows checkpoint permissions',
    );
  });

  it('uses native mode permissions on Unix without launching PowerShell', async () => {
    await protectEmptyCheckpoint('/tmp/session.tmp', 'darwin');
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
