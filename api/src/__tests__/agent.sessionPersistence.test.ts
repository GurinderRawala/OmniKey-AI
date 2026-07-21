import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const log = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    child: vi.fn(),
  };

  return {
    log,
    agentSession: {
      count: vi.fn(),
      destroy: vi.fn(),
      findAll: vi.fn(),
      findOne: vi.fn(),
      findOrCreate: vi.fn(),
      increment: vi.fn(),
      update: vi.fn(),
    },
    complete: vi.fn(),
    executeTool: vi.fn(),
  };
});

mocks.log.child.mockReturnValue(mocks.log);

vi.mock('../logger', () => ({ logger: mocks.log }));

vi.mock('../models/agentSession', () => ({
  AgentSession: mocks.agentSession,
}));

vi.mock('../models/subscription', () => ({
  Subscription: { increment: vi.fn() },
}));

vi.mock('../models/subscriptionUsage', () => ({
  SubscriptionUsage: { create: vi.fn() },
}));

vi.mock('../agent/agentPrompts', () => ({
  getAgentPrompt: vi.fn(() => 'system prompt'),
}));

vi.mock('../agent/mcpPromptCache', () => ({
  getPromptMcpsForSubscription: vi.fn(async () => []),
}));

vi.mock('../agent/mcpRuntime', () => ({
  MCP_TOOL_PREFIX: 'mcp__',
  executeMcpTool: vi.fn(),
  getMcpToolsForSubscription: vi.fn(async () => ({ aiTools: [], dispatch: new Map() })),
}));

vi.mock('../featureRoutes', () => ({
  getDefaultTaskTemplateSnapshot: vi.fn(async () => null),
  getPromptForCommand: vi.fn(),
}));

vi.mock('../web-search/web-search-provider', () => ({
  WEB_FETCH_TOOL: {
    name: 'web_fetch',
    description: 'Fetch URL',
    parameters: { type: 'object', properties: {} },
  },
  WEB_SEARCH_TOOL: {
    name: 'web_search',
    description: 'Search web',
    parameters: { type: 'object', properties: {} },
  },
  executeTool: mocks.executeTool,
}));

vi.mock('../agent/agentAuth', () => ({
  createLazyAuthContext: vi.fn(),
}));

vi.mock('../authMiddleware', () => ({
  authMiddleware: vi.fn((_req, _res, next) => next()),
}));

vi.mock('../agent/imageTool', () => ({
  IMAGE_GENERATE_TOOL: {
    name: 'generate_image',
    description: 'Generate image',
    parameters: { type: 'object', properties: {} },
  },
  executeImageGenerationTool: vi.fn(),
}));

vi.mock('../agent/sessionGrouping', () => ({
  GROUPING_SESSION_PREFIX: 'grouping-',
  buildProjectContext: vi.fn(async () => null),
  updateSessionGroup: vi.fn(async () => undefined),
}));

vi.mock('../shellRunner', () => ({
  runScript: vi.fn(),
}));

vi.mock('../ai-client', () => ({
  aiClient: { complete: mocks.complete },
  estimateHistoryTokens: vi.fn((history: unknown[]) => JSON.stringify(history).length),
  getContextWindowSize: vi.fn(() => 128_000),
  getDefaultModel: vi.fn(() => 'test-model'),
  getInputTokenBudget: vi.fn(() => 100_000),
  getMaxMessageContentLength: vi.fn(() => 1_000_000),
  providerSupportsImageGeneration: vi.fn(() => false),
}));

import { runAgentTurn } from '../agent/agentServer';

function historyUpdateCalls() {
  return mocks.agentSession.update.mock.calls.filter(([values]) =>
    Object.prototype.hasOwnProperty.call(values, 'historyJson'),
  );
}

function parsedHistoryFromCall(call: unknown[]) {
  const [values] = call as [{ historyJson: string }];
  return JSON.parse(values.historyJson) as Array<{
    role: string;
    content: string;
    tool_name?: string;
  }>;
}

describe('agent session persistence checkpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.log.child.mockReturnValue(mocks.log);
    mocks.agentSession.findOne.mockResolvedValue(null);
    mocks.agentSession.findOrCreate.mockResolvedValue([{ id: 'session-1' }, true]);
    mocks.agentSession.update.mockResolvedValue([1]);
    mocks.agentSession.count.mockResolvedValue(1);
    mocks.agentSession.findAll.mockResolvedValue([]);
    mocks.agentSession.destroy.mockResolvedValue(0);
    mocks.agentSession.increment.mockResolvedValue([1]);
    mocks.executeTool.mockResolvedValue('tool result');
  });

  it('persists the first user turn before calling the model', async () => {
    mocks.complete.mockRejectedValueOnce(new Error('provider unavailable'));

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Please inspect the repo and fix the bug.',
        platform: 'macos',
      },
      vi.fn(),
      mocks.log as any,
      { skipGrouping: true },
    );

    const calls = mocks.agentSession.update.mock.calls;
    const firstHistoryCallIndex = calls.findIndex(([values]) =>
      Object.prototype.hasOwnProperty.call(values, 'historyJson'),
    );
    expect(firstHistoryCallIndex).toBeGreaterThanOrEqual(0);
    expect(mocks.agentSession.update.mock.invocationCallOrder[firstHistoryCallIndex]).toBeLessThan(
      mocks.complete.mock.invocationCallOrder[0],
    );

    const history = parsedHistoryFromCall(calls[firstHistoryCallIndex]);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Please inspect the repo and fix the bug.'),
        }),
      ]),
    );
    expect(history.find((msg) => msg.role === 'user')?.content).toContain('<user_input>');
  });

  it('persists completed tool-call batches before the follow-up model call', async () => {
    const toolCall = {
      id: 'call-1',
      name: 'web_search',
      arguments: { query: 'checkpoint regression' },
    };

    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [toolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [toolCall],
      })
      .mockRejectedValueOnce(new Error('provider unavailable after tools'));

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Use search, then continue.',
        platform: 'macos',
      },
      vi.fn(),
      mocks.log as any,
      { skipGrouping: true },
    );

    const calls = historyUpdateCalls();
    const toolCheckpointIndex = calls.findIndex((call) =>
      parsedHistoryFromCall(call).some(
        (msg) => msg.role === 'tool' && msg.tool_name === 'web_search',
      ),
    );

    expect(toolCheckpointIndex).toBeGreaterThanOrEqual(0);
    expect(
      mocks.agentSession.update.mock.invocationCallOrder[
        mocks.agentSession.update.mock.calls.indexOf(calls[toolCheckpointIndex])
      ],
    ).toBeLessThan(mocks.complete.mock.invocationCallOrder[1]);

    const history = parsedHistoryFromCall(calls[toolCheckpointIndex]);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', tool_calls: [toolCall] }),
        expect.objectContaining({
          role: 'tool',
          tool_name: 'web_search',
          content: 'tool result',
        }),
      ]),
    );
  });
});
