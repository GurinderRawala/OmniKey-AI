/**
 * Git session diffs against a real, isolated in-memory SQLite database (the
 * `../db` module is replaced before any model is imported; never the default
 * or live DB). Covers the capture coordinator lifetime, owner/connection
 * matching, immutable compressed storage, run commit provenance, the
 * authenticated SSR route (real @pierre/diffs), and before-final ordering in
 * a real agent turn. Providers, MCP, settings and prompts are mocked.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types';
import { finalAnswer, toolCalls } from './helpers/agentSkillsHarness';

const mocks = vi.hoisted(() => {
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  return { log, complete: vi.fn() };
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
    terminalAccess: 'full',
    webSearchEnabled: false,
    browserAccessEnabled: false,
    browserAccessMethod: null,
    browserJavascriptEventBrowsers: [],
  })),
  getAgentSettingsVersion: vi.fn(() => 1),
  selectedAgentModelForProvider: vi.fn(() => 'test-model'),
}));
vi.mock('../agent/mcpPromptCache', () => ({ getPromptMcpsForSubscription: vi.fn(async () => []) }));
vi.mock('../agent/mcpRuntime', () => ({
  CONNECT_MCP_TOOL_NAME: 'connect_mcp',
  MCP_TOOL_PREFIX: 'mcp__',
  activateMcpServerForSubscription: vi.fn(),
  executeMcpTool: vi.fn(),
  getMcpToolsForSubscription: vi.fn(async () => ({ aiTools: [], dispatch: new Map() })),
}));
vi.mock('../featureRoutes', () => ({
  getDefaultTaskTemplateSnapshot: vi.fn(async () => null),
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
vi.mock('../authMiddleware', () => ({
  authMiddleware: vi.fn((req: any, res: any, next: () => void) => {
    const sub = req.headers['x-test-subscription'];
    if (!sub) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.locals.subscription = { id: sub };
    res.locals.logger = mocks.log;
    next();
  }),
}));

import { sequelize } from '../db';
import { AgentSession } from '../models/agentSession';
import { Subscription } from '../models/subscription';
import { AgentSessionDiff, AgentSessionGitRun } from '../models/agentSessionDiff';
import { AgentTranscriptMessage } from '../models/agentTranscriptMessage';
import { runAgentTurn, createAgentRouter } from '../agent/agentServer';
import {
  captureSessionDiffBeforeFinal,
  createGitRunState,
  recordCommitObservations,
  previousRunProvenance,
  handleGitDiffResponseFrame,
  loadSessionDiffPayload,
  pendingGitDiffCaptureCount,
  persistGitRunProvenance,
  type GitRunState,
} from '../agent/gitDiff/coordinator';
import { planShellGitContext, recordShellGitResult } from '../agent/gitDiff/shellContext';
import type { GitDiffRequest } from '../agent/gitDiff/contracts';
import { clearDiffRenderCacheForTesting } from '../agent/gitDiff/ssrRenderer';
import { setSkillResolverForTesting } from '../agent/skillContext';

const log = mocks.log as any;
const ROOT = '/Users/dev/projects/app';
const OID_1 = '1'.repeat(40);
const OID_2 = '2'.repeat(40);
const OID_3 = '3'.repeat(40);
const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1 +1 @@',
  '-const a = 1;',
  '+const a = "<script>alert(1)</script>";',
  '',
].join('\n');

type Reply = (req: GitDiffRequest) => Record<string, unknown> | null;

/** A run whose client answers git_diff_request on the given connection. */
function runWithClient(
  sessionId: string,
  reply: Reply,
  opts: {
    subscriptionId?: string;
    connection?: AbortController;
    replyAs?: Partial<{
      sessionId: string;
      subscriptionId: string;
      connection: AbortSignal;
    }>;
  } = {},
) {
  const connection = opts.connection ?? new AbortController();
  const subscriptionId = opts.subscriptionId ?? 'sub-a';
  const frames: AgentMessage[] = [];
  const run: GitRunState = createGitRunState({
    sessionId,
    subscriptionId,
    connection: connection.signal,
    send: (msg) => {
      frames.push(msg);
      if (!msg.git_diff_request) return;
      const body = reply(msg.git_diff_request);
      if (!body) return;
      setTimeout(() => {
        handleGitDiffResponseFrame(
          {
            session_id: opts.replyAs?.sessionId ?? sessionId,
            sender: 'client',
            content: '',
            git_diff_response: { request_id: msg.git_diff_request!.request_id, ...body },
          },
          opts.replyAs?.subscriptionId ?? subscriptionId,
          opts.replyAs?.connection ?? connection.signal,
          log,
        );
      }, 1);
    },
  });
  return { run, frames, connection };
}

