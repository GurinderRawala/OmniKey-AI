/**
 * Git per-turn diffs (contract v3, `supports_git_turn_diff: true`) against a
 * real, isolated in-memory SQLite database, a fake native client on the run's
 * own control path, and the real Pierre SSR route. Providers, MCP, settings
 * and prompts are mocked. Legacy behaviour is covered by gitDiff.storage.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types';
import { finalAnswer, toolCalls } from './helpers/agentSkillsHarness';

const mocks = vi.hoisted(() => {
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  return { log, complete: vi.fn(), nextResult: vi.fn() };
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
import { AgentSessionDiff } from '../models/agentSessionDiff';
import { runAgentTurn, createAgentRouter } from '../agent/agentServer';
import {
  captureSessionDiffBeforeFinal,
  captureTurnBaselines,
  createGitRunState,
  handleGitDiffResponseFrame,
  loadSessionDiffPayload,
  pendingGitDiffCaptureCount,
  recordTurnBaselines,
} from '../agent/gitDiff/coordinator';
import {
  cleanSessionDiffSummary,
  validateGitBaselineResponse,
  validateGitTurnFinalResponse,
  type GitDiffRequest,
} from '../agent/gitDiff/contracts';
import { clearDiffRenderCacheForTesting } from '../agent/gitDiff/ssrRenderer';
import { setSkillResolverForTesting } from '../agent/skillContext';

const log = mocks.log as any;
const ROOT = '/Users/dev/projects/app';
const OTHER = '/Users/dev/projects/lib';
const OID_1 = '1'.repeat(40);
const OID_2 = '2'.repeat(40);
const OID_3 = '3'.repeat(40);

function filePatch(path: string, line = 'x'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    `+${line}`,
    '',
  ].join('\n');
}
/** Two commits plus an uncommitted edit, as one net patch BASE -> worktree. */
const TWO_COMMITS_PATCH =
  filePatch('src/committed-1.ts') + filePatch('src/committed-2.ts') + filePatch('src/dirty.ts');

type Body = Record<string, unknown> | null;
interface ClientOptions {
  heads: Record<string, string | null>;
  baseline?: (req: GitDiffRequest) => Body;
  final?: (req: GitDiffRequest) => Body;
  shell?: (frame: AgentMessage) => { output: string; observations?: unknown };
  replyAs?: { subscriptionId?: string; connection?: AbortSignal };
}

function defaultBaseline(heads: Record<string, string | null>) {
  return (req: GitDiffRequest): Body => ({
    status: 'ok',
    repositories: [],
    baselines: req.candidate_paths
      .filter((p) => p in heads)
      .map((root) => ({
        root,
        head: heads[root],
        capturedAt: new Date().toISOString(),
        source: req.baseline_source,
      })),
  });
}

function turnReply(patch: string, head: string | null = OID_3) {
  return (req: GitDiffRequest): Body => ({
    status: 'ok',
    repositories: (req.baselines ?? []).map((b) => ({
      root: b.root,
      patch,
      scope: 'turn',
      baselineHead: b.head,
      head,
      baselineCapturedAt: b.capturedAt,
      baselineSource: b.source,
    })),
  });
}

/** Fake macOS client answering on the run's own control path. */
function fakeClient(sessionId: string, opts: ClientOptions) {
  const connection = new AbortController();
  const frames: AgentMessage[] = [];
  const events: string[] = [];
  const send = async (msg: AgentMessage) => {
    frames.push(msg);
    if (msg.content.startsWith('<shell_script>')) {
      events.push('shell');
      const { pendingShellScripts } = await import('../agent/agentServer/runtimeState');
      const reply = opts.shell?.(msg) ?? { output: 'TERMINAL OUTPUT:\nok' };
      setTimeout(
        () => pendingShellScripts.get(sessionId)?.resolve(reply.output, false, reply.observations),
        1,
      );
    }
    const req = msg.git_diff_request;
    if (!req) return;
    events.push(`${req.phase ?? 'legacy'}:${req.baseline_source ?? ''}`);
    const body =
      req.phase === 'baseline'
        ? (opts.baseline ?? defaultBaseline(opts.heads))(req)
        : (opts.final ?? turnReply(TWO_COMMITS_PATCH))(req);
    if (!body) return;
    setTimeout(() => {
      handleGitDiffResponseFrame(
        {
          session_id: sessionId,
          sender: 'client',
          content: '',
          git_diff_response: { request_id: req.request_id, ...body },
        },
        opts.replyAs?.subscriptionId ?? 'sub-a',
        opts.replyAs?.connection ?? connection.signal,
        log,
      );
    }, 1);
  };
  return { connection, frames, events, send: (m: AgentMessage) => void send(m) };
}

