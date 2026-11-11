import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types';
import {
  createFakeSkillStore,
  deferred,
  finalAnswer,
  overlaysIn,
  toolCalls,
  waitFor,
  type CapturedRequest,
} from './helpers/agentSkillsHarness';

const mocks = vi.hoisted(() => {
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  return {
    log,
    rows: new Map<string, Record<string, unknown>>(),
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
    getMcpToolsForSubscription: vi.fn(),
    getAgentSettings: vi.fn(),
    replaceNormalizedTranscript: vi.fn(),
    inputBudget: { value: 100_000 },
    cancelCheck: { hook: undefined as undefined | ((stack: string) => void) },
  };
});

vi.mock('../db', async () => {
  const { Sequelize } = await import('sequelize');
  return { sequelize: new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false }) };
});
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../models/agentSession', () => ({ AgentSession: mocks.agentSession }));
vi.mock('../models/subscription', () => ({ Subscription: { increment: vi.fn() } }));
vi.mock('../models/subscriptionUsage', () => ({ SubscriptionUsage: { create: vi.fn() } }));
vi.mock('../agent/agentPrompts', () => ({ getAgentPrompt: vi.fn(() => 'system prompt') }));
vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: mocks.getAgentSettings,
  selectedAgentModelForProvider: vi.fn(() => 'test-model'),
}));
vi.mock('../agent/mcpPromptCache', () => ({ getPromptMcpsForSubscription: vi.fn(async () => []) }));
vi.mock('../agent/mcpRuntime', () => ({
  CONNECT_MCP_TOOL_NAME: 'connect_mcp',
  MCP_TOOL_PREFIX: 'mcp__',
  activateMcpServerForSubscription: vi.fn(),
  executeMcpTool: vi.fn(),
  getMcpToolsForSubscription: mocks.getMcpToolsForSubscription,
}));
vi.mock('../featureRoutes', () => ({
  getDefaultTaskTemplateSnapshot: vi.fn(async () => null),
  getPromptForCommand: vi.fn(),
}));
vi.mock('../web-search/web-search-provider', () => ({
  WEB_FETCH_TOOL: { name: 'web_fetch', description: 'Fetch', parameters: { type: 'object' } },
  WEB_SEARCH_TOOL: { name: 'web_search', description: 'Search', parameters: { type: 'object' } },
  executeTool: mocks.executeTool,
}));
vi.mock('../agent/agentAuth', () => ({
  createLazyAuthContext: () => ({
    ensureAuthenticated: async () => true,
    getSubscription: () => ({ id: 'subscription-1' }),
  }),
}));
vi.mock('../authMiddleware', () => ({ authMiddleware: vi.fn((_q, _s, next) => next()) }));
vi.mock('../agent/imageTool', () => ({
  IMAGE_GENERATE_TOOL: { name: 'generate_image', description: 'Image', parameters: {} },
  executeImageGenerationTool: vi.fn(),
}));
vi.mock('../agent/sessionGrouping', () => ({
  GROUPING_SESSION_PREFIX: 'grouping-',
  buildProjectContext: vi.fn(async () => null),
  updateSessionGroup: vi.fn(async () => undefined),
}));
vi.mock('../agent/agentServer/transcriptStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/agentServer/transcriptStore')>()),
  replaceNormalizedTranscript: mocks.replaceNormalizedTranscript,
}));
// Deterministic hook into the cancellation checkpoint that immediately
// precedes the tool loop's pre-tool steering drain.
vi.mock('../agent/agentServer/turnCancellation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/agentServer/turnCancellation')>();
  return {
    throwIfTurnCancelled: (signal?: AbortSignal) => {
      mocks.cancelCheck.hook?.(new Error().stack ?? '');
      actual.throwIfTurnCancelled(signal);
    },
  };
});
vi.mock('../shellRunner', () => ({ runScript: vi.fn() }));
vi.mock('../ai-client', () => ({
  aiClient: { complete: mocks.complete },
  estimateHistoryTokens: vi.fn((history: unknown[]) => JSON.stringify(history).length),
  getContextWindowSize: vi.fn(() => 128_000),
  getDefaultModel: vi.fn(() => 'test-model'),
  getFixedHelperModel: vi.fn(() => 'summary-model'),
  getInputTokenBudget: vi.fn(() => mocks.inputBudget.value),
  getMaxMessageContentLength: vi.fn(() => 1_000_000),
  providerSupportsImageGeneration: vi.fn(() => false),
}));
vi.mock('ws', async () => {
  const { EventEmitter: Emitter } = await import('events');
  return {
    default: class {
      static OPEN = 1;
    },
    WebSocketServer: class extends Emitter {},
  };
});