const okWorkingTree: Reply = () => ({
  status: 'ok',
  repositories: [{ root: ROOT, patch: PATCH, scope: 'working_tree' }],
});

async function newSession(id: string, subscriptionId = 'sub-a') {
  await AgentSession.create({ id, subscriptionId } as any);
}

beforeAll(async () => {
  await sequelize.sync({ force: true });
  await Subscription.bulkCreate([
    { id: 'sub-a', licenseKey: 'key-a', email: 'a@example.test' },
    { id: 'sub-b', licenseKey: 'key-b', email: 'b@example.test' },
  ] as any);
});

afterAll(async () => {
  await sequelize.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  clearDiffRenderCacheForTesting();
});

describe('capture coordinator', () => {
  it('stores an immutable compressed snapshot per final answer', async () => {
    await newSession('s-multi');
    const { run, frames } = runWithClient('s-multi', okWorkingTree);
    run.candidates.add(ROOT, 'user_input');
    const first = await captureSessionDiffBeforeFinal(run, [], undefined, log);
    const second = await captureSessionDiffBeforeFinal(run, [], undefined, log);
    expect(first).toMatchObject({ fileCount: 1, repositoryCount: 1, scope: 'working_tree' });
    expect(first?.commit).toBeUndefined();
    expect(second!.id).not.toBe(first!.id);
    expect(Date.parse(first!.createdAt)).not.toBeNaN();
    // Control frame only: empty content, bounded candidates, no patch.
    const req = frames.find((f) => f.git_diff_request)!;
    expect(req.content).toBe('');
    expect(req.git_diff_request!.candidate_paths).toEqual([ROOT]);
    const row = await AgentSessionDiff.findByPk(first!.id);
    expect(row!.payload.startsWith('gz1:')).toBe(true);
    expect(row!.payload).not.toContain('alert');
    const loaded = await loadSessionDiffPayload('s-multi', 'sub-a', first!.id);
    expect(loaded!.payload).toEqual({
      version: 1,
      repositories: [{ root: ROOT, patch: PATCH, scope: 'working_tree' }],
    });
    expect(await loadSessionDiffPayload('s-multi', 'sub-b', first!.id)).toBeNull();
    expect(pendingGitDiffCaptureCount()).toBe(0);
    // Patch content never reaches logs.
    expect(JSON.stringify(mocks.log.info.mock.calls)).not.toContain('alert');
  });

  it('sends nothing without verifiable candidates', async () => {
    await newSession('s-none');
    const { run, frames } = runWithClient('s-none', okWorkingTree);
    expect(await captureSessionDiffBeforeFinal(run, [], undefined, log)).toBeUndefined();
    expect(frames).toEqual([]);
  });

  it('records nothing for no repository, failure or clean trees', async () => {
    await newSession('s-clean');
    for (const reply of [
      () => ({ status: 'not_repository', repositories: [] }),
      () => ({ status: 'unavailable', repositories: [], reason: 'limit' }),
      () => ({ status: 'ok', repositories: [{ root: ROOT, patch: '' }] }),
      // A failure carrying a partial patch is rejected outright.
      () => ({ status: 'unavailable', repositories: [{ root: ROOT, patch: PATCH }] }),
    ] as Reply[]) {
      const { run } = runWithClient('s-clean', reply);
      run.candidates.add(ROOT, 'user_input');
      expect(await captureSessionDiffBeforeFinal(run, [], undefined, log)).toBeUndefined();
    }
    expect(await AgentSessionDiff.count({ where: { sessionId: 's-clean' } })).toBe(0);
  });

  it('ignores replies from another connection, subscription or session, then times out', async () => {
    await newSession('s-foreign');
    for (const replyAs of [
      { connection: new AbortController().signal },
      { subscriptionId: 'sub-b' },
      { sessionId: 's-other' },
    ]) {
      const { run } = runWithClient('s-foreign', okWorkingTree, { replyAs });
      run.candidates.add(ROOT, 'user_input');
      const started = Date.now();
      expect(await captureSessionDiffBeforeFinal(run, [], undefined, log, 40)).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(1_000);
    }
    expect(pendingGitDiffCaptureCount()).toBe(0);
    // A stale reply for a settled request is consumed and ignored.
    expect(
      handleGitDiffResponseFrame(
        {
          session_id: 's-foreign',
          sender: 'client',
          content: '',
          git_diff_response: { request_id: 'stale', status: 'ok', repositories: [] },
        },
        'sub-a',
        new AbortController().signal,
        log,
      ),
    ).toBe(true);
    expect(await AgentSessionDiff.count({ where: { sessionId: 's-foreign' } })).toBe(0);
  });

  it('settles promptly on disconnect', async () => {
    await newSession('s-abort');
    const connection = new AbortController();
    const { run } = runWithClient('s-abort', () => null, { connection });
    run.candidates.add(ROOT, 'user_input');
    const pending = captureSessionDiffBeforeFinal(run, [], undefined, log);
    setTimeout(() => connection.abort(), 5);
    const started = Date.now();
    expect(await pending).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(pendingGitDiffCaptureCount()).toBe(0);
    // Already disconnected: no request at all.
    const { run: gone, frames } = runWithClient('s-abort', okWorkingTree, { connection });
    gone.candidates.add(ROOT, 'user_input');
    expect(await captureSessionDiffBeforeFinal(gone, [], undefined, log)).toBeUndefined();
    expect(frames).toEqual([]);
  });
});