async function turn(
  sessionId: string,
  content: string,
  opts: ClientOptions,
  capability: { diff?: boolean; turn?: boolean; filesystem?: boolean } = { diff: true, turn: true },
) {
  const client = fakeClient(sessionId, opts);
  mocks.complete.mockImplementation(async (...args: unknown[]) => {
    client.events.push('model');
    return mocks.nextResult(...args);
  });
  await runAgentTurn(
    sessionId,
    { id: 'sub-a' } as any,
    { session_id: sessionId, sender: 'client', content, platform: 'macos' },
    client.send,
    log,
    {
      signal: client.connection.signal,
      interactiveInput: true,
      skipGrouping: true,
      supportsGitDiff: capability.diff === true,
      supportsGitTurnDiff: capability.turn === true,
      supportsFilesystemDiff: capability.filesystem === true,
      supportsAgentPatches: capability.filesystem === true,
    },
  );
  const requests = client.frames.filter((f) => f.git_diff_request).map((f) => f.git_diff_request!);
  return { ...client, requests };
}

function queueResults(...results: unknown[]) {
  const queue = [...results];
  mocks.nextResult.mockImplementation(async () => queue.shift() ?? finalAnswer('done'));
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
let restoreResolver: () => void = () => undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  clearDiffRenderCacheForTesting();
  restoreResolver = setSkillResolverForTesting(async () => ({ matches: [], warnings: [] }));
});
afterEach(() => restoreResolver());

