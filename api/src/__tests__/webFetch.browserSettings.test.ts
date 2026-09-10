import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  fetchWithPlaywright: vi.fn(),
  getAgentSettings: vi.fn(),
  isBrowserOpenWithUrl: vi.fn(),
  isPageAuthenticated: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: mocks.axiosGet,
    post: vi.fn(),
    isAxiosError: vi.fn(() => false),
  },
}));

vi.mock('../config', () => ({
  config: {
    isSelfHosted: true,
    terminalPlatform: 'macos',
    serperApiKey: undefined,
    braveSearchApiKey: undefined,
    tavilyApiKey: undefined,
    searxngUrl: undefined,
  },
}));

vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: mocks.getAgentSettings,
}));

vi.mock('../web-search/browser-playwright', () => ({
  fetchWithPlaywright: mocks.fetchWithPlaywright,
  isBrowserOpenWithUrl: mocks.isBrowserOpenWithUrl,
}));

vi.mock('../web-search/llm-auth-check', () => ({
  isPageAuthenticated: mocks.isPageAuthenticated,
}));

import { executeTool } from '../web-search/web-search-provider';
import { logger } from '../logger';

describe('web_fetch DB-backed browser method', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.axiosGet.mockResolvedValue({
      data: '<html><body>Sign in to continue</body></html>',
      request: { res: { responseUrl: 'https://example.test/private' } },
    });
    mocks.isPageAuthenticated.mockResolvedValue(false);
    mocks.fetchWithPlaywright.mockResolvedValue('authenticated live-tab content');
  });

  it('passes the database-selected JavaScript Events settings to live-tab fetch', async () => {
    const settings = {
      browserAccessEnabled: true,
      browserAccessMethod: 'javascript-events',
      browserDebugPort: null,
      browserJavascriptEventBrowsers: ['Chrome'],
    };
    mocks.getAgentSettings.mockResolvedValue(settings);

    const result = await executeTool('web_fetch', { url: 'https://example.test/private' }, logger);

    expect(result).toBe('authenticated live-tab content');
    expect(mocks.fetchWithPlaywright).toHaveBeenCalledWith(
      'https://example.test/private',
      logger,
      settings,
    );
  });

  it('tries the configured live tab when a private page disguises auth as 404', async () => {
    const settings = {
      browserAccessEnabled: true,
      browserAccessMethod: 'javascript-events',
      browserDebugPort: null,
      browserJavascriptEventBrowsers: ['Chrome'],
    };
    mocks.getAgentSettings.mockResolvedValue(settings);
    mocks.axiosGet.mockRejectedValueOnce(new Error('Request failed with status code 404'));

    const result = await executeTool(
      'web_fetch',
      { url: 'https://example.test/private-pr' },
      logger,
    );

    expect(result).toBe('authenticated live-tab content');
    expect(mocks.fetchWithPlaywright).toHaveBeenCalledWith(
      'https://example.test/private-pr',
      logger,
      settings,
    );
    expect(mocks.isBrowserOpenWithUrl).not.toHaveBeenCalled();
  });

  it('returns an explicit error when authenticated live-tab extraction is empty', async () => {
    mocks.getAgentSettings.mockResolvedValue({
      browserAccessEnabled: true,
      browserAccessMethod: 'javascript-events',
      browserDebugPort: null,
      browserJavascriptEventBrowsers: ['Chrome'],
    });
    mocks.axiosGet.mockRejectedValueOnce(new Error('Request failed with status code 404'));
    mocks.fetchWithPlaywright.mockResolvedValueOnce(null);

    const result = await executeTool(
      'web_fetch',
      { url: 'https://example.test/private-pr' },
      logger,
    );

    expect(result).toBe('Error fetching URL: authenticated browser access returned no content');
  });
});