describe('commit provenance', () => {
  function shell(run: GitRunState, script: string, observations: unknown, args = {}) {
    const plan = planShellGitContext(run, { script, ...args }, script);
    recordShellGitResult(run, plan, script, 'TERMINAL OUTPUT:\nok', observations);
    return plan;
  }

  it('uses a clean verified agent commit, persists it for the next run only', async () => {
    await newSession('s-prov');
    const commitReply: Reply = (req) => ({
      status: 'ok',
      repositories: req.eligible_commits.map((c) => ({
        root: c.root,
        patch: PATCH,
        scope: 'commit',
        commit: c.commit,
      })),
    });

    // Run 1: the agent commits through a literal `git commit` shell.
    const one = runWithClient('s-prov', commitReply);
    const plan = shell(
      one.run,
      'git add -A && git commit -m "fix"',
      [{ root: ROOT, before: OID_1, after: OID_2 }],
      { working_directory: ROOT },
    );
    expect(plan.workingDirectory).toBe(ROOT);
    expect(plan.context?.candidate_paths).toEqual([ROOT]);
    const s1 = await captureSessionDiffBeforeFinal(one.run, [], undefined, log);
    const req1 = one.frames.find((f) => f.git_diff_request)!.git_diff_request!;
    expect(req1.eligible_commits).toEqual([{ root: ROOT, commit: OID_2 }]);
    expect(s1).toMatchObject({ scope: 'commit', commit: OID_2, fileCount: 1 });

    // Run 2 (e.g. after reopening): the previous run's commit is eligible.
    await new Promise((r) => setTimeout(r, 5));
    const two = runWithClient('s-prov', commitReply);
    const s2 = await captureSessionDiffBeforeFinal(two.run, [], undefined, log);
    const req2 = two.frames.find((f) => f.git_diff_request)!.git_diff_request!;
    expect(req2.eligible_commits).toEqual([{ root: ROOT, commit: OID_2 }]);
    expect(req2.candidate_paths).toEqual([ROOT]);
    expect(s2?.commit).toBe(OID_2);

    // Run 3: run 2 observed nothing, so the older commit is no longer eligible.
    await new Promise((r) => setTimeout(r, 5));
    const three = runWithClient('s-prov', () => ({
      status: 'ok',
      repositories: [{ root: ROOT, patch: PATCH, scope: 'commit', commit: OID_2 }],
    }));
    three.run.candidates.add(ROOT, 'user_input');
    expect(await captureSessionDiffBeforeFinal(three.run, [], undefined, log)).toBeUndefined();
    const req3 = three.frames.find((f) => f.git_diff_request)!.git_diff_request!;
    expect(req3.eligible_commits).toEqual([]);
    expect(await AgentSessionGitRun.count({ where: { sessionId: 's-prov' } })).toBe(3);
  });

  it('never attributes checkout/reset/scripted/unrelated HEAD changes', async () => {
    await newSession('s-noattr');
    const { run } = runWithClient('s-noattr', okWorkingTree);
    run.candidates.add(ROOT, 'user_input');
    shell(run, 'git checkout main', [{ root: ROOT, before: OID_1, after: OID_2 }]);
    shell(run, 'git reset --hard HEAD~1', [{ root: ROOT, before: OID_2, after: OID_1 }]);
    shell(run, './release.sh', [{ root: ROOT, before: OID_1, after: OID_3 }]);
    shell(run, 'git commit -m x', [{ root: '/Users/dev/other', before: OID_1, after: OID_3 }]);
    shell(run, 'git commit -m x', [{ root: ROOT, before: OID_1, after: OID_1 }]);
    shell(run, 'git commit -m x', [{ root: ROOT, before: 'nope', after: OID_3 }]);
    expect(run.observations).toEqual([]);
  });

  it('keeps dirty working trees and verified commits apart (mixed scope)', async () => {
    await newSession('s-mixed');
    const other = '/Users/dev/projects/lib';
    const { run } = runWithClient('s-mixed', (req) => ({
      status: 'ok',
      repositories: [
        { root: ROOT, patch: PATCH, scope: 'working_tree' },
        { root: other, patch: PATCH, scope: 'commit', commit: req.eligible_commits[0].commit },
      ],
    }));
    run.candidates.add(ROOT, 'user_input');
    shell(run, `git -C ${other} commit -m x`, [{ root: other, before: null, after: OID_3 }]);
    const summary = await captureSessionDiffBeforeFinal(run, [], undefined, log);
    expect(summary).toMatchObject({ scope: 'mixed', repositoryCount: 2, fileCount: 2 });
    expect(summary?.commit).toBeUndefined();
  });

  it('cascades snapshots and provenance with the owning session', async () => {
    await newSession('s-cascade');
    const { run } = runWithClient('s-cascade', okWorkingTree);
    run.candidates.add(ROOT, 'user_input');
    await captureSessionDiffBeforeFinal(run, [], undefined, log);
    await persistGitRunProvenance(run, log);
    await AgentSession.destroy({ where: { id: 's-cascade' } });
    expect(await AgentSessionDiff.count({ where: { sessionId: 's-cascade' } })).toBe(0);
    expect(await AgentSessionGitRun.count({ where: { sessionId: 's-cascade' } })).toBe(0);
  });
});