describe('turn baselines in a real agent turn', () => {
  it('baselines before the first provider call and persists a turn snapshot with 2 commits', async () => {
    queueResults(finalAnswer('done'));
    const t = await turn('t-start', `Please fix ${ROOT}/src/a.ts`, { heads: { [ROOT]: OID_1 } });
    expect(t.events).toEqual(['baseline:turn_start', 'model', 'final:']);
    const [baselineReq, finalReq] = t.requests;
    expect(baselineReq).toMatchObject({
      phase: 'baseline',
      baseline_source: 'turn_start',
      candidate_paths: [ROOT],
      eligible_commits: [],
      baselines: [],
    });
    expect(finalReq).toMatchObject({
      phase: 'final',
      display_limit: 300,
      eligible_commits: [],
      candidate_paths: [ROOT],
    });
    expect(finalReq.baselines).toEqual([
      { root: ROOT, head: OID_1, capturedAt: expect.any(String), source: 'turn_start' },
    ]);
    const live = t.frames.find((f) => f.session_diff)!.session_diff!;
    expect(live).toMatchObject({
      scope: 'turn',
      fileCount: 3,
      repositoryCount: 1,
      displayLimit: 300,
    });
    expect(live.commit).toBeUndefined();
    expect(cleanSessionDiffSummary(live)).toEqual(live);
    const stored = await loadSessionDiffPayload('t-start', 'sub-a', live.id);
    expect(stored!.payload).toMatchObject({
      version: 1,
      displayLimit: 300,
      baselines: finalReq.baselines,
      repositories: [
        {
          root: ROOT,
          scope: 'turn',
          patch: TWO_COMMITS_PATCH,
          baselineHead: OID_1,
          head: OID_3,
          baselineSource: 'turn_start',
          baselineCapturedAt: finalReq.baselines![0].capturedAt,
        },
      ],
    });
    expect(stored!.row.payload.startsWith('gz1:')).toBe(true);
    expect(stored!.row.scope).toBe('turn');
    // Control frames are never provider/transcript content.
    const providerHistory = JSON.stringify(mocks.complete.mock.calls);
    expect(providerHistory).not.toContain('git_diff');
    expect(providerHistory).not.toContain('committed-1');
    expect(pendingGitDiffCaptureCount()).toBe(0);
  });

  it('a reused session requests a fresh HEAD on the next turn (never the previous baseline)', async () => {
    queueResults(finalAnswer('one'));
    await turn('t-rebase', `Work in ${ROOT}`, { heads: { [ROOT]: OID_1 } });
    queueResults(finalAnswer('two'));
    // No path typed: the previous run's candidates drive the new baseline.
    const second = await turn('t-rebase', 'continue', { heads: { [ROOT]: OID_3 } });
    expect(second.requests[0]).toMatchObject({ phase: 'baseline', candidate_paths: [ROOT] });
    expect(second.requests[1].baselines).toEqual([
      expect.objectContaining({ root: ROOT, head: OID_3, source: 'turn_start' }),
    ]);
  });

  it('baselines a newly discovered tool directory before forwarding the shell, never re-baselines', async () => {
    queueResults(
      toolCalls([
        { id: 'c1', name: 'shell_script', arguments: { script: 'ls', working_directory: OTHER } },
      ]),
      toolCalls([
        { id: 'c2', name: 'shell_script', arguments: { script: `cd ${OTHER} && ls` } },
        {
          id: 'c3',
          name: 'shell_script',
          arguments: { script: 'git status', working_directory: ROOT },
        },
      ]),
      toolCalls([{ id: 'c4', name: 'shell_script', arguments: { script: 'pwd' } }]),
      finalAnswer('done'),
    );
    let heads: Record<string, string | null> = { [ROOT]: OID_1, [OTHER]: OID_2 };
    const t = await turn('t-tool', `Work in ${ROOT}`, {
      get heads() {
        return heads;
      },
      shell: (frame) => {
        // Later HEAD moves must never become a baseline.
        heads = { [ROOT]: OID_3, [OTHER]: OID_3, '/Users/dev/projects/late': OID_3 };
        return frame.content.includes('pwd')
          ? { output: 'TERMINAL OUTPUT:\n/Users/dev/projects/late' }
          : { output: 'TERMINAL OUTPUT:\nok' };
      },
      final: turnReply(filePatch('a.ts')),
    } as ClientOptions);
    expect(t.events).toEqual([
      'baseline:turn_start',
      'model',
      'baseline:before_tool',
      'shell',
      'model',
      'shell',
      'shell',
      'model',
      'shell',
      'model',
      'final:',
    ]);
    const beforeTool = t.requests[1];
    expect(beforeTool).toMatchObject({ baseline_source: 'before_tool', candidate_paths: [OTHER] });
    const final = t.requests.at(-1)!;
    expect(final.baselines).toEqual([
      expect.objectContaining({ root: ROOT, head: OID_1, source: 'turn_start' }),
      expect.objectContaining({ root: OTHER, head: OID_2, source: 'before_tool' }),
    ]);
    // pwd-discovered roots are final candidates but never retroactively baselined.
    expect(final.candidate_paths).toContain('/Users/dev/projects/late');
  });

  it('withholds a known-partial snapshot when the turn-start baseline is unavailable', async () => {
    queueResults(finalAnswer('done'));
    const t = await turn('t-missing', `Work in ${ROOT}`, {
      heads: {},
      baseline: () => ({ status: 'unavailable', repositories: [] }),
      final: (req) => {
        expect(req.baselines).toEqual([]);
        return {
          status: 'ok',
          repositories: [{ root: ROOT, patch: filePatch('dirty.ts'), scope: 'working_tree' }],
        };
      },
    });
    // "Working tree vs HEAD" cannot prove what this turn changed: no card,
    // nothing stored, the final answer is unchanged.
    expect(t.frames.some((f) => f.session_diff)).toBe(false);
    expect(t.frames.some((f) => f.content.includes('<final_answer>'))).toBe(true);
    expect(await AgentSessionDiff.count({ where: { sessionId: 't-missing' } })).toBe(0);
  });

  it('rejects a turn-scope or commit claim for a root without a recorded baseline', async () => {
    for (const repository of [
      {
        root: ROOT,
        patch: filePatch('x.ts'),
        scope: 'turn',
        baselineHead: OID_1,
        head: OID_2,
        baselineCapturedAt: new Date().toISOString(),
        baselineSource: 'turn_start',
      },
      { root: ROOT, patch: filePatch('x.ts'), scope: 'commit', commit: OID_2 },
    ]) {
      queueResults(finalAnswer('done'));
      const t = await turn('t-forged', `Work in ${ROOT}`, {
        heads: {},
        baseline: () => null, // never answers: bounded timeout
        final: () => ({ status: 'ok', repositories: [repository] }),
      });
      expect(t.frames.some((f) => f.session_diff)).toBe(false);
      expect(t.frames.some((f) => f.content.includes('<final_answer>'))).toBe(true);
    }
    expect(await AgentSessionDiff.count({ where: { sessionId: 't-forged' } })).toBe(0);
  }, 30_000);

  it('ignores baseline replies from another owner or connection (no baseline recorded)', async () => {
    for (const replyAs of [
      { subscriptionId: 'sub-b' },
      { connection: new AbortController().signal },
    ]) {
      queueResults(finalAnswer('done'));
      const t = await turn('t-owner', `Work in ${ROOT}`, {
        heads: { [ROOT]: OID_1 },
        replyAs,
        final: () => null,
      });
      // The final request (whose reply is also foreign) carries no baselines.
      expect(t.requests.at(-1)!.baselines).toEqual([]);
      expect(t.frames.some((f) => f.content.includes('<final_answer>'))).toBe(true);
    }
    expect(pendingGitDiffCaptureCount()).toBe(0);
  }, 40_000);

  it('keeps the legacy flow (no phase, eligible commits) without the new capability', async () => {
    queueResults(finalAnswer('done'));
    const t = await turn(
      't-legacy',
      `Work in ${ROOT}`,
      { heads: {}, final: () => ({ status: 'ok', repositories: [] }) },
      { diff: true, turn: false },
    );
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).not.toHaveProperty('phase');
    expect(t.requests[0]).not.toHaveProperty('display_limit');
    expect(t.events).toEqual(['model', 'legacy:']);
  });
});