import { runAgentTurn } from '../agent/agentServer';
import {
  attachAgentWebSocketServer,
  rejectPendingSteeringAtTurnEnd,
} from '../agent/agentServer/websocket';
import {
  enqueueSteeringMessage,
  drainSteeringMessagesIntoHistory,
  MAX_STEERING_ID_LENGTH,
  MAX_RETAINED_STEERING_IDS,
} from '../agent/agentServer/steering';
import {
  activeSessions,
  pendingShellScripts,
  sessionOwners,
  sessionQueues,
  sessionSteeringIds,
  sessionSteeringMessages,
} from '../agent/agentServer/runtimeState';
import { setSkillStoreForTesting } from '../agent/skillContext';

const SECRET = 'STEER-SECRET-INSTRUCTIONS-77d1';
const subscription = { id: 'subscription-1' } as any;
const fake = createFakeSkillStore();
let requests: CapturedRequest[] = [];
let responses: Array<unknown | ((req: CapturedRequest) => unknown)> = [];

function addSkill(id: string, keyword: string, extra: Record<string, unknown> = {}) {
  const row = {
    id,
    name: `Skill ${id}`,
    keyword,
    instructions: `${SECRET} ${id}`,
    revision: 1,
    ...extra,
  };
  fake.rows.push(row as never);
  return row;
}

function steer(content: string, id: string | undefined, extra: Partial<AgentMessage> = {}) {
  return enqueueSteeringMessage(
    'session-1',
    {
      session_id: 'session-1',
      sender: 'client',
      content,
      is_steering: true,
      ...(id ? { steering_id: id } : {}),
      ...extra,
    },
    mocks.log as any,
    extra.supports_skill_status ? stewardSend : undefined,
  );
}
const stewardSend = vi.fn();

async function run(content: string, send = vi.fn(), options: Record<string, unknown> = {}) {
  await runAgentTurn(
    'session-1',
    subscription,
    { session_id: 'session-1', sender: 'client', content, platform: 'macos' },
    send,
    mocks.log as any,
    { skipGrouping: true, interactiveInput: true, supportsSkillStatus: true, ...options },
  );
  return send;
}

const ids = (request: CapturedRequest) => {
  const overlays = overlaysIn(request);
  expect(overlays).toHaveLength(1);
  return overlays[0].skills.map((s) => s.id);
};

function notices(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.map(([m]) => m).filter((m) => m.skill_status);
}

function persistedText(): string {
  return JSON.stringify([...mocks.rows.values()].map((r) => r.historyJson));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  mocks.cancelCheck.hook = undefined;
  mocks.inputBudget.value = 100_000;
  mocks.rows.clear();
  fake.rows.length = 0;
  fake.state.down = false;
  fake.state.calls = 0;
  fake.state.beforeList = undefined;
  requests = [];
  responses = [];
  activeSessions.clear();
  sessionOwners.clear();
  sessionQueues.clear();
  pendingShellScripts.clear();
  sessionSteeringIds.clear();
  sessionSteeringMessages.clear();
  setSkillStoreForTesting(async () => fake.store);
  mocks.agentSession.findOne.mockImplementation(async ({ where }: any) => {
    const row = mocks.rows.get(where.id);
    return row ? { ...row } : null;
  });
  mocks.agentSession.findOrCreate.mockImplementation(async ({ where, defaults }: any) => {
    mocks.rows.set(where.id, { ...defaults });
    return [{ ...defaults }, true];
  });
  mocks.agentSession.update.mockImplementation(async (values: any, { where }: any) => {
    const row = mocks.rows.get(where.id);
    if (row) Object.assign(row, values);
    return [row ? 1 : 0];
  });
  mocks.agentSession.count.mockResolvedValue(1);
  mocks.agentSession.findAll.mockResolvedValue([]);
  mocks.agentSession.increment.mockResolvedValue([1]);
  mocks.executeTool.mockResolvedValue('tool result');
  mocks.getMcpToolsForSubscription.mockResolvedValue({ aiTools: [], dispatch: new Map() });
  mocks.getAgentSettings.mockResolvedValue({
    id: 'default',
    terminalAccess: 'full',
    webSearchEnabled: true,
    browserAccessEnabled: false,
    browserAccessMethod: null,
    browserJavascriptEventBrowsers: [],
  });
  mocks.complete.mockImplementation(async (model: string, history: any[], options: any) => {
    const captured: CapturedRequest = {
      model,
      history: structuredClone(history),
      tools: (options?.tools ?? []).map((t: { name: string }) => t.name),
    };
    requests.push(captured);
    const next = responses.shift() ?? finalAnswer('done');
    return typeof next === 'function' ? next(captured) : next;
  });
});

