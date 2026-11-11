/**
 * Session-id ownership against a real, isolated in-memory SQLite database
 * (the `../db` module is replaced before any model is imported; no env/live
 * database, network or user files). Only providers, MCP, settings and prompts
 * are mocked.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types';
import { finalAnswer, waitFor } from './helpers/agentSkillsHarness';

const mocks = vi.hoisted(() => {
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  return {
    log,
    complete: vi.fn(),
    getMcpToolsForSubscription: vi.fn(),
    getPromptMcpsForSubscription: vi.fn(),
    getDefaultTaskTemplateSnapshot: vi.fn(),
  };
});

vi.mock('../db', async () => {
  const { Sequelize } = await import('sequelize');
  return { sequelize: new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false }) };
});
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../usageRecorder', () => ({ recordTokenUsage: vi.fn(async () => undefined) }));
vi.mock('../agent/agentPrompts', () => ({ getAgentPrompt: vi.fn(() => 'system prompt') }));
vi.mock('../agentSettingsStore', () => ({
  getAgentSettings: vi.fn(async () => ({
    id: 'default',
    terminalAccess: 'limited',
    webSearchEnabled: false,
    browserAccessEnabled: false,
    browserAccessMethod: null,
    browserJavascriptEventBrowsers: [],
  })),
  selectedAgentModelForProvider: vi.fn(() => 'test-model'),
}));
vi.mock('../agent/mcpPromptCache', () => ({
  getPromptMcpsForSubscription: mocks.getPromptMcpsForSubscription,
}));
vi.mock('../agent/mcpRuntime', () => ({
  CONNECT_MCP_TOOL_NAME: 'connect_mcp',
  MCP_TOOL_PREFIX: 'mcp__',
  activateMcpServerForSubscription: vi.fn(),
  executeMcpTool: vi.fn(),
  getMcpToolsForSubscription: mocks.getMcpToolsForSubscription,
}));
vi.mock('../featureRoutes', () => ({
  getDefaultTaskTemplateSnapshot: mocks.getDefaultTaskTemplateSnapshot,
  getPromptForCommand: vi.fn(),
}));
vi.mock('../web-search/web-search-provider', () => ({
  WEB_FETCH_TOOL: { name: 'web_fetch', description: 'Fetch', parameters: { type: 'object' } },
  WEB_SEARCH_TOOL: { name: 'web_search', description: 'Search', parameters: { type: 'object' } },
  executeTool: vi.fn(),
}));
vi.mock('../agent/imageTool', () => ({
  IMAGE_GENERATE_TOOL: { name: 'generate_image', description: 'Image', parameters: {} },
  executeImageGenerationTool: vi.fn(),
}));
vi.mock('../agent/sessionGrouping', () => ({
  GROUPING_SESSION_PREFIX: 'grouping-',
  buildProjectContext: vi.fn(async () => null),
  updateSessionGroup: vi.fn(async () => undefined),
}));
vi.mock('../shellRunner', () => ({ runScript: vi.fn() }));
vi.mock('../ai-client', () => ({
  aiClient: { complete: mocks.complete },
  estimateHistoryTokens: vi.fn((history: unknown[]) => JSON.stringify(history).length),
  getContextWindowSize: vi.fn(() => 128_000),
  getDefaultModel: vi.fn(() => 'test-model'),
  getFixedHelperModel: vi.fn(() => 'summary-model'),
  getInputTokenBudget: vi.fn(() => 100_000),
  getMaxMessageContentLength: vi.fn(() => 1_000_000),
  providerSupportsImageGeneration: vi.fn(() => false),
}));
vi.mock('../agent/agentAuth', () => ({
  // The connection's authorization header selects the authenticated identity.
  createLazyAuthContext: (authHeader?: string) => ({
    ensureAuthenticated: async () => true,
    getSubscription: () => ({ id: authHeader ?? 'sub-a' }),
  }),
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

import { sequelize } from '../db';
import { Subscription } from '../models/subscription';
import { AgentSession } from '../models/agentSession';
import { AgentTranscriptMessage } from '../models/agentTranscriptMessage';
import { runAgentTurn } from '../agent/agentServer';
import { persistSessionToDB } from '../agent/agentServer/sessionStore';
import { SESSION_UNAVAILABLE_MESSAGE } from '../agent/agentServer/turnRunner';
import { attachAgentWebSocketServer } from '../agent/agentServer/websocket';
import {
  activeSessions,
  sessionActiveSubscriptions,
  sessionOwners,
  sessionQueues,
  sessionSteeringIds,
  sessionSteeringMessages,
} from '../agent/agentServer/runtimeState';
import { setSkillResolverForTesting } from '../agent/skillContext';

type TurnArgs = Parameters<typeof runAgentTurn>;
type TestSubscription = TurnArgs[1];
const testLog = mocks.log as unknown as TurnArgs[4];
const ownerA = { id: 'sub-a' } as unknown as TestSubscription;
const foreignB = { id: 'sub-b' } as unknown as TestSubscription;

function message(content: string, sessionId: string): AgentMessage {
  return { session_id: sessionId, sender: 'client', content, platform: 'macos' };
}

async function turn(subscription: TestSubscription, sessionId: string, content: string) {
  const send = vi.fn<(msg: AgentMessage) => void>();
  await runAgentTurn(sessionId, subscription, message(content, sessionId), send, testLog, {
    skipGrouping: true,
    interactiveInput: true,
    supportsSkillStatus: true,
  });
  return send;
}

async function snapshot(sessionId: string) {
  const row = await AgentSession.findByPk(sessionId);
  const transcript = await AgentTranscriptMessage.findAll({
    where: { sessionId },
    order: [['sequence', 'ASC']],
  });
  return {
    row: row?.toJSON(),
    transcript: transcript.map((r) => r.toJSON()),
  };
}

function expectRefused(
  send: ReturnType<typeof vi.fn>,
  sessionId: string,
  { creationRace = false } = {},
) {
  expect(send.mock.calls.map(([m]) => m)).toEqual([
    {
      session_id: sessionId,
      sender: 'agent',
      content: SESSION_UNAVAILABLE_MESSAGE,
      is_terminal_output: false,
      is_error: true,
    },
  ]);
  // Ownership is proven before any model, MCP, template or tool work.
  expect(mocks.complete).not.toHaveBeenCalled();
  expect(mocks.getMcpToolsForSubscription).not.toHaveBeenCalled();
  if (creationRace) {
    // Lost race: only the caller's own read-only prompt metadata was loaded
    // to build the row it tried (and failed) to insert.
    expect(mocks.getPromptMcpsForSubscription.mock.calls.map(([id]) => id)).toEqual(['sub-b']);
    expect(mocks.getDefaultTaskTemplateSnapshot).toHaveBeenCalledTimes(1);
    return;
  }
  expect(mocks.getPromptMcpsForSubscription).not.toHaveBeenCalled();
  expect(mocks.getDefaultTaskTemplateSnapshot).not.toHaveBeenCalled();
}

let restoreResolver: () => void = () => undefined;

beforeAll(async () => {
  await sequelize.sync({ force: true });
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  mocks.getMcpToolsForSubscription.mockResolvedValue({ aiTools: [], dispatch: new Map() });
  mocks.getPromptMcpsForSubscription.mockResolvedValue([]);
  mocks.getDefaultTaskTemplateSnapshot.mockResolvedValue(null);
  mocks.complete.mockImplementation(async () => ({
    ...finalAnswer('owner answer'),
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }));
  restoreResolver = setSkillResolverForTesting(async () => ({ matches: [], warnings: [] }));
  for (const map of [
    activeSessions,
    sessionActiveSubscriptions,
    sessionOwners,
    sessionQueues,
    sessionSteeringIds,
    sessionSteeringMessages,
  ]) {
    map.clear();
  }
  await AgentTranscriptMessage.destroy({ where: {} });
  await AgentSession.destroy({ where: {} });
  await Subscription.destroy({ where: {} });
  await Subscription.bulkCreate([
    { id: 'sub-a', licenseKey: 'key-a', email: 'a@example.test' },
    { id: 'sub-b', licenseKey: 'key-b', email: 'b@example.test' },
  ]);
});

afterEach(() => {
  restoreResolver();
  vi.restoreAllMocks();
});

/** Owner A completes one real turn: row, title, usage and transcript exist. */
async function seedOwnerSession(sessionId: string) {
  const send = await turn(ownerA, sessionId, 'owner first task');
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ content: '<final_answer>\nowner answer\n</final_answer>' }),
  );
  // Title is a fire-and-forget write; wait until it landed.
  for (let i = 0; (await AgentSession.findByPk(sessionId))?.title === 'New Session'; i++) {
    if (i > 200) throw new Error('Timed out waiting for the session title');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const before = await snapshot(sessionId);
  expect(before.row).toEqual(
    expect.objectContaining({
      subscriptionId: 'sub-a',
      title: 'owner first task',
      turns: 1,
      totalTokensUsed: 15,
    }),
  );
  expect(before.row!.historyJson).toContain('owner first task');
  expect(before.transcript.length).toBeGreaterThan(0);
  vi.clearAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  return before;
}