describe('coordinator and validation units', () => {
  function run(sessionId = 'u-run') {
    return createGitRunState({
      sessionId,
      subscriptionId: 'sub-a',
      send: () => {},
      turnDiff: true,
    });
  }
  const now = { notBefore: Date.now(), now: Date.now() };
  const baselineReq = {
    request_id: 'req1',
    candidate_paths: [ROOT],
    baseline_source: 'turn_start' as const,
  };
  const good = {
    root: ROOT,
    head: OID_1,
    capturedAt: new Date().toISOString(),
    source: 'turn_start',
  };

  it('records one baseline per canonical root and never overwrites (aliases merged)', () => {
    const r = run();
    recordTurnBaselines(r, [{ ...good, root: '/private/tmp/repo/x', source: 'turn_start' } as any]);
    recordTurnBaselines(r, [
      { ...good, root: '/tmp/repo/x', head: OID_3, source: 'before_tool' } as any,
    ]);
    expect(r.baselines).toEqual([expect.objectContaining({ head: OID_1, source: 'turn_start' })]);
  });

  it('validates baseline replies strictly', () => {
    const ok = validateGitBaselineResponse(
      {
        request_id: 'req1',
        status: 'ok',
        repositories: [],
        baselines: [good, { ...good, root: `${ROOT}/sub`, head: null }],
      },
      baselineReq,
      now,
    );
    expect(ok.baselines).toHaveLength(2);
    expect(ok.baselines![1].head).toBeNull(); // unborn
    const bad = [
      { baselines: [{ ...good, source: 'before_tool' }] },
      { baselines: [{ ...good, head: 'nope' }] },
      { baselines: [{ ...good, root: '/Users/dev/unrelated' }] },
      { baselines: [{ ...good, capturedAt: '2001-01-01T00:00:00Z' }] },
      { baselines: [{ ...good, capturedAt: 'yesterday' }] },
      { baselines: [good, { ...good, root: `${ROOT}/` }] },
      { repositories: [{ root: ROOT, patch: 'x' }], baselines: [] },
      { status: 'unavailable', baselines: [good] },
      { baselines: Array.from({ length: 9 }, (_, i) => ({ ...good, root: `${ROOT}/${i}` })) },
    ];
    for (const extra of bad) {
      expect(() =>
        validateGitBaselineResponse(
          { request_id: 'req1', status: 'ok', repositories: [], ...extra },
          baselineReq,
          now,
        ),
      ).toThrow();
    }
  });

  it('accepts only exact earlier baseline echoes for a later alias request', () => {
    const later = {
      ...baselineReq,
      candidate_paths: ['/Users/dev/alias'],
      baseline_source: 'before_tool' as const,
    };
    const reply = {
      request_id: baselineReq.request_id,
      status: 'ok',
      repositories: [],
      baselines: [{ ...good, source: 'turn_start' as const }],
    };
    expect(
      validateGitBaselineResponse(reply, later, now, [{ ...good, source: 'turn_start' as const }])
        .baselines?.[0].head,
    ).toBe(good.head);
    expect(() =>
      validateGitBaselineResponse({ ...reply, baselines: [{ ...good, head: OID_3 }] }, later, now, [
        { ...good, source: 'turn_start' as const },
      ]),
    ).toThrow();
  });

  it('validates final turn repositories against the recorded baseline (binary/unborn)', () => {
    const unborn = {
      root: ROOT,
      head: null,
      capturedAt: good.capturedAt,
      source: 'turn_start' as const,
    };
    const req = { request_id: 'f1', candidate_paths: [ROOT], baselines: [unborn] };
    const binary =
      'diff --git a/img.png b/img.png\nnew file mode 100644\nindex 0000000..1111111\nBinary files /dev/null and b/img.png differ\n';
    const entry = {
      root: ROOT,
      patch: binary,
      scope: 'turn',
      baselineHead: null,
      head: OID_2,
      baselineCapturedAt: good.capturedAt,
      baselineSource: 'turn_start',
    };
    const res = validateGitTurnFinalResponse(
      { request_id: 'f1', status: 'ok', repositories: [entry] },
      req,
    );
    expect(res.repositories[0]).toMatchObject({ scope: 'turn', baselineHead: null, head: OID_2 });
    expect(
      validateGitTurnFinalResponse(
        { request_id: 'f1', status: 'ok', repositories: [{ ...entry, head: null }] },
        req,
      ).repositories[0].head,
    ).toBeNull();
    for (const forged of [
      { ...entry, baselineHead: OID_1 },
      { ...entry, baselineSource: 'before_tool' },
      { ...entry, baselineCapturedAt: new Date(Date.now() + 1000).toISOString() },
      { ...entry, head: 'zz' },
      { ...entry, commit: OID_2 },
      { root: ROOT, patch: binary, scope: 'working_tree' }, // baselined root must be "turn"
    ]) {
      expect(() =>
        validateGitTurnFinalResponse(
          { request_id: 'f1', status: 'ok', repositories: [forged] },
          req,
        ),
      ).toThrow();
    }
    const born = { ...req, baselines: [{ ...unborn, head: OID_1 }] };
    expect(() =>
      validateGitTurnFinalResponse(
        {
          request_id: 'f1',
          status: 'ok',
          repositories: [{ ...entry, baselineHead: OID_1, head: null }],
        },
        born,
      ),
    ).toThrow();
  });

  it('times out a stalled baseline, marks it attempted, and ignores the late reply', async () => {
    await AgentSession.create({ id: 'u-late', subscriptionId: 'sub-a' } as any);
    const frames: AgentMessage[] = [];
    const connection = new AbortController();
    const r = createGitRunState({
      sessionId: 'u-late',
      subscriptionId: 'sub-a',
      connection: connection.signal,
      send: (m) => frames.push(m),
      turnDiff: true,
    });
    await captureTurnBaselines(r, [ROOT], 'turn_start', undefined, log, 20);
    expect(r.baselineFailures).toBe(1);
    const req = frames[0].git_diff_request!;
    handleGitDiffResponseFrame(
      {
        session_id: 'u-late',
        sender: 'client',
        content: '',
        git_diff_response: {
          request_id: req.request_id,
          status: 'ok',
          repositories: [],
          baselines: [good],
        },
      },
      'sub-a',
      connection.signal,
      log,
    );
    expect(r.baselines).toEqual([]);
    // Same path later (e.g. a tool in it): never a late baseline.
    await captureTurnBaselines(r, [ROOT], 'before_tool', undefined, log, 20);
    expect(frames).toHaveLength(1);
    // A disjoint later request recovers the original capture from a cumulative reply.
    const other = ROOT + '-other';
    const capturing = captureTurnBaselines(r, [other], 'before_tool', undefined, log, 1000);
    const later = frames[1].git_diff_request!;
    handleGitDiffResponseFrame(
      {
        session_id: 'u-late',
        sender: 'client',
        content: '',
        git_diff_response: {
          request_id: later.request_id,
          status: 'ok',
          repositories: [],
          baselines: [good, { ...good, root: other, source: 'before_tool' }],
        },
      },
      'sub-a',
      connection.signal,
      log,
    );
    await capturing;
    expect(r.baselines).toEqual([good, { ...good, root: other, source: 'before_tool' }]);
    const response = {
      request_id: later.request_id,
      status: 'ok',
      repositories: [],
      baselines: [good],
    };
    expect(() =>
      validateGitBaselineResponse(response, later, { notBefore: r.startedAt, now: Date.now() }),
    ).toThrow();
    expect(() =>
      validateGitBaselineResponse(
        { ...response, baselines: [{ ...good, source: 'before_tool' }] },
        later,
        { notBefore: r.startedAt, now: Date.now() },
        [],
        r.baselineRequests,
      ),
    ).toThrow('baseline source');
  });
});

