import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock('../ai-client', () => ({
  aiClient: { complete: mocks.complete, getProvider: () => 'openai' },
  getFixedHelperModel: () => 'helper-model',
}));
import { isPageAuthenticated } from '../web-search/llm-auth-check';
const log = { info: vi.fn(), error: vi.fn() } as any;
const url = 'https://app.example.com/analytics';
beforeEach(() => {
  mocks.complete.mockReset();
});
describe('web auth helper output budget', () => {
  it('uses a provider-valid budget for a one-word answer', async () => {
    mocks.complete.mockImplementation(async (_model, _messages, options) => {
      if (options.maxTokens < 16) throw new Error('max_output_tokens must be >= 16');
      return { content: 'yes', finish_reason: 'stop' };
    });
    expect(await isPageAuthenticated('Dashboard contents', url, log)).toBe(true);
    expect(mocks.complete).toHaveBeenCalledWith(
      'helper-model',
      expect.any(Array),
      expect.objectContaining({ maxTokens: 16 }),
    );
  });
  it.each(['no', 'yes, but actually a login page', ''])(
    'does not accept ambiguous or negative answer %j',
    async (content) => {
      mocks.complete.mockResolvedValue({ content });
      expect(await isPageAuthenticated('Sign in', url, log)).toBe(false);
    },
  );
  it('keeps the existing browser fallback on provider failure', async () => {
    mocks.complete.mockRejectedValue(new Error('unavailable'));
    expect(await isPageAuthenticated('Page', url, log)).toBe(false);
  });
  it('does not call the helper for known public pages or login redirects', async () => {
    expect(await isPageAuthenticated('Docs', 'https://docs.example.com/start', log)).toBe(true);
    expect(await isPageAuthenticated('Login', url, log, 'https://app.example.com/login')).toBe(
      false,
    );
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it('rejects a truncated affirmative response', async () => {
    mocks.complete.mockResolvedValue({ content: 'yes', finish_reason: 'length' });
    expect(await isPageAuthenticated('Page', url, log)).toBe(false);
  });
});
