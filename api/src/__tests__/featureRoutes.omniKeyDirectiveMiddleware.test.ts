import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamComplete: vi.fn(),
  getAgentSettings: vi.fn(),
  selectedAgentModelForProvider: vi.fn(),
  recordTokenUsage: vi.fn(),
}));

vi.mock('../ai-client', () => ({
  aiClient: { streamComplete: mocks.streamComplete },
  getFixedHelperModel: vi.fn(),
}));

vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: mocks.getAgentSettings,
  selectedAgentModelForProvider: mocks.selectedAgentModelForProvider,
}));

vi.mock('../usageRecorder', () => ({
  recordTokenUsage: mocks.recordTokenUsage,
}));

import { omniKeyDirectiveMiddleware } from '../featureRoutes';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

async function run(text: unknown) {
  const req = { body: { text }, header: vi.fn(() => undefined) } as any;
  const res = {
    locals: { logger: makeLogger(), subscription: { id: 'sub-1' } },
    json: vi.fn(),
    status: vi.fn().mockReturnThis(),
  } as any;
  const next = vi.fn();

  await omniKeyDirectiveMiddleware(req, res, next);

  return { req, res, next };
}

beforeEach(() => {
  mocks.streamComplete.mockReset();
  mocks.streamComplete.mockImplementation(async (_model, _messages, _options, onDelta) => {
    onDelta('<improved_text>done</improved_text>');
    return { usage: { total_tokens: 3 } };
  });
  mocks.getAgentSettings.mockReset();
  mocks.getAgentSettings.mockResolvedValue({ id: 'default' });
  mocks.selectedAgentModelForProvider.mockReset();
  mocks.selectedAgentModelForProvider.mockReturnValue('stored-openai-agent-model');
  mocks.recordTokenUsage.mockReset();
});

describe('omniKeyDirectiveMiddleware', () => {
  it('handles a case-insensitive directive in middleware and does not call next', async () => {
    const { res, next } = await run('Source text\n@OmniKeyAI: summarize it in one sentence');

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ result: 'done' });
    const [, messages] = mocks.streamComplete.mock.calls[0];
    expect(messages[1].content).toContain(
      '<omnikeyai_directive>\nsummarize it in one sentence\n</omnikeyai_directive>',
    );
    expect(messages[1].content).toContain('<context>\nSource text\n</context>');
  });

  it('supports a directive at the start without a colon', async () => {
    const { next } = await run('@omnikeyai explain quantum computing');

    expect(next).not.toHaveBeenCalled();
    const [, messages] = mocks.streamComplete.mock.calls[0];
    expect(messages[1].content).toContain(
      '<omnikeyai_directive>\nexplain quantum computing\n</omnikeyai_directive>',
    );
    expect(messages[1].content).toContain('<context>\n\n</context>');
  });

  it('passes through to feature handlers for empty or embedded mentions', async () => {
    expect((await run('email support@omnikeyai.com')).next).toHaveBeenCalledOnce();
    expect((await run('@omnikeyai:   ')).next).toHaveBeenCalledOnce();
    expect(mocks.streamComplete).not.toHaveBeenCalled();
  });
});