describe('steering adds newly matched skills at every drain point', () => {
  const call = { id: 'call-1', name: 'web_search', arguments: { query: 'q' } };

  function expectSteeringApplied(send: ReturnType<typeof vi.fn>, requestIndex: number) {
    expect(ids(requests[requestIndex])).toEqual(['a', 'b']);
    const overlay = overlaysIn(requests[requestIndex])[0];
    expect(requests[requestIndex].history[overlay.index].content).toContain('<user_steering');
    const steeringNotices = notices(send).filter((n) => n.skill_status.input_id === 'st-1');
    expect(steeringNotices).toEqual([
      expect.objectContaining({
        content: 'Skills applied.',
        is_error: false,
        is_terminal_output: false,
        skill_status: {
          input_id: 'st-1',
          status: 'applied',
          skills: [{ id: 'b', name: 'Skill b', keyword: 'beta', revision: 1 }],
          warnings: [],
        },
      }),
    ]);
    expect(persistedText()).toContain('also beta please');
    expect(persistedText()).not.toContain(SECRET);
    expect(JSON.stringify(send.mock.calls)).not.toContain(SECRET);
  }

  beforeEach(() => {
    addSkill('a', 'alpha');
    addSkill('b', 'beta');
  });

  it('1: after the initial model response', async () => {
    responses = [
      () => {
        steer('also beta please', 'st-1');
        return finalAnswer('stale');
      },
      finalAnswer('steered'),
    ];
    const send = await run('alpha task');
    expect(ids(requests[0])).toEqual(['a']);
    expectSteeringApplied(send, 1);
  });

  it('2: before finalizing (through the recursive restart)', async () => {
    let armed = true;
    mocks.agentSession.update.mockImplementation(async (values: any, { where }: any) => {
      const row = mocks.rows.get(where.id);
      if (row) Object.assign(row, values);
      if (armed && String(values.historyJson ?? '').includes('stale final')) {
        armed = false;
        steer('also beta please', 'st-1');
      }
      return [1];
    });
    responses = [finalAnswer('stale final'), finalAnswer('steered')];
    const send = await run('alpha task');
    expect(requests).toHaveLength(2);
    expectSteeringApplied(send, 1);
    expect(send.mock.calls.some(([m]) => String(m.content).includes('steered'))).toBe(true);
  });

  it('3: before executing stale tool calls', async () => {
    let armed = false;
    mocks.cancelCheck.hook = (stack) => {
      if (armed && stack.includes('runToolLoop')) {
        armed = false;
        steer('also beta please', 'st-1');
      }
    };
    responses = [
      () => {
        armed = true;
        return toolCalls([call]);
      },
      finalAnswer('steered'),
    ];
    const send = await run('alpha task');
    expect(mocks.executeTool).not.toHaveBeenCalled();
    expectSteeringApplied(send, 1);
  });

  it('4: after tool results', async () => {
    mocks.executeTool.mockImplementation(async () => {
      steer('also beta please', 'st-1');
      return 'tool result';
    });
    responses = [toolCalls([call]), finalAnswer('steered')];
    const send = await run('alpha task');
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    expectSteeringApplied(send, 1);
  });

  it('5: after the follow-up model response', async () => {
    responses = [
      toolCalls([call]),
      () => {
        steer('also beta please', 'st-1');
        return finalAnswer('stale');
      },
      finalAnswer('steered'),
    ];
    const send = await run('alpha task');
    expect(ids(requests[1])).toEqual(['a']);
    expectSteeringApplied(send, 2);
  });
});

