import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mocks.execFileSync,
  execSync: mocks.execSync,
}));

vi.mock('../config', () => ({
  config: {
    terminalPlatform: 'macos',
  },
}));

import {
  browserTabUrlMatches,
  fetchWithPlaywright,
  isBrowserOpenWithUrl,
} from '../web-search/browser-playwright';

describe('JavaScript Events browser tab detection', () => {
  beforeAll(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execSync.mockImplementation((command: string) => {
      if (command === 'ps -axco command') return 'Google Chrome\n';
      throw new Error(`Unexpected command: ${command}`);
    });
    mocks.execFileSync.mockImplementation((command: string, args: string[]) => {
      if (command === 'osascript') {
        const script = String(args[3]);
        if (script.includes('tab.execute({ javascript: expression })')) {
          return JSON.stringify({
            found: true,
            content: 'authenticated private pull request content '.repeat(10),
            windowIndex: 1,
            tabIndex: 2,
          });
        }
        return JSON.stringify([
          'https://linear.app/example/issue',
          'https://github.com/example/private/pull/42',
          'https://example.com/a,url,with,commas',
        ]);
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it('matches the exact URL including query parameters and ignores fragments', () => {
    expect(
      browserTabUrlMatches(
        'https://github.com/example/private/pull/4?view=files#discussion',
        'https://github.com/example/private/pull/4?view=files#top',
      ),
    ).toBe(true);
    expect(
      browserTabUrlMatches(
        'https://github.com/example/private/pull/4',
        'https://github.com/example/private/pull/42',
      ),
    ).toBe(false);
    expect(
      browserTabUrlMatches(
        'https://github.com/example/private/pull/4?view=files',
        'https://github.com/example/private/pull/4?view=conversation',
      ),
    ).toBe(false);
  });

  it('finds a target in a non-first Chrome tab', async () => {
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;

    const found = await isBrowserOpenWithUrl('https://github.com/example/private/pull/42', log, {
      browserAccessMethod: 'javascript-events',
      browserDebugPort: null,
      browserJavascriptEventBrowsers: ['Chrome'],
    });

    expect(found).toBe(true);
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-l', 'JavaScript', '-e']),
      expect.any(Object),
    );
    const jxaScript = String(mocks.execFileSync.mock.calls[0]?.[1]?.[3]);
    expect(jxaScript).toContain('browser.windows().flatMap');
    expect(jxaScript).toContain('window.tabs().map');
  });

  it('extracts authenticated content from the same JXA-discovered tab', async () => {
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as any;

    const content = await fetchWithPlaywright('https://github.com/example/private/pull/42', log, {
      browserAccessMethod: 'javascript-events',
      browserDebugPort: null,
      browserJavascriptEventBrowsers: ['Chrome'],
    });

    expect(content).toContain('authenticated private pull request content');
    const extractionScript = mocks.execFileSync.mock.calls
      .map(([, args]) => String(args[3]))
      .find((script) => script.includes('tab.execute({ javascript: expression })'));
    expect(extractionScript).toContain('browserWindow.activeTabIndex = tabIndex + 1');
  });
});