describe('turn snapshot viewer', () => {
  const app = express();
  app.use('/api/agent', createAgentRouter());

  it('renders at most 300 real file panels for 350 files with one summary notice', async () => {
    await AgentSession.create({ id: 'v-100', subscriptionId: 'sub-a' } as any);
    const patch = Array.from({ length: 350 }, (_, i) =>
      filePatch(`src/f${String(i).padStart(3, '0')}.ts`),
    ).join('');
    const connection = new AbortController();
    const r = createGitRunState({
      sessionId: 'v-100',
      subscriptionId: 'sub-a',
      connection: connection.signal,
      turnDiff: true,
      send: (msg) => {
        const req = msg.git_diff_request;
        if (!req) return;
        setTimeout(
          () =>
            handleGitDiffResponseFrame(
              {
                session_id: 'v-100',
                sender: 'client',
                content: '',
                git_diff_response: { request_id: req.request_id, ...turnReply(patch)(req) },
              },
              'sub-a',
              connection.signal,
              log,
            ),
          1,
        );
      },
    });
    recordTurnBaselines(r, [
      { root: ROOT, head: null, capturedAt: new Date().toISOString(), source: 'turn_start' },
    ]);
    const summary = (await captureSessionDiffBeforeFinal(r, [], undefined, log))!;
    expect(summary).toMatchObject({ scope: 'turn', fileCount: 350, displayLimit: 300 });
    const res = await request(app)
      .get(`/api/agent/sessions/v-100/diffs/${summary.id}`)
      .set('x-test-subscription', 'sub-a');
    expect(res.status).toBe(200);
    const html: string = res.body.html;
    expect((html.match(/<details class="file"/g) ?? []).length).toBe(300);
    expect((html.match(/Showing 300 of 350 files/g) ?? []).length).toBe(1);
    expect(html).toContain('Turn changes');
    expect(html).toContain('unborn');
    expect(html).toContain('src/f299.ts');
    expect(html).not.toContain('src/f300.ts');
    expect(html).not.toMatch(/latest commit/i);
    // Foreign owner still 404.
    expect(
      (
        await request(app)
          .get(`/api/agent/sessions/v-100/diffs/${summary.id}`)
          .set('x-test-subscription', 'sub-b')
      ).status,
    ).toBe(404);
  }, 60_000);
});