describe('steering Skills semantics', () => {
  it('keeps the first snapshot, notifies new skills only and ignores repeated matches', async () => {
    const a = addSkill('a', 'alpha');
    addSkill('c', 'gamma');
    responses = [
      () => {
        a.instructions = `${SECRET} edited`;
        a.revision = 2;
        steer('alpha again', 'st-1');
        return finalAnswer('one');
      },
      () => {
        steer('now gamma and alpha', 'st-2');
        return finalAnswer('two');
      },
      finalAnswer('three'),
    ];
    const send = await run('alpha task');
    expect(requests).toHaveLength(3);
    const last = overlaysIn(requests[2])[0].skills;
    expect(last.map((s) => s.id)).toEqual(['a', 'c']);
    expect(last[0]).toEqual(expect.objectContaining({ revision: 1, instructions: `${SECRET} a` }));
    const applied = notices(send).map((n) => [n.skill_status.input_id, n.skill_status.skills]);
    expect(applied).toEqual([
      [expect.any(String), [expect.objectContaining({ id: 'a' })]],
      ['st-2', [expect.objectContaining({ id: 'c' })]],
    ]);
  });

  it('rejects only the failing steering input and keeps the prior run context', async () => {
    addSkill('a', 'alpha');
    responses = [
      () => {
        fake.state.down = true;
        steer('alpha extra direction', 'st-bad', { supports_skill_status: true });
        return toolCalls([{ id: 'c1', name: 'web_search', arguments: {} }]);
      },
      () => {
        fake.state.down = false;
        return finalAnswer('finished');
      },
    ];
    const send = await run('alpha task');
    expect(stewardSend.mock.calls.map(([m]) => m)).toEqual([
      expect.objectContaining({
        content: 'Skills could not be applied.',
        is_error: false,
        skill_status: expect.objectContaining({
          input_id: 'st-bad',
          status: 'blocked',
          error: {
            code: 'STORE_UNAVAILABLE',
            message: 'Skills are temporarily unavailable. Please retry.',
          },
        }),
      }),
      {
        session_id: 'session-1',
        sender: 'agent',
        content: 'Skills are temporarily unavailable. Please retry.',
        is_terminal_output: false,
        is_error: true,
        is_steering: true,
        steering_id: 'st-bad',
        steering_status: 'rejected',
      },
    ]);
    expect(mocks.executeTool).toHaveBeenCalledTimes(1);
    for (const request of requests) {
      expect(ids(request)).toEqual(['a']);
      expect(JSON.stringify(request.history)).not.toContain('alpha extra direction');
    }
    expect(persistedText()).not.toContain('alpha extra direction');
    expect(send.mock.calls.some(([m]) => String(m.content).includes('finished'))).toBe(true);
    expect(send.mock.calls.some(([m]) => m.steering_status === 'applied')).toBe(false);
  });

  it('validates the accumulated union FIFO and rejects only the input that overflows', async () => {
    for (let i = 0; i < 7; i++) addSkill(`k${i}`, `kw${i}`);
    addSkill('k7', 'kw7');
    addSkill('k8', 'kw8');
    responses = [
      () => {
        steer('add kw7', 'st-ok');
        steer('add kw8', 'st-over');
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    const send = await run('kw0 kw1 kw2 kw3 kw4 kw5 kw6');
    expect(ids(requests[1])).toEqual(['k0', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7']);
    expect(JSON.stringify(requests[1].history)).toContain('add kw7');
    expect(JSON.stringify(requests[1].history)).not.toContain('add kw8');
    const statuses = send.mock.calls.map(([m]) => m).filter((m) => m.is_steering);
    expect(statuses).toEqual([
      expect.objectContaining({
        steering_id: 'st-over',
        steering_status: 'rejected',
        content: 'Too many skills matched. Use fewer keywords or disable some skills.',
      }),
      expect.objectContaining({ steering_id: 'st-ok', steering_status: 'applied' }),
    ]);
  });

  it('adds skills to a run whose input had none, anchored on the steering message', async () => {
    addSkill('b', 'beta');
    responses = [
      () => {
        steer('use beta', 'st-1');
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    await run('no keyword here');
    expect(overlaysIn(requests[0])).toEqual([]);
    expect(ids(requests[1])).toEqual(['b']);
  });

  it('never resolves steering for runs without interactive Skills state', async () => {
    addSkill('b', 'beta');
    responses = [
      () => {
        steer('use beta', 'st-1');
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    await run('task', vi.fn(), { interactiveInput: undefined });
    expect(fake.state.calls).toBe(0);
    expect(overlaysIn(requests[1])).toEqual([]);
    expect(JSON.stringify(requests[1].history)).toContain('use beta');
  });

  it('validates the union with the FIRST snapshot of an edited active skill, not its new revision', async () => {
    const a = addSkill('a', 'alpha', { instructions: 'short' });
    addSkill('b', 'beta', { instructions: 'b'.repeat(8_000) });
    addSkill('c', 'gamma', { instructions: 'c'.repeat(7_000) });
    responses = [
      () => {
        // Current revision alone would push alpha+beta+gamma over 16,000.
        a.instructions = 'A'.repeat(8_000);
        a.revision = 2;
        steer('alpha beta gamma', 'st-1');
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    const send = await run('alpha task');
    expect(ids(requests[1])).toEqual(['a', 'b', 'c']);
    expect(overlaysIn(requests[1])[0].skills[0]).toEqual(
      expect.objectContaining({ id: 'a', revision: 1, instructions: 'short' }),
    );
    expect(send.mock.calls.some(([m]) => m.steering_status === 'rejected')).toBe(false);
    // Same store, one read per genuine input/steering.
    expect(fake.state.calls).toBe(2);
  });

  it('does not warn about an active skill whose row became invalid; other invalid rows still warn', async () => {
    const a = addSkill('a', 'alpha');
    addSkill('b', 'beta');
    responses = [
      () => {
        // The frozen first snapshot of `a` stays valid for this run.
        a.instructions = 'A'.repeat(8_001);
        a.revision = 2;
        addSkill('z', 'zeta', { instructions: '' });
        steer('alpha beta', 'st-1');
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    const send = await run('alpha task');
    expect(ids(requests[1])).toEqual(['a', 'b']);
    expect(overlaysIn(requests[1])[0].skills[0]).toEqual(
      expect.objectContaining({ id: 'a', revision: 1, instructions: `${SECRET} a` }),
    );
    const steeringWarnings = notices(send).filter(
      (n) => n.skill_status.input_id === 'st-1' && n.skill_status.status === 'warning',
    );
    expect(steeringWarnings).toHaveLength(1);
    expect(steeringWarnings[0].skill_status.warnings).toEqual([
      expect.objectContaining({ code: 'INVALID_SKILL', skillId: 'z' }),
    ]);
    expect(send.mock.calls.some(([m]) => m.steering_status === 'rejected')).toBe(false);
  });

  it('still rejects steering whose first-snapshot union exceeds the aggregate limit', async () => {
    addSkill('a', 'alpha', { instructions: 'a'.repeat(8_000) });
    addSkill('b', 'beta', { instructions: 'b'.repeat(8_000) });
    addSkill('c', 'gamma', { instructions: 'c' });
    responses = [
      () => {
        steer('beta gamma', 'st-over');
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    const send = await run('alpha task');
    expect(send.mock.calls.map(([m]) => m).filter((m) => m.steering_status)).toEqual([
      expect.objectContaining({
        steering_id: 'st-over',
        steering_status: 'rejected',
        content: 'Matched skill instructions exceed the context budget. Shorten or disable skills.',
      }),
    ]);
  });

  it('drops TTL-expired steering before preparation: no union share, no Skills verdict', async () => {
    addSkill('a', 'alpha');
    addSkill('b', 'beta');
    responses = [
      () => {
        steer('beta from long ago', 'st-old');
        steer('beta now', 'st-new');
        // Expires after both were enqueued (enqueue itself purges expired entries).
        const pending = sessionSteeringMessages.get('session-1')!;
        pending[0].receivedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    const send = await run('alpha task');
    expect(ids(requests[1])).toEqual(['a', 'b']);
    const history = JSON.stringify(requests[1].history);
    expect(history).toContain('beta now');
    expect(history).not.toContain('beta from long ago');
    const statuses = send.mock.calls.map(([m]) => m).filter((m) => m.is_steering);
    expect(statuses).toEqual([
      expect.objectContaining({ steering_id: 'st-new', steering_status: 'applied' }),
    ]);
    expect(notices(send).map((n) => n.skill_status.input_id)).toEqual([
      expect.any(String),
      'st-new',
    ]);
    // Only the fresh steering was resolved.
    expect(fake.state.calls).toBe(2);
  });

  it('discards steering that expires during its store read and keeps its id seen', async () => {
    addSkill('a', 'alpha');
    addSkill('b', 'beta');
    sessionSteeringIds.set('session-1', new Set());
    fake.state.beforeList = () => {
      const pending = sessionSteeringMessages.get('session-1') ?? [];
      const slow = pending.find((m) => m.steeringId === 'st-slow');
      if (!slow) return;
      // Expires while its (failing) read is in flight: no rejection verdict.
      slow.receivedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      fake.state.down = true;
    };
    responses = [
      () => {
        steer('beta slow', 'st-slow');
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    const send = await run('alpha task');
    expect(requests).toHaveLength(1);
    expect(send.mock.calls.some(([m]) => m.is_steering)).toBe(false);
    expect(notices(send)).toHaveLength(1); // only the ordinary input's applied notice
    expect(persistedText()).not.toContain('beta slow');
    expect(steer('beta slow retry', 'st-slow')).toEqual(
      expect.objectContaining({ accepted: false, duplicate: true }),
    );
  });

  it('cancellation during a steering store read emits and persists nothing for it', async () => {
    addSkill('a', 'alpha');
    addSkill('b', 'beta');
    const controller = new AbortController();
    fake.state.beforeList = () => {
      if (fake.state.calls === 2) controller.abort();
    };
    responses = [
      () => {
        steer('beta direction', 'st-1', { supports_skill_status: true });
        return finalAnswer('stale');
      },
    ];
    const send = await run('alpha task', vi.fn(), { signal: controller.signal });
    expect(requests).toHaveLength(1);
    expect(stewardSend).not.toHaveBeenCalled();
    expect(send.mock.calls.some(([m]) => m.is_steering)).toBe(false);
    expect(notices(send)).toHaveLength(1);
    expect(persistedText()).not.toContain('beta direction');
  });

  it('delivers non-client steering without resolving or activating skills', async () => {
    addSkill('a', 'alpha');
    addSkill('b', 'beta');
    responses = [
      () => {
        steer('beta via agent sender', 'st-1', { sender: 'agent' });
        return finalAnswer('stale');
      },
      finalAnswer('done'),
    ];
    await run('alpha task');
    expect(ids(requests[1])).toEqual(['a']);
    expect(JSON.stringify(requests[1].history)).toContain('beta via agent sender');
    expect(fake.state.calls).toBe(1);
  });

  it('keeps genuine steering separate from an injected progress prompt so replay does not drop it', async () => {
    const { removeInjectedUserPromptsFromHistory } =
      await import('../agent/agentServer/completionRecovery');
    const session = {
      subscription,
      turns: 1,
      activeModel: 'test-model',
      history: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'Agent progress checkpoint: internal recovery guidance' },
      ],
    } as Parameters<typeof drainSteeringMessagesIntoHistory>[1];
    steer('keep this genuine direction', 'separate');
    drainSteeringMessagesIntoHistory('session-1', session, false, mocks.log as never);
    expect(session.history).toHaveLength(3);
    removeInjectedUserPromptsFromHistory(session, mocks.log as never);
    expect(session.history).toHaveLength(2);
    expect(session.history[1].content).toContain('keep this genuine direction');
    expect(session.history[1].content).toContain('<user_steering');
  });

  it('bounds retained steering IDs before insertion, including rejected empty frames', () => {
    const seen = new Set<string>();
    sessionSteeringIds.set('session-1', seen);
    expect(steer('', 'x'.repeat(MAX_STEERING_ID_LENGTH + 1)).accepted).toBe(false);
    expect(seen.size).toBe(0);
    for (let i = 0; i < MAX_RETAINED_STEERING_IDS; i++)
      expect(steer('', `rejected-${i}`).accepted).toBe(false);
    expect(seen.size).toBe(MAX_RETAINED_STEERING_IDS);
    expect(steer('valid guidance', 'new-id').accepted).toBe(false);
    expect(steer('legacy guidance', undefined).accepted).toBe(false);
    expect(seen.size).toBe(MAX_RETAINED_STEERING_IDS);
    expect(sessionSteeringMessages.has('session-1')).toBe(false);
    expect(steer('', 'rejected-0').duplicate).toBe(true);
  });

  it('rejects only steering that exceeds the model request budget before committing it', async () => {
    mocks.inputBudget.value = 6_000;
    addSkill('a', 'alpha', { instructions: 'Small original guidance.' });
    addSkill('b', 'beta', { instructions: 'b'.repeat(8_000) });
    responses = [
      () => {
        steer('beta rejected candidate', 'too-large', { supports_skill_status: true });
        steer('alpha accepted direction', 'fits', { supports_skill_status: true });
        return finalAnswer('stale');
      },
      finalAnswer('original run continued'),
    ];
    const send = await run('alpha task');
    expect(requests).toHaveLength(2);
    expect(ids(requests[1])).toEqual(['a']);
    expect(JSON.stringify(requests[1].history)).not.toContain('beta rejected candidate');
    expect(persistedText()).not.toContain('beta rejected candidate');
    expect(persistedText()).toContain('alpha accepted direction');
    expect(stewardSend).toHaveBeenCalledWith(
      expect.objectContaining({ steering_id: 'too-large', steering_status: 'rejected' }),
    );
    expect(stewardSend).toHaveBeenCalledWith(
      expect.objectContaining({
        skill_status: expect.objectContaining({
          input_id: 'too-large',
          status: 'blocked',
          error: expect.objectContaining({ code: 'CONTEXT_LIMIT_EXCEEDED' }),
        }),
      }),
    );
    expect(send.mock.calls.some(([message]) => message.is_error && !message.is_steering)).toBe(
      false,
    );
  });

  it.each(['client', 'agent'])(
    'budgets combined FIFO history for a later %s steer before committing',
    async (sender) => {
      mocks.inputBudget.value = 6_000;
      addSkill('a', 'alpha', { instructions: 'Small original guidance.' });
      const first = 'first accepted ' + 'x'.repeat(2_300);
      const second = 'second rejected ' + 'y'.repeat(2_300);
      responses = [
        () => {
          steer(first, 'first', { supports_skill_status: true });
          steer(second, 'second', { supports_skill_status: true, sender });
          return finalAnswer('stale');
        },
        finalAnswer('continued'),
      ];
      await run('alpha task');
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(requests[1].history)).toContain('first accepted');
      expect(JSON.stringify(requests[1].history)).not.toContain('second rejected');
      expect(persistedText()).not.toContain('second rejected');
      expect(stewardSend).toHaveBeenCalledWith(
        expect.objectContaining({ steering_id: 'second', steering_status: 'rejected' }),
      );
    },
  );

  it('deduplicates steering ids synchronously within a run, not across runs', () => {
    sessionSteeringIds.set('session-1', new Set());
    expect(steer('first', 'dup').accepted).toBe(true);
    expect(steer('first again', 'dup')).toEqual(
      expect.objectContaining({ accepted: false, duplicate: true }),
    );
    expect(steer('legacy', undefined).accepted).toBe(true);
    expect(steer('legacy', undefined).accepted).toBe(true);
    expect(sessionSteeringMessages.get('session-1')).toHaveLength(3);
    sessionSteeringIds.delete('session-1');
    sessionSteeringMessages.clear();
    expect(steer('next run', 'dup').accepted).toBe(true);
  });
});

class Socket extends EventEmitter {
  readyState = 1;
  sent: AgentMessage[] = [];
  send = (raw: string) => {
    this.sent.push(JSON.parse(raw));
  };
  close() {
    this.readyState = 3;
    this.emit('close');
  }
  message(payload: Partial<AgentMessage>) {
    this.emit('message', JSON.stringify({ session_id: 'session-1', sender: 'client', ...payload }));
  }
}

describe('steering acknowledgements and deferred Skills notices', () => {
  it('sends no applied Skills notice for steering whose next request the provider rejects', async () => {
    addSkill('a', 'alpha');
    addSkill('b', 'beta');
    responses = [
      () => {
        steer('also beta please', 'st-1', { supports_skill_status: true });
        return finalAnswer('stale');
      },
      () => {
        throw new Error('provider offline');
      },
    ];
    const send = await run('alpha task');
    expect(requests).toHaveLength(2);
    expect(ids(requests[1])).toEqual(['a', 'b']);
    // Only the ordinary input (accepted request) is reported as applied.
    expect(notices(send).map((n) => [n.skill_status.status, n.skill_status.input_id])).toEqual([
      ['applied', expect.not.stringMatching(/^st-1$/)],
    ]);
    // The steering text itself was applied: its ack goes to the sender only.
    expect(stewardSend.mock.calls.map(([m]) => m.steering_status)).toEqual(['applied']);
    expect(stewardSend.mock.calls.some(([m]) => m.skill_status)).toBe(false);
    expect(send.mock.calls.some(([m]) => m.steering_status)).toBe(false);
  });

  it('routes a late turn-end rejection to the steering sender', () => {
    sessionSteeringIds.set('session-1', new Set());
    steer('too late', 'st-late', { supports_skill_status: true });
    steer('legacy too late', undefined);
    const owner = vi.fn();
    expect(rejectPendingSteeringAtTurnEnd('session-1', owner, mocks.log as any)).toBe(2);
    expect(stewardSend.mock.calls.map(([m]) => [m.steering_id, m.steering_status])).toEqual([
      ['st-late', 'rejected'],
    ]);
    // Without a recorded sender the turn owner remains the fallback channel.
    expect(owner.mock.calls.map(([m]) => m.steering_status)).toEqual(['rejected']);
    expect(sessionSteeringMessages.has('session-1')).toBe(false);
  });
});

describe('WebSocket ingress', () => {
  it('snapshots capability per input, dedups steering ids and isolates queued inputs', async () => {
    addSkill('a', 'alpha');
    addSkill('b', 'beta');
    addSkill('c', 'gamma');
    const gate = deferred();
    responses = [
      async () => {
        await gate.promise;
        return finalAnswer('first stale');
      },
      finalAnswer('first done'),
      finalAnswer('queued done'),
    ];
    const server = attachAgentWebSocketServer({} as any);
    const owner = new Socket();
    server.emit('connection', owner, { headers: {} });
    owner.message({ content: 'alpha task', supports_skill_status: true });
    await waitFor(() => requests.length === 1);

    const other = new Socket();
    server.emit('connection', other, { headers: {} });
    other.message({ content: 'beta steer', is_steering: true, steering_id: 'st-1' });
    other.message({ content: 'beta steer', is_steering: true, steering_id: 'st-1' });
    owner.message({ content: 'queued gamma' }); // queued; no capability
    await waitFor(() => sessionQueues.get('session-1')?.length === 1);
    await waitFor(() => other.sent.length >= 1);
    gate.resolve();
    await waitFor(() => requests.length === 3 && !activeSessions.has('session-1'));

    expect(other.sent.filter((m) => m.steering_status === 'received')).toHaveLength(1);
    expect(ids(requests[1])).toEqual(['a', 'b']);
    expect(JSON.stringify(requests[1].history).match(/beta steer/g)).toHaveLength(1);
    // Queued input: fresh resolution, only its own skill, no inherited overlay.
    expect(ids(requests[2])).toEqual(['c']);
    const ownerNotices = owner.sent.filter((m) => m.skill_status);
    expect(
      ownerNotices.map((m) => [m.skill_status!.status, m.skill_status!.skills.map((s) => s.id)]),
    ).toEqual([
      ['applied', ['a']],
      ['applied', ['b']],
    ]);
    // The steering sender did not opt in and receives no Skills notices.
    expect(other.sent.some((m) => m.skill_status)).toBe(false);
    // Its final applied acknowledgement goes to the sender, not the turn owner;
    // the Skills status above stayed on the turn-owner channel.
    expect(
      other.sent.filter((m) => m.steering_status === 'applied').map((m) => m.steering_id),
    ).toEqual(['st-1']);
    expect(owner.sent.some((m) => m.steering_status)).toBe(false);
    expect(JSON.stringify([...owner.sent, ...other.sent])).not.toContain(SECRET);
    expect(sessionSteeringIds.has('session-1')).toBe(false);
    owner.close();
    other.close();
  });

  it('cleans up after a disconnect during a shell wait; late output and next input inherit nothing', async () => {
    addSkill('a', 'alpha');
    responses = [
      toolCalls([{ id: 'sh-1', name: 'shell_script', arguments: { script: 'echo alpha' } }]),
      finalAnswer('after late output'),
      finalAnswer('next done'),
    ];
    const server = attachAgentWebSocketServer({} as any);
    const owner = new Socket();
    server.emit('connection', owner, { headers: {} });
    owner.message({ content: 'alpha task', supports_skill_status: true });
    await waitFor(() => pendingShellScripts.has('session-1'));
    expect(ids(requests[0])).toEqual(['a']);
    const sentBeforeClose = owner.sent.length;

    owner.close(); // abort settles the shell wait; the run unwinds at its outer boundary
    await waitFor(() => !activeSessions.has('session-1'));
    expect(pendingShellScripts.has('session-1')).toBe(false);
    expect(sessionSteeringIds.has('session-1')).toBe(false);
    expect(owner.sent.length).toBe(sentBeforeClose);
    expect(requests).toHaveLength(1);
    const storeReads = fake.state.calls;

    // Late terminal output on a new connection starts a run that never activates.
    const next = new Socket();
    server.emit('connection', next, { headers: {} });
    next.message({
      content: 'alpha output',
      is_terminal_output: true,
      supports_skill_status: true,
    });
    await waitFor(() => requests.length === 2 && !activeSessions.has('session-1'));
    expect(overlaysIn(requests[1])).toEqual([]);
    expect(fake.state.calls).toBe(storeReads);

    next.message({ content: 'plain follow-up', supports_skill_status: true });
    await waitFor(() => requests.length === 3 && !activeSessions.has('session-1'));
    expect(overlaysIn(requests[2])).toEqual([]);
    expect(next.sent.some((m) => m.skill_status)).toBe(false);
    expect(persistedText()).not.toContain(SECRET);
    next.close();
  });

  it('blocks queued ordinary input on outage and rejects its late steering', async () => {
    fake.state.down = true;
    const server = attachAgentWebSocketServer({} as any);
    const owner = new Socket();
    server.emit('connection', owner, { headers: {} });
    owner.message({ content: 'anything', supports_skill_status: true });
    await waitFor(() => owner.sent.length === 2 && !activeSessions.has('session-1'));
    expect(owner.sent.map((m) => [m.is_error, m.skill_status?.status])).toEqual([
      [false, 'blocked'],
      [true, undefined],
    ]);
    expect(requests).toHaveLength(0);
    expect(mocks.agentSession.update).not.toHaveBeenCalled();
    owner.close();
  });
});
