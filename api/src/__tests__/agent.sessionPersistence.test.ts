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
    runScript: vi.fn(),
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

vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: vi.fn(async () => ({
    id: 'default',
    terminalAccess: 'full',
    webSearchEnabled: true,
    usageRecordingEnabled: true,
    browserAccessEnabled: false,
    openaiModel: 'test-model',
    anthropicModel: 'test-model',
    geminiModel: 'test-model',
    nemotronModel: 'test-model',
  })),
  selectedAgentModelForProvider: vi.fn(() => 'test-model'),
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
  runScript: mocks.runScript,
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
import { pendingShellScripts } from '../agent/agentServer/runtimeState';

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

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition');
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
    mocks.runScript.mockResolvedValue({ output: 'script output', isError: false });
    pendingShellScripts.clear();
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

  it('refines verbose shell_script output before storing the tool result', async () => {
    const toolCall = {
      id: 'call-shell-1',
      name: 'shell_script',
      arguments: {
        script: 'printf "verbose test output"',
        filter_keywords: ['KEEP_ME', 'needle.spec.ts'],
      },
    };
    const noisyOutput = [
      ...Array.from({ length: 80 }, (_, index) => `noise before ${index}`),
      'KEEP_ME summary: selected result',
      'nearby context line',
      ...Array.from({ length: 80 }, (_, index) => `noise middle ${index}`),
      'needle.spec.ts:42 failed expectation',
      ...Array.from({ length: 80 }, (_, index) => `noise after ${index}`),
    ].join('\n');

    mocks.runScript.mockResolvedValueOnce({ output: noisyOutput, isError: false });
    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [toolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [toolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: {
          role: 'assistant',
          content: '<final_answer>\nShell output reviewed.\n</final_answer>',
        },
        content: '<final_answer>\nShell output reviewed.\n</final_answer>',
        finish_reason: 'stop',
        model: 'test-model',
      });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Run the verbose shell command.',
        platform: 'macos',
      },
      vi.fn(),
      mocks.log as any,
      { isCronJob: true, skipGrouping: true },
    );

    const histories = historyUpdateCalls().map(parsedHistoryFromCall);
    const toolMessage = histories
      .flat()
      .find((msg) => msg.role === 'tool' && msg.tool_name === 'shell_script');

    expect(toolMessage?.content).toContain('TERMINAL OUTPUT:');
    expect(toolMessage?.content).toContain('terminal output refined');
    expect(toolMessage?.content).toContain('KEEP_ME summary: selected result');
    expect(toolMessage?.content).toContain('needle.spec.ts:42 failed expectation');
    expect(toolMessage?.content).not.toContain('noise middle 40');
    expect(toolMessage?.content.length ?? 0).toBeLessThan(noisyOutput.length);
    expect(mocks.runScript).toHaveBeenCalledWith('printf "verbose test output"');
  });

  it('removes stale injected recovery prompts before appending a real follow-up', async () => {
    mocks.agentSession.findOne.mockResolvedValueOnce({
      id: 'session-1',
      historyJson: JSON.stringify([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '<user_input>\nOriginal task\n</user_input>' },
        { role: 'assistant', content: 'Work in progress.' },
        {
          role: 'user',
          content:
            'Web research is complete. The results are in the conversation above.\n\nNow respond.',
        },
        {
          role: 'user',
          content:
            'Your previous response exceeded the output length limit and was cut off.\n\nRespond immediately.',
        },
      ]),
      turns: 3,
      groupName: null,
      groupLocked: false,
    });

    mocks.complete.mockResolvedValueOnce({
      assistantMessage: {
        role: 'assistant',
        content: '<final_answer>\nRecovered.\n</final_answer>',
      },
      content: '<final_answer>\nRecovered.\n</final_answer>',
      finish_reason: 'stop',
      model: 'test-model',
    });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Please continue from where you got stuck.',
        platform: 'macos',
      },
      vi.fn(),
      mocks.log as any,
      { skipGrouping: true },
    );

    const history = parsedHistoryFromCall(historyUpdateCalls()[0]);
    expect(history.some((msg) => msg.content.startsWith('Web research is complete'))).toBe(false);
    expect(
      history.some((msg) =>
        msg.content.startsWith('Your previous response exceeded the output length limit'),
      ),
    ).toBe(false);
    expect(history.at(-1)).toEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Please continue from where you got stuck.'),
      }),
    );
  });

  it('recovers a length-truncated tool loop and continues tool work when requested', async () => {
    const firstToolCall = {
      id: 'call-1',
      name: 'web_search',
      arguments: { query: 'length regression' },
    };
    const recoveryToolCall = {
      id: 'call-2',
      name: 'web_search',
      arguments: { query: 'continue after length' },
    };
    const send = vi.fn();

    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [firstToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [firstToolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '' },
        content: '',
        finish_reason: 'length',
        model: 'test-model',
      })
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: 'Partial recovery output' },
        content: 'Partial recovery output',
        finish_reason: 'length',
        model: 'test-model',
      })
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [recoveryToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [recoveryToolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: {
          role: 'assistant',
          content: '<final_answer>\nRecovered and continued.\n</final_answer>',
        },
        content: '<final_answer>\nRecovered and continued.\n</final_answer>',
        finish_reason: 'stop',
        model: 'test-model',
      });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Search, then answer concisely.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    const histories = historyUpdateCalls().map(parsedHistoryFromCall);
    expect(
      histories.some((history) =>
        history.some((msg) => msg.content.startsWith('Web research is complete')),
      ),
    ).toBe(false);
    expect(
      histories.some((history) =>
        history.some((msg) => msg.content.includes('- a tool call, if you need to keep working')),
      ),
    ).toBe(true);
    expect(mocks.complete.mock.calls[2]?.[2]).toHaveProperty('tools');
    expect(mocks.complete.mock.calls[3]?.[2]).toHaveProperty('tools');
    expect(mocks.executeTool).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('Recovered and continued.')),
    ).toBe(true);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('hit the output limit')),
    ).toBe(false);
  });

  it('executes complete tool calls returned with a length finish reason', async () => {
    const toolCall = {
      id: 'call-1',
      name: 'web_search',
      arguments: { query: 'parsed tool call despite length' },
    };
    const send = vi.fn();

    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [toolCall] },
        content: '',
        finish_reason: 'length',
        model: 'test-model',
        tool_calls: [toolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: {
          role: 'assistant',
          content: '<final_answer>\nTool call completed.\n</final_answer>',
        },
        content: '<final_answer>\nTool call completed.\n</final_answer>',
        finish_reason: 'stop',
        model: 'test-model',
      });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Search once.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    const histories = historyUpdateCalls().map(parsedHistoryFromCall);
    expect(
      histories.some((history) =>
        history.some((msg) =>
          msg.content.startsWith('Your previous response exceeded the output length limit'),
        ),
      ),
    ).toBe(false);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('Tool call completed.')),
    ).toBe(true);
  });

  it('serializes multiple interactive shell_script calls instead of overwriting the pending resolver', async () => {
    const shellOne = {
      id: 'call-shell-1',
      name: 'shell_script',
      arguments: { script: 'echo one' },
    };
    const shellTwo = {
      id: 'call-shell-2',
      name: 'shell_script',
      arguments: { script: 'echo two' },
    };
    const send = vi.fn();

    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [shellOne, shellTwo] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [shellOne, shellTwo],
      })
      .mockResolvedValueOnce({
        assistantMessage: {
          role: 'assistant',
          content: '<final_answer>\nBoth scripts completed.\n</final_answer>',
        },
        content: '<final_answer>\nBoth scripts completed.\n</final_answer>',
        finish_reason: 'stop',
        model: 'test-model',
      });

    const turn = runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Run two shell checks.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    await waitForCondition(() =>
      send.mock.calls.some(([msg]) => String(msg.content).includes('echo one')),
    );
    expect(send.mock.calls.some(([msg]) => String(msg.content).includes('echo two'))).toBe(false);
    pendingShellScripts.get('session-1')?.resolve('TERMINAL OUTPUT:\none');

    await waitForCondition(() =>
      send.mock.calls.some(([msg]) => String(msg.content).includes('echo two')),
    );
    pendingShellScripts.get('session-1')?.resolve('TERMINAL OUTPUT:\ntwo');

    await turn;

    const calls = historyUpdateCalls();
    const finalHistory = parsedHistoryFromCall(calls[calls.length - 1]);
    const shellResults = finalHistory.filter(
      (msg) => msg.role === 'tool' && msg.tool_name === 'shell_script',
    );
    expect(shellResults.map((msg) => msg.content)).toEqual([
      'TERMINAL OUTPUT:\none',
      'TERMINAL OUTPUT:\ntwo',
    ]);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('Both scripts completed.')),
    ).toBe(true);
  });

  it('stops a runaway tool loop after a bounded number of iterations', async () => {
    const toolCall = {
      id: 'call-loop',
      name: 'web_search',
      arguments: { query: 'loop forever' },
    };
    const send = vi.fn();

    mocks.complete.mockResolvedValue({
      assistantMessage: { role: 'assistant', content: '', tool_calls: [toolCall] },
      content: '',
      finish_reason: 'tool_calls',
      model: 'test-model',
      tool_calls: [toolCall],
    });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Keep searching.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    expect(mocks.executeTool.mock.calls.length).toBeLessThanOrEqual(20);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('too many tool calls')),
    ).toBe(true);
  });

  it('interrupts repeated web-tool failure and recovers with shell_script fallback', async () => {
    const webToolCall = {
      id: 'call-web',
      name: 'web_search',
      arguments: { query: 'loop during outage' },
    };
    const shellToolCall = {
      id: 'call-shell',
      name: 'shell_script',
      arguments: { script: 'curl -fsSL https://example.com/status' },
    };
    const send = vi.fn();

    mocks.executeTool.mockResolvedValue('Error searching: upstream outage');
    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [webToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [webToolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [shellToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [shellToolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: {
          role: 'assistant',
          content: '<final_answer>\nRecovered through shell.\n</final_answer>',
        },
        content: '<final_answer>\nRecovered through shell.\n</final_answer>',
        finish_reason: 'stop',
        model: 'test-model',
      });

    const turn = runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Keep searching during outage.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    await waitForCondition(() =>
      send.mock.calls.some(([msg]) => String(msg.content).includes('curl -fsSL')),
    );
    pendingShellScripts.get('session-1')?.resolve('TERMINAL OUTPUT:\nfallback data');

    await turn;

    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(3);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('Recovered through shell.')),
    ).toBe(true);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('too many tool calls')),
    ).toBe(false);
    const recoveryTools = (mocks.complete.mock.calls[1][2]?.tools ?? []).map(
      (tool: { name: string }) => tool.name,
    );
    expect(recoveryTools).toContain('shell_script');
    expect(recoveryTools).not.toContain('web_search');
    expect(recoveryTools).not.toContain('web_fetch');
    expect(
      historyUpdateCalls()
        .map(parsedHistoryFromCall)
        .some((history) =>
          history.some((msg) => msg.content.startsWith('IMPORTANT: The web search tool failed')),
        ),
    ).toBe(true);
  });

  it('stops recursive web fallback if the model keeps requesting unavailable web tools', async () => {
    const webToolCall = {
      id: 'call-web',
      name: 'web_search',
      arguments: { query: 'loop during outage' },
    };
    const send = vi.fn();

    mocks.executeTool.mockResolvedValue('Error searching: upstream outage');
    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [webToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [webToolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [webToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [webToolCall],
      });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Keep searching during outage.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('did not switch to terminal')),
    ).toBe(true);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('too many tool calls')),
    ).toBe(false);
  });

  it('ignores old web-tool failures when the current tool loop succeeds', async () => {
    mocks.agentSession.findOne.mockResolvedValueOnce({
      id: 'session-1',
      historyJson: JSON.stringify([
        { role: 'system', content: 'sys' },
        { role: 'user', content: '<user_input>\nOld task\n</user_input>' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'old-call', name: 'web_search', arguments: { query: 'old' } }],
        },
        {
          role: 'tool',
          tool_call_id: 'old-call',
          tool_name: 'web_search',
          content: 'Error searching: old outage',
        },
      ]),
      turns: 1,
      groupName: null,
      groupLocked: false,
    });

    const freshToolCall = {
      id: 'fresh-call',
      name: 'web_search',
      arguments: { query: 'fresh' },
    };
    const send = vi.fn();
    mocks.executeTool.mockResolvedValueOnce('fresh search result');
    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [freshToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [freshToolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: {
          role: 'assistant',
          content: '<final_answer>\nFresh result is usable.\n</final_answer>',
        },
        content: '<final_answer>\nFresh result is usable.\n</final_answer>',
        finish_reason: 'stop',
        model: 'test-model',
      });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Search again.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    const histories = historyUpdateCalls().map(parsedHistoryFromCall);
    expect(
      histories.some((history) =>
        history.some((msg) => msg.content.startsWith('IMPORTANT: The web search tool failed')),
      ),
    ).toBe(false);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('Fresh result is usable.')),
    ).toBe(true);
  });

  it('treats plain text from any provider as a final answer without format retries', async () => {
    const send = vi.fn();
    mocks.complete.mockResolvedValueOnce({
      assistantMessage: { role: 'assistant', content: 'Plain but useful answer.' },
      content: 'Plain but useful answer.',
      finish_reason: 'stop',
      model: 'test-model',
    });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Answer directly.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(
      send.mock.calls.some(([msg]) =>
        String(msg.content).includes('<final_answer>\nPlain but useful answer.\n</final_answer>'),
      ),
    ).toBe(true);
  });

  it('refuses disabled special tools before trying to execute them', async () => {
    const imageToolCall = {
      id: 'call-image',
      name: 'generate_image',
      arguments: { prompt: 'draw a dashboard' },
    };
    const send = vi.fn();

    mocks.complete
      .mockResolvedValueOnce({
        assistantMessage: { role: 'assistant', content: '', tool_calls: [imageToolCall] },
        content: '',
        finish_reason: 'tool_calls',
        model: 'test-model',
        tool_calls: [imageToolCall],
      })
      .mockResolvedValueOnce({
        assistantMessage: {
          role: 'assistant',
          content: '<final_answer>\nImage tool unavailable.\n</final_answer>',
        },
        content: '<final_answer>\nImage tool unavailable.\n</final_answer>',
        finish_reason: 'stop',
        model: 'test-model',
      });

    await runAgentTurn(
      'session-1',
      { id: 'subscription-1' } as any,
      {
        session_id: 'session-1',
        sender: 'client',
        content: 'Generate an image.',
        platform: 'macos',
      },
      send,
      mocks.log as any,
      { skipGrouping: true },
    );

    expect(
      send.mock.calls.some(([msg]) =>
        String(msg.content).includes('Tool "generate_image" is not enabled'),
      ),
    ).toBe(true);
    expect(
      send.mock.calls.some(([msg]) => String(msg.content).includes('Image tool unavailable.')),
    ).toBe(true);
  });
});