describe('deterministic filesystem snapshots', () => {
  const coverage = [
    {
      root: ROOT,
      status: 'partial',
      reason: 'An unreadable file was omitted.',
      suggestedFix: 'Fix file permissions before the next run.',
    },
  ];
  it('requests content capture, disables agent patches, saves root coverage and renders it', async () => {
    queueResults(finalAnswer('done'));
    const t = await turn(
      'fs-complete',
      `Fix ${ROOT}`,
      {
        heads: { [ROOT]: null },
        final: (req) => ({ ...turnReply(filePatch('file.ts'), null)(req), coverage }),
      },
      { filesystem: true },
    );
    expect(t.requests.every((r) => r.filesystem === true)).toBe(true);
    const summary = t.frames.find((f) => f.session_diff)!.session_diff!;
    expect(summary.filesystem).toBe(true);
    expect(summary.coverage).toEqual(coverage);
    expect(cleanSessionDiffSummary(summary)).toEqual(summary);
    const saved = await loadSessionDiffPayload('fs-complete', 'sub-a', summary.id);
    expect(saved!.payload.coverage).toEqual(coverage);
    expect(saved!.payload.recovery).toBeUndefined();
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain(
      'omnikey_diff_report_instruction',
    );
    const app = express();
    app.use('/api/agent', createAgentRouter());
    const response = await request(app)
      .get(`/api/agent/sessions/fs-complete/diffs/${summary.id}`)
      .set('x-test-subscription', 'sub-a');
    expect(response.status).toBe(200);
    expect(response.body.html).not.toContain('Fix file permissions');
    expect(response.body.html).not.toContain('Suggested fix:');
    expect(response.body.html).not.toContain('Net filesystem changes since');
    expect(response.body.additions).toBeGreaterThan(0);
    expect(response.body.deletions).toBeGreaterThan(0);
    expect(response.body.html).toContain('data-file-key');
    expect(response.body.html).not.toContain('captured starting contents');
    expect(response.body.html).not.toContain('unborn');
  });

  it('persists coverage even when no patch could be captured', async () => {
    queueResults(finalAnswer('done'));
    const t = await turn(
      'fs-empty',
      `Fix ${ROOT}`,
      {
        heads: { [ROOT]: null },
        final: () => ({ status: 'ok', repositories: [], coverage }),
      },
      { filesystem: true },
    );
    expect(t.frames.find((f) => f.session_diff)?.session_diff).toMatchObject({
      filesystem: true,
      fileCount: 0,
      repositoryCount: 1,
      coverage,
    });
  });

  it('rejects incomplete or foreign root coverage instead of claiming complete capture', () => {
    const baseline = {
      root: ROOT,
      head: null,
      capturedAt: new Date().toISOString(),
      source: 'turn_start' as const,
    };
    const req = {
      request_id: 'fs-request',
      candidate_paths: [ROOT],
      baselines: [baseline],
      filesystem: true,
    };
    for (const bad of [[], [{ ...coverage[0], root: OTHER }], [coverage[0], coverage[0]]]) {
      expect(() =>
        validateGitTurnFinalResponse(
          { request_id: req.request_id, status: 'ok', repositories: [], coverage: bad },
          req,
        ),
      ).toThrow();
    }
  });
});

