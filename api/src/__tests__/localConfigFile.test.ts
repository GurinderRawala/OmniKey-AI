import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLocalConfigPath, writeLocalConfigJson } from '../localConfigFile';

describe('localConfigFile', () => {
  let tmpDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalOmnikeyConfigPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-local-config-'));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalOmnikeyConfigPath = process.env.OMNIKEY_CONFIG_PATH;
    delete process.env.OMNIKEY_CONFIG_PATH;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalOmnikeyConfigPath === undefined) delete process.env.OMNIKEY_CONFIG_PATH;
    else process.env.OMNIKEY_CONFIG_PATH = originalOmnikeyConfigPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('prefers OMNIKEY_CONFIG_PATH over HOME and USERPROFILE', () => {
    const customPath = path.join(tmpDir, 'daemon', 'config.json');
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.USERPROFILE = path.join(tmpDir, 'profile');
    process.env.OMNIKEY_CONFIG_PATH = customPath;

    expect(getLocalConfigPath()).toBe(customPath);
  });

  it('falls back to HOME before USERPROFILE', () => {
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.USERPROFILE = path.join(tmpDir, 'profile');

    expect(getLocalConfigPath()).toBe(path.join(process.env.HOME, '.omnikey', 'config.json'));
  });

  it('uses USERPROFILE when HOME is not available', () => {
    delete process.env.HOME;
    process.env.USERPROFILE = path.join(tmpDir, 'profile');

    expect(getLocalConfigPath()).toBe(
      path.join(process.env.USERPROFILE, '.omnikey', 'config.json'),
    );
  });

  it('writes JSON to the resolved custom path only', () => {
    const customPath = path.join(tmpDir, 'daemon', 'config.json');
    const defaultPath = path.join(tmpDir, 'home', '.omnikey', 'config.json');
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.OMNIKEY_CONFIG_PATH = customPath;

    writeLocalConfigJson({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'file-key' });

    expect(JSON.parse(fs.readFileSync(customPath, 'utf-8'))).toEqual({
      AI_PROVIDER: 'anthropic',
      ANTHROPIC_API_KEY: 'file-key',
    });
    expect(fs.existsSync(defaultPath)).toBe(false);
  });

  it('resolves macOS and Windows daemon-generated config paths', () => {
    const macConfigPath = path.join(tmpDir, 'mac-home', '.omnikey', 'config.json');
    const windowsConfigPath = path.join(tmpDir, 'win-home', '.omnikey', 'config.json');
    const runtimeEnvs = [
      {
        HOME: path.join(tmpDir, 'mac-home'),
        OMNIKEY_CONFIG_PATH: macConfigPath,
        platform: 'macos',
        USERPROFILE: path.join(tmpDir, 'mac-profile'),
      },
      {
        HOME: path.join(tmpDir, 'win-home'),
        OMNIKEY_CONFIG_PATH: windowsConfigPath,
        platform: 'windows',
        USERPROFILE: path.join(tmpDir, 'win-home'),
      },
    ];

    for (const runtimeEnv of runtimeEnvs) {
      process.env.HOME = runtimeEnv.HOME;
      process.env.USERPROFILE = runtimeEnv.USERPROFILE;
      process.env.OMNIKEY_CONFIG_PATH = runtimeEnv.OMNIKEY_CONFIG_PATH;
      expect(getLocalConfigPath()).toBe(runtimeEnv.OMNIKEY_CONFIG_PATH);
    }
  });
});