describe('GET /api/agent/sessions/:sessionId/diffs/:diffId', () => {
  const app = express();
  app.use('/api/agent', createAgentRouter());

  it('requires auth, owner and session match, and returns real Pierre HTML', async () => {
    await newSession('s-route');
    await newSession('s-route-2');
    await newSession('s-route-b', 'sub-b');
    const { run } = runWithClient('s-route', okWorkingTree);
    run.candidates.add(ROOT, 'user_input');
    const summary = (await captureSessionDiffBeforeFinal(run, [], undefined, log))!;
    const url = `/api/agent/sessions/s-route/diffs/${summary.id}`;

    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set('x-test-subscription', 'sub-b')).status).toBe(404);
    expect(
      (
        await request(app)
          .get(`/api/agent/sessions/s-route-2/diffs/${summary.id}`)
          .set('x-test-subscription', 'sub-a')
      ).status,
    ).toBe(404);
    expect(
      (await request(app).get(`${url}?theme=evil`).set('x-test-subscription', 'sub-a')).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get('/api/agent/sessions/s-route/diffs/..%2F..%2Fetc')
          .set('x-test-subscription', 'sub-a')
      ).status,
    ).toBe(400);

    const ok = await request(app).get(`${url}?theme=light`).set('x-test-subscription', 'sub-a');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(ok.body.id).toBe(summary.id);
    expect(ok.body.html).toContain('data-theme="light"');
    expect(ok.body.html).toContain('<template shadowrootmode="open">');
    expect(ok.body.html).not.toMatch(/<script/i);
    expect(ok.body.html).toContain('&#x3C;script>');
  });
});