it('filesystem final failures remain visible as unavailable coverage', async () => {
  queueResults(finalAnswer('done'));
  const t = await turn(
    'fs-failed',
    `Fix ${ROOT}`,
    {
      heads: { [ROOT]: null },
      final: () => ({ status: 'unavailable', repositories: [] }),
    },
    { filesystem: true },
  );
  const diff = t.frames.find((f) => f.session_diff)!.session_diff!;
  expect(diff.fileCount).toBe(0);
  expect(diff.coverage?.[0]).toMatchObject({ root: ROOT, status: 'unavailable' });
  const stored = await loadSessionDiffPayload('fs-failed', 'sub-a', diff.id);
  expect(stored!.payload.notice).toContain('not a claim that no files changed');
});

it('filesystem roots without an acknowledged baseline remain explicitly unavailable', async () => {
  queueResults(finalAnswer('done'));
  const t = await turn(
    'fs-no-baseline',
    `Fix ${ROOT}`,
    {
      heads: {},
      baseline: () => ({ status: 'unavailable', baselines: [], repositories: [] }),
      final: () => ({ status: 'ok', repositories: [], coverage: [] }),
    },
    { filesystem: true },
  );
  expect(t.frames.find((f) => f.session_diff)?.session_diff?.coverage).toEqual([
    expect.objectContaining({ root: ROOT, status: 'unavailable' }),
  ]);
});

it('filesystem steering keeps the original baseline across superseded finals', async () => {
  queueResults(finalAnswer('superseded'), finalAnswer('accepted'));
  const { enqueueSteeringMessage } = await import('../agent/agentServer/steering');
  let captures = 0;
  const t = await turn(
    'fs-steering',
    `Fix ${ROOT}`,
    {
      heads: { [ROOT]: null },
      final: (req) => {
        if (captures++ === 0) {
          enqueueSteeringMessage(
            'fs-steering',
            {
              session_id: 'fs-steering',
              sender: 'client',
              content: 'Also update the tests',
              is_steering: true,
              steering_id: 'fs-update',
            },
            log,
          );
        }
        return {
          ...turnReply(
            filePatch('before-steering.ts') +
              filePatch(captures === 1 ? 'superseded.ts' : 'accepted.ts'),
            null,
          )(req),
          coverage: [
            { root: ROOT, status: 'complete', reason: 'Captured contents', suggestedFix: '' },
          ],
        };
      },
    },
    { filesystem: true },
  );
  expect(t.requests.filter((r) => r.phase === 'baseline')).toHaveLength(1);
  const finals = t.requests.filter((r) => r.phase === 'final');
  expect(finals).toHaveLength(2);
  expect(finals[1].baselines).toEqual(finals[0].baselines);
  const delivered = t.frames.find((f) => f.session_diff)!;
  expect(delivered.content).toContain('accepted');
  expect(delivered.session_diff?.fileCount).toBe(2);
  const stored = await loadSessionDiffPayload('fs-steering', 'sub-a', delivered.session_diff!.id);
  expect(stored!.payload.repositories[0].patch).toContain('accepted.ts');
  expect(stored!.payload.repositories[0].patch).not.toContain('superseded.ts');
});