describe('agent session ownership (real SQLite)', () => {
  it('refuses an idle foreign session id and leaves the owner row and transcript unchanged', async () => {
    const before = await seedOwnerSession('session-x');

    const send = await turn(foreignB, 'session-x', 'foreign overwrite attempt');

    expectRefused(send, 'session-x');
    expect(await snapshot('session-x')).toEqual(before);
    expect(JSON.stringify(await snapshot('session-x'))).not.toContain('foreign overwrite');
    expect(await AgentSession.count({ where: { subscriptionId: 'sub-b' } })).toBe(0);
  });

  it('refuses a foreign default session over WebSocket (no session_id)', async () => {
    const before = await seedOwnerSession('default');

    const server = attachAgentWebSocketServer(
      {} as unknown as Parameters<typeof attachAgentWebSocketServer>[0],
    );
    const socket = Object.assign(new EventEmitter(), {
      readyState: 1,
      sent: [] as AgentMessage[],
      send(raw: string) {
        this.sent.push(JSON.parse(raw));
      },
      close() {},
    });
    server.emit('connection', socket, { headers: { authorization: 'sub-b' } });
    socket.emit('message', JSON.stringify({ sender: 'client', content: 'foreign default' }));
    await waitFor(() => socket.sent.length === 1 && !activeSessions.has('default'));

    expect(socket.sent).toEqual([
      expect.objectContaining({
        session_id: 'default',
        content: SESSION_UNAVAILABLE_MESSAGE,
        is_error: true,
      }),
    ]);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(await snapshot('default')).toEqual(before);
  });

  it('refuses a lost creation race without any model work or owner overwrite', async () => {
    const original = AgentSession.findOrCreate.bind(AgentSession);
    let racedBefore: Awaited<ReturnType<typeof snapshot>> | undefined;
    vi.spyOn(AgentSession, 'findOrCreate').mockImplementationOnce(async (options) => {
      // Owner A creates the row after B's ownership lookup, before B's insert.
      await AgentSession.create({
        id: 'session-race',
        subscriptionId: 'sub-a',
        title: 'Owner title',
        historyJson: JSON.stringify([{ role: 'user', content: 'owner history' }]),
        turns: 3,
        lastActiveAt: new Date(),
      });
      racedBefore = await snapshot('session-race');
      return original(options);
    });

    const send = await turn(foreignB, 'session-race', 'racing foreign input');

    expectRefused(send, 'session-race', { creationRace: true });
    expect(await snapshot('session-race')).toEqual(racedBefore);
  });

  it('fails closed when the existing-session lookup fails instead of starting fresh', async () => {
    const before = await seedOwnerSession('session-db');
    const findOrCreate = vi.spyOn(AgentSession, 'findOrCreate');
    vi.spyOn(AgentSession, 'findOne').mockRejectedValueOnce(new Error('database is locked'));

    const send = await turn(ownerA, 'session-db', 'owner input during outage');

    expectRefused(send, 'session-db');
    expect(findOrCreate).not.toHaveBeenCalled();
    expect(await snapshot('session-db')).toEqual(before);
  });

  it('scopes checkpoint writes to the owner: a foreign in-memory state updates nothing', async () => {
    const before = await seedOwnerSession('session-w');

    await persistSessionToDB('session-w', {
      subscription: foreignB,
      history: [{ role: 'user', content: '<user_input>\nforeign\n</user_input>' }],
      turns: 99,
    });

    expect(await snapshot('session-w')).toEqual(before);
  });

  it('reuses a row the caller itself created between the owner lookup and the id check', async () => {
    const original = AgentSession.findOne.bind(AgentSession);
    vi.spyOn(AgentSession, 'findOne').mockImplementationOnce(async (options) => {
      // Step 1 (owner-scoped) misses; the caller's own row lands right after.
      const missed = await original(options);
      await AgentSession.create({
        id: 'session-same',
        subscriptionId: 'sub-a',
        title: 'Own title',
        historyJson: JSON.stringify([{ role: 'user', content: 'own earlier history' }]),
        turns: 2,
        lastActiveAt: new Date(),
      });
      return missed;
    });

    const send = await turn(ownerA, 'session-same', 'same owner input');

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '<final_answer>\nowner answer\n</final_answer>' }),
    );
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ content: SESSION_UNAVAILABLE_MESSAGE }),
    );
    const { row } = await snapshot('session-same');
    expect(row).toEqual(expect.objectContaining({ subscriptionId: 'sub-a', turns: 3 }));
    expect(row!.historyJson).toContain('own earlier history');
    expect(row!.historyJson).toContain('same owner input');
  });

  it('fails closed when the id-only ownership lookup fails', async () => {
    const original = AgentSession.findOne.bind(AgentSession);
    const findOrCreate = vi.spyOn(AgentSession, 'findOrCreate');
    vi.spyOn(AgentSession, 'findOne')
      .mockImplementationOnce(async (options) => original(options))
      .mockRejectedValueOnce(new Error('database is locked'));

    const send = await turn(foreignB, 'session-1b', 'input during outage');

    expectRefused(send, 'session-1b');
    expect(findOrCreate).not.toHaveBeenCalled();
    expect(await AgentSession.count()).toBe(0);
  });

  it('refuses but retains an owned session whose stored history is corrupt', async () => {
    await AgentSession.create({
      id: 'session-corrupt',
      subscriptionId: 'sub-a',
      title: 'Corrupt',
      historyJson: '{not json',
      turns: 4,
      lastActiveAt: new Date(),
    });
    const before = await snapshot('session-corrupt');

    const send = await turn(ownerA, 'session-corrupt', 'owner input');

    expectRefused(send, 'session-corrupt');
    // Never reset or overwritten: the stored row stays exactly as it was.
    expect(await snapshot('session-corrupt')).toEqual(before);
  });

  describe('over WebSocket', () => {
    type TestSocket = EventEmitter & {
      readyState: number;
      sent: AgentMessage[];
      close(): void;
    };
    let server: ReturnType<typeof attachAgentWebSocketServer>;

    beforeEach(() => {
      server = attachAgentWebSocketServer(
        {} as unknown as Parameters<typeof attachAgentWebSocketServer>[0],
      );
    });

    function connect(identity: string): TestSocket {
      const socket = Object.assign(new EventEmitter(), {
        readyState: 1,
        sent: [] as AgentMessage[],
        send(raw: string) {
          this.sent.push(JSON.parse(raw));
        },
        close(this: TestSocket) {
          this.readyState = 3;
          this.emit('close');
        },
      }) as TestSocket;
      server.emit('connection', socket, { headers: { authorization: identity } });
      return socket;
    }
    const say = (socket: TestSocket, sessionId: string, content: string) =>
      socket.emit('message', JSON.stringify({ session_id: sessionId, sender: 'client', content }));
    const userInputs = async (sessionId: string) =>
      (
        JSON.parse((await AgentSession.findByPk(sessionId))!.historyJson) as {
          role: string;
          content: unknown;
        }[]
      )
        .filter((m) => m.role === 'user' && typeof m.content === 'string')
        .map((m) => m.content as string)
        .filter((c) => c.includes('owner') || c.includes('flood'));

    it('rejects a foreign flood before queueing while the owner turn and follow-ups proceed', async () => {
      await seedOwnerSession('session-f');
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mocks.complete.mockImplementationOnce(async () => {
        await gate;
        return finalAnswer('owner answer');
      });
      const owner = connect('sub-a');
      const foreign = connect('sub-b');
      say(owner, 'session-f', 'owner running task');
      await waitFor(() => mocks.complete.mock.calls.length === 1);

      for (let i = 0; i < 30; i++) say(foreign, 'session-f', `flood ${i}`);
      say(owner, 'session-f', 'owner follow-up');
      await waitFor(
        () => foreign.sent.length === 30 && sessionQueues.get('session-f')?.length === 1,
      );

      expect(new Set(foreign.sent.map((m) => m.content))).toEqual(
        new Set([SESSION_UNAVAILABLE_MESSAGE]),
      );
      expect(sessionQueues.get('session-f')!.map((q) => q.subscription.id)).toEqual(['sub-a']);
      expect(sessionActiveSubscriptions.get('session-f')).toEqual({ subscriptionId: 'sub-a' });

      release();
      await waitFor(
        () => mocks.complete.mock.calls.length === 2 && !activeSessions.has('session-f'),
      );
      expect(await userInputs('session-f')).toEqual([
        expect.stringContaining('owner first task'),
        expect.stringContaining('owner running task'),
        expect.stringContaining('owner follow-up'),
      ]);
      expect(owner.sent.some((m) => m.content === SESSION_UNAVAILABLE_MESSAGE)).toBe(false);
      expect(await AgentSession.count({ where: { subscriptionId: 'sub-b' } })).toBe(0);
      owner.close();
      foreign.close();
    });

    it('keeps an owner input queued behind a foreign attempt that loses the creation race', async () => {
      const original = AgentSession.findOrCreate.bind(AgentSession);
      const owner = connect('sub-a');
      vi.spyOn(AgentSession, 'findOrCreate').mockImplementationOnce(async (options) => {
        // B claimed the unused id; A's row lands (another instance) and A
        // sends input while B's unproven attempt still holds the active lock.
        await AgentSession.create({
          id: 'session-claim',
          subscriptionId: 'sub-a',
          title: 'Owner title',
          historyJson: JSON.stringify([{ role: 'system', content: 'system prompt' }]),
          turns: 0,
          lastActiveAt: new Date(),
        });
        say(owner, 'session-claim', 'owner input during claim');
        await waitFor(() => sessionQueues.get('session-claim')?.length === 1);
        return original(options);
      });
      const foreign = connect('sub-b');
      say(foreign, 'session-claim', 'foreign claim');

      await waitFor(
        () =>
          foreign.sent.length === 1 &&
          mocks.complete.mock.calls.length === 1 &&
          !activeSessions.has('session-claim'),
      );
      expect(foreign.sent[0]).toEqual(
        expect.objectContaining({ content: SESSION_UNAVAILABLE_MESSAGE, is_error: true }),
      );
      expect(owner.sent).toContainEqual(
        expect.objectContaining({ content: '<final_answer>\nowner answer\n</final_answer>' }),
      );
      const { row } = await snapshot('session-claim');
      expect(row).toEqual(expect.objectContaining({ subscriptionId: 'sub-a', turns: 1 }));
      expect(row!.historyJson).toContain('owner input during claim');
      expect(row!.historyJson).not.toContain('foreign claim');
      owner.close();
      foreign.close();
    });

    it('fails closed when the pre-queue ownership lookup fails', async () => {
      const before = await seedOwnerSession('session-pq');
      vi.spyOn(AgentSession, 'findOne').mockRejectedValueOnce(new Error('database is locked'));
      const owner = connect('sub-a');
      say(owner, 'session-pq', 'owner input during outage');

      await waitFor(() => owner.sent.length === 1);
      expect(owner.sent[0]).toEqual(
        expect.objectContaining({ content: SESSION_UNAVAILABLE_MESSAGE, is_error: true }),
      );
      expect(activeSessions.has('session-pq')).toBe(false);
      expect(sessionQueues.has('session-pq')).toBe(false);
      // Refused at admission: the turn (and Skills resolution) never started.
      expect(mocks.log.warn).not.toHaveBeenCalledWith(
        'Refused agent turn for an unavailable session',
        expect.anything(),
      );
      expect(mocks.complete).not.toHaveBeenCalled();
      expect(await snapshot('session-pq')).toEqual(before);
      owner.close();
    });
  });

  it('prunes only the owner sessions when the per-subscription cap is exceeded', async () => {
    const old = (minutes: number) => new Date(Date.UTC(2020, 0, 1, 0, minutes));
    await AgentSession.bulkCreate([
      ...Array.from({ length: 50 }, (_, i) => ({
        id: `a-${i}`,
        subscriptionId: 'sub-a',
        title: 'A',
        historyJson: '[]',
        turns: 0,
        lastActiveAt: old(10 + i),
      })),
      // Older than every A row, so an unscoped prune would pick them first.
      {
        id: 'b-0',
        subscriptionId: 'sub-b',
        title: 'B',
        historyJson: '[]',
        turns: 0,
        lastActiveAt: old(0),
      },
    ]);
    const destroy = vi.spyOn(AgentSession, 'destroy');

    await turn(ownerA, 'a-new', 'owner new task');
    await waitFor(() => destroy.mock.calls.length > 0);
    await waitFor(() =>
      mocks.log.info.mock.calls.some(([m]) => m === 'Pruned oldest agent sessions to enforce cap'),
    );

    expect(destroy).toHaveBeenCalledWith({ where: { id: ['a-0'], subscriptionId: 'sub-a' } });
    expect(await AgentSession.findByPk('a-0')).toBeNull();
    expect(await AgentSession.findByPk('b-0')).not.toBeNull();
    expect(await AgentSession.count({ where: { subscriptionId: 'sub-a' } })).toBe(50);
  });

  it('keeps normal owner checkpoints, usage and resumption working', async () => {
    await seedOwnerSession('session-o');
    await turn(foreignB, 'session-o', 'foreign noise');
    vi.clearAllMocks();
    mocks.log.child.mockReturnValue(mocks.log);

    const send = await turn(ownerA, 'session-o', 'owner second task');

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '<final_answer>\nowner answer\n</final_answer>' }),
    );
    const { row, transcript } = await snapshot('session-o');
    expect(row).toEqual(
      expect.objectContaining({ subscriptionId: 'sub-a', turns: 2, totalTokensUsed: 30 }),
    );
    expect(row!.historyJson).toContain('owner first task');
    expect(row!.historyJson).toContain('owner second task');
    expect(row!.historyJson).not.toContain('foreign noise');
    expect(JSON.stringify(transcript)).toContain('owner second task');
  });
});