describe('agent turn integration', () => {
  let restoreResolver: () => void = () => undefined;
  beforeEach(() => {
    restoreResolver = setSkillResolverForTesting(async () => ({ matches: [], warnings: [] }));
  });
  afterEach(() => restoreResolver());

  async function turn(
    sessionId: string,
    content: string,
    supportsGitDiff: boolean,
    reply: Reply = okWorkingTree,
  ) {
    const connection = new AbortController();
    const frames: AgentMessage[] = [];
    const send = (msg: AgentMessage) => {
      frames.push(msg);
      if (msg.git_diff_request) {
        setTimeout(() => {
          handleGitDiffResponseFrame(
            {
              session_id: sessionId,
              sender: 'client',
              content: '',
              git_diff_response: {
                request_id: msg.git_diff_request!.request_id,
                ...reply(msg.git_diff_request!),
              },
            },
            'sub-a',
            connection.signal,
            log,
          );
        }, 1);
      }
    };
    await runAgentTurn(
      sessionId,
      { id: 'sub-a' } as any,
      { session_id: sessionId, sender: 'client', content, platform: 'macos' },
      send,
      log,
      { signal: connection.signal, interactiveInput: true, skipGrouping: true, supportsGitDiff },
    );
    return frames;
  }

  it('requests the snapshot before the final, persists metadata, strips it from providers', async () => {
    mocks.complete.mockResolvedValue(finalAnswer('done'));
    const frames = await turn('s-turn', `Please fix ${ROOT}/src/a.ts`, true);
    const requestIndex = frames.findIndex((f) => f.git_diff_request);
    const finalIndex = frames.findIndex((f) => f.content.includes('<final_answer>'));
    expect(requestIndex).toBeGreaterThanOrEqual(0);
    expect(requestIndex).toBeLessThan(finalIndex);
    expect(frames[requestIndex].git_diff_request!.candidate_paths).toEqual([ROOT]);
    const live = frames[finalIndex].session_diff!;
    expect(live).toMatchObject({ scope: 'working_tree', fileCount: 1 });

    const row = await AgentSession.findByPk('s-turn');
    const history = JSON.parse(row!.historyJson);
    expect(history[history.length - 1].session_diff).toEqual(live);
    const transcript = await AgentTranscriptMessage.findAll({
      where: { sessionId: 's-turn' },
      order: [['sequence', 'ASC']],
    });
    const blocks = JSON.parse(transcript[transcript.length - 1].previewJson).blocks;
    expect(blocks.find((b: any) => b.kind === 'finalAnswer').sessionDiff).toEqual(live);

    // Second turn: a new immutable snapshot; the old reference is unchanged
    // and the provider request never carries snapshot metadata.
    const frames2 = await turn('s-turn', 'and again', true);
    const live2 = frames2.find((f) => f.session_diff)!.session_diff!;
    expect(live2.id).not.toBe(live.id);
    const providerHistory = mocks.complete.mock.calls.at(-1)![1] as any[];
    expect(providerHistory.some((m) => 'session_diff' in m)).toBe(false);
    const history2 = JSON.parse((await AgentSession.findByPk('s-turn'))!.historyJson);
    const refs = history2.filter((m: any) => m.session_diff).map((m: any) => m.session_diff.id);
    expect(refs).toEqual([live.id, live2.id]);
  });

  it('forwards structured shell context and accepts observations only on the shell reply', async () => {
    mocks.complete
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'call-1',
            name: 'shell_script',
            arguments: { script: 'git commit -am "x"', working_directory: ROOT },
          },
        ]),
      )
      .mockResolvedValue(finalAnswer('committed'));
    const { pendingShellScripts } = await import('../agent/agentServer/runtimeState');
    const sessionId = 's-shell';
    const connection = new AbortController();
    const frames: AgentMessage[] = [];
    const send = (msg: AgentMessage) => {
      frames.push(msg);
      if (msg.content.startsWith('<shell_script>')) {
        setTimeout(() => {
          pendingShellScripts
            .get(sessionId)!
            .resolve('TERMINAL OUTPUT:\n[main 2222] x', false, [
              { root: ROOT, before: OID_1, after: OID_2 },
            ]);
        }, 1);
      }
      if (msg.git_diff_request) {
        setTimeout(() => {
          handleGitDiffResponseFrame(
            {
              session_id: sessionId,
              sender: 'client',
              content: '',
              git_diff_response: {
                request_id: msg.git_diff_request!.request_id,
                status: 'ok',
                repositories: [{ root: ROOT, patch: PATCH, scope: 'commit', commit: OID_2 }],
              },
            },
            'sub-a',
            connection.signal,
            log,
          );
        }, 1);
      }
    };
    await runAgentTurn(
      sessionId,
      { id: 'sub-a' } as any,
      { session_id: sessionId, sender: 'client', content: 'commit it', platform: 'macos' },
      send,
      log,
      {
        signal: connection.signal,
        interactiveInput: true,
        skipGrouping: true,
        supportsGitDiff: true,
      },
    );
    const shellFrame = frames.find((f) => f.content.startsWith('<shell_script>'))!;
    expect(shellFrame.working_directory).toBe(ROOT);
    expect(shellFrame.git_diff_context).toEqual({ candidate_paths: [ROOT] });
    const tools = mocks.complete.mock.calls[0][2].tools as any[];
    expect(tools.find((t) => t.name === 'shell_script').parameters.properties).toHaveProperty(
      'working_directory',
    );
    const req = frames.find((f) => f.git_diff_request)!.git_diff_request!;
    expect(req.eligible_commits).toEqual([{ root: ROOT, commit: OID_2 }]);
    expect(frames.find((f) => f.session_diff)!.session_diff).toMatchObject({
      scope: 'commit',
      commit: OID_2,
    });
  });

  it('does not persist a superseded final when steering arrives during capture', async () => {
    mocks.complete
      .mockResolvedValueOnce(finalAnswer('superseded candidate'))
      .mockResolvedValue(finalAnswer('updated answer'));
    const { enqueueSteeringMessage } = await import('../agent/agentServer/steering');
    let captures = 0;
    const frames = await turn('s-capture-steer', `Work in ${ROOT}`, true, () => {
      if (captures++ === 0) {
        enqueueSteeringMessage(
          's-capture-steer',
          {
            session_id: 's-capture-steer',
            sender: 'client',
            content: 'Use the updated requirements',
            is_steering: true,
            steering_id: 'during-capture',
          },
          log,
        );
      }
      return { status: 'ok', repositories: [{ root: ROOT, patch: PATCH, scope: 'working_tree' }] };
    });
    const saved = await AgentSession.findByPk('s-capture-steer');
    const finals = JSON.parse(saved!.historyJson).filter(
      (m: { role: string; content: string }) =>
        m.role === 'assistant' && m.content.includes('<final_answer>'),
    );
    expect(
      finals.some((m: { content: string }) => m.content.includes('superseded candidate')),
    ).toBe(false);
    expect(frames.some((f) => f.content.includes('superseded candidate'))).toBe(false);
    expect(finals.at(-1).session_diff).toBeTruthy();
  });

  it('rejects invalid structured execution directories without sending a shell', async () => {
    mocks.complete
      .mockResolvedValueOnce(
        toolCalls([
          {
            id: 'invalid-dir',
            name: 'shell_script',
            arguments: { script: 'touch should-not-run', working_directory: '../elsewhere' },
          },
        ]),
      )
      .mockResolvedValueOnce(finalAnswer('Could not execute'));
    const frames = await turn('s-invalid-directory', `Work in ${ROOT}`, true);
    expect(frames.some((f) => f.content.startsWith('<shell_script>'))).toBe(false);
    const saved = await AgentSession.findByPk('s-invalid-directory');
    expect(saved?.historyJson).toContain('Script was not executed');
  });

  it('writes an empty provenance barrier for an intervening non-capable run', async () => {
    await newSession('s-barrier');
    const old = runWithClient('s-barrier', okWorkingTree).run;
    recordCommitObservations(old, [{ root: ROOT, before: OID_1, after: OID_2 }]);
    await persistGitRunProvenance(old, log);
    mocks.complete.mockResolvedValue(finalAnswer('legacy completed'));
    await turn('s-barrier', 'unrelated followup', false);
    const next = runWithClient('s-barrier', okWorkingTree).run;
    expect((await previousRunProvenance(next)).commits).toEqual([]);
  });

  it('never captures for a client that did not advertise support', async () => {
    mocks.complete.mockResolvedValue(finalAnswer('done'));
    const frames = await turn('s-legacy', `Please fix ${ROOT}/src/a.ts`, false);
    expect(frames.some((f) => f.git_diff_request)).toBe(false);
    expect(frames.some((f) => f.session_diff)).toBe(false);
    const tools = mocks.complete.mock.calls[0][2].tools as any[];
    expect(tools.find((t) => t.name === 'shell_script').parameters.properties).not.toHaveProperty(
      'working_directory',
    );
    expect(await AgentSessionDiff.count({ where: { sessionId: 's-legacy' } })).toBe(0);
  });
});