it('rejects non-string filesystem coverage status without coercion', () => {
  const baseline = {
    root: ROOT,
    head: null,
    capturedAt: new Date().toISOString(),
    source: 'turn_start' as const,
  };
  const req = {
    request_id: 'coverage-type',
    candidate_paths: [ROOT],
    baselines: [baseline],
    filesystem: true,
  };
  expect(() =>
    validateGitTurnFinalResponse(
      {
        request_id: req.request_id,
        status: 'ok',
        repositories: [],
        coverage: [{ root: ROOT, status: ['complete'], reason: 'ok', suggestedFix: '' }],
      },
      req,
    ),
  ).toThrow();
});

it('discloses a ninth discovered root instead of silently dropping its coverage', async () => {
  const roots = Array.from({ length: 9 }, (_, i) => `/Users/dev/projects/root-${i}`);
  queueResults(
    toolCalls([
      {
        id: 'ninth',
        name: 'shell_script',
        arguments: { script: 'ls', working_directory: roots[8] },
      },
    ]),
    finalAnswer('done'),
  );
  const t = await turn(
    'fs-root-limit',
    `Fix ${roots.slice(0, 8).join(' and ')}`,
    {
      heads: Object.fromEntries(roots.map((root) => [root, null])),
      final: (req) => ({
        ...turnReply(filePatch('file.ts'), null)(req),
        coverage: req.baselines!.map((b) => ({
          root: b.root,
          status: 'complete',
          reason: 'Captured',
          suggestedFix: '',
        })),
      }),
    },
    { filesystem: true },
  );
  const summary = t.frames.find((f) => f.session_diff)!.session_diff!;
  expect(summary.coverage).toHaveLength(9);
  expect(summary.coverage!.find((c) => c.root === roots[8])?.status).toBe('unavailable');
  expect(cleanSessionDiffSummary(summary)?.coverage).toHaveLength(9);
});

it('records only issued filesystem aliases and avoids duplicate unavailable coverage', async () => {
  const alias = ROOT.toUpperCase();
  const baseline = {
    root: ROOT,
    head: null,
    capturedAt: new Date().toISOString(),
    source: 'turn_start' as const,
  };
  const client = fakeClient('fs-alias', {
    heads: {},
    baseline: () => ({
      status: 'ok',
      repositories: [],
      baselines: [baseline],
      root_aliases: [{ root: ROOT, alias }],
    }),
    final: () => ({
      status: 'ok',
      repositories: [],
      coverage: [{ root: ROOT, status: 'complete', reason: '', suggestedFix: '' }],
    }),
  });
  const run = createGitRunState({
    sessionId: 'fs-alias',
    subscriptionId: 'sub-a',
    send: client.send,
    connection: client.connection.signal,
    turnDiff: true,
    filesystem: true,
  });

  await AgentSession.create({ id: 'fs-alias', subscriptionId: 'sub-a' } as any);
  run.candidates.add(ROOT, 'project');
  run.candidates.add(alias, 'working_directory');
  await captureTurnBaselines(run, [ROOT, alias], 'turn_start', undefined, log);
  expect(run.baselines).toEqual([baseline]);
  expect(run.rootAliases.get(alias)).toBe(ROOT);
  const summary = await captureSessionDiffBeforeFinal(run, [], undefined, log);
  expect(summary?.coverage).toEqual([
    { root: ROOT, status: 'complete', reason: '', suggestedFix: '' },
  ]);
  const req = {
    request_id: 'alias',
    candidate_paths: [ROOT],
    baseline_source: 'turn_start' as const,
  };
  const response = {
    request_id: 'alias',
    status: 'ok',
    repositories: [],
    baselines: [baseline],
    root_aliases: [{ root: ROOT, alias }],
  };
  expect(() =>
    validateGitBaselineResponse(response, req, { notBefore: run.startedAt, now: Date.now() }),
  ).toThrow('root alias');
  expect(() =>
    validateGitBaselineResponse(
      { ...response, root_aliases: [{ root: '/unrequested', alias: ROOT }] },
      req,
      { notBefore: run.startedAt, now: Date.now() },
    ),
  ).toThrow('root alias');
});
