/**
 * Contract v4 diff recovery (`supports_diff_recovery: true`) against a real,
 * isolated in-memory SQLite database, a fake native client answering on the
 * run's own control path (shell replies carry run-scoped evidence; the
 * `recover` phase replays native patches), a fake AI provider, and the real
 * Pierre SSR route.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types';
import { finalAnswer, toolCalls } from './helpers/agentSkillsHarness';

const mocks = vi.hoisted(() => {
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  return {
    log,
    complete: vi.fn(),
    nextResult: vi.fn(),
    recoveryResult: vi.fn(),
    reconstructionResult: vi.fn(),
    recordTokenUsage: vi.fn(async () => undefined),
  };
});

vi.mock('../db', async () => {
  const { Sequelize } = await import('sequelize');
  return { sequelize: new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false }) };
});
vi.mock('../logger', () => ({ logger: mocks.log }));
vi.mock('../usageRecorder', () => ({ recordTokenUsage: mocks.recordTokenUsage }));
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
  captureSessionDiffOutcome,
  createGitRunState,
  handleGitDiffResponseFrame,
  loadSessionDiffPayload,
  pendingGitDiffCaptureCount,
  recordTurnBaselines,
  type GitRunState,
} from '../agent/gitDiff/coordinator';
import {
  cleanSessionDiffSummary,
  validateDiffRecoveryEvidence,
  validateGitRecoveryResponse,
  type DiffRecoveryRecord,
  type GitDiffRequest,
} from '../agent/gitDiff/contracts';
import {
  DIFF_RECOVERY_SYSTEM_PROMPT,
  parseRecoveryManifest,
  recordDiffRecoveryEvidence,
  recoverSessionDiff,
  setDiffRecoveryDepsForTesting,
  shellRecoveryContext,
} from '../agent/gitDiff/recovery';
import { clearDiffRenderCacheForTesting } from '../agent/gitDiff/ssrRenderer';
import {
  DIFF_RECONSTRUCTION_SYSTEM_PROMPT,
  buildFilePatch,
  parseReconstructionFiles,
} from '../agent/gitDiff/aiReconstruction';
import { classifyShellWrites, redactSecrets } from '../agent/gitDiff/writeEvidence';
import {
  coverageAssessment,
  patchCoveredPaths,
  reasonDisclosesExclusion,
  withoutCoveredSections,
} from '../agent/gitDiff/coverage';
import { setSkillResolverForTesting } from '../agent/skillContext';
import { buildTranscript } from '../agent/agentServer/transcript';

const log = mocks.log as any;
const ROOT = '/Users/dev/projects/app';
const WORKTREE = '/Users/dev/projects/app-wt';
const NOTES = '/Users/dev/notes';
const OID_1 = '1'.repeat(40);
const OID_2 = '2'.repeat(40);
const HASH_A = 'a'.repeat(64);
const SECRET_SCRIPT_MARKER = 'echo SECRET_TOKEN_abc123';
const SECRET_OUTPUT_MARKER = 'OUTPUT_SECRET_xyz';
const READ_ONLY_SCRIPT = `cd ${ROOT} && git status && ls -la 2>/dev/null`;

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

function rec(
  id: string,
  toolCallId: string,
  root: string,
  paths: string[],
  kind: 'git' | 'file' = 'git',
  complete = true,
): DiffRecoveryRecord {
  return {
    id,
    toolCallId,
    root,
    paths,
    kind,
    before: kind === 'git' ? OID_1 : null,
    after: kind === 'git' ? OID_2 : HASH_A,
    complete,
  };
}

type Body = Record<string, unknown> | null;
interface ClientOptions {
  heads?: Record<string, string | null>;
  baseline?: (req: GitDiffRequest) => Body;
  final?: (req: GitDiffRequest) => Body;
  recover?: (req: GitDiffRequest, stored: Map<string, DiffRecoveryRecord>) => Body;
  /** Terminal reply `is_error` for shell requests (default false). */
  shellError?: boolean;
  /** Evidence for one shell request (receives the correlation context). */
  evidence?: (ctx: Record<string, unknown> | undefined, frame: AgentMessage) => unknown;
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

/** Turn final with no changes in any baselined root. */
function emptyTurnFinal(req: GitDiffRequest): Body {
  return {
    status: 'ok',
    repositories: (req.baselines ?? []).map((b) => ({
      root: b.root,
      patch: '',
      scope: 'turn',
      baselineHead: b.head,
      head: b.head,
      baselineCapturedAt: b.capturedAt,
      baselineSource: b.source,
    })),
  };
}

/** Native store replay: one combined patch per root of the selected records. */
function nativeRecover(req: GitDiffRequest, stored: Map<string, DiffRecoveryRecord>): Body {
  const ids = req.recovery!.evidence_ids;
  const byRoot = new Map<string, Set<string>>();
  for (const id of ids) {
    const r = stored.get(id);
    if (!r) continue;
    const paths = byRoot.get(r.root) ?? new Set<string>();
    r.paths.forEach((p) => paths.add(p));
    byRoot.set(r.root, paths);
  }
  return {
    status: 'ok',
    repositories: [...byRoot].map(([root, paths]) => ({
      root,
      patch: [...paths].map((p) => filePatch(p)).join(''),
      scope: 'working_tree',
    })),
    recovery: { turn_id: req.recovery!.turn_id, evidence_ids: ids, omitted: 0 },
  };
}

function fakeClient(sessionId: string, opts: ClientOptions) {
  const connection = new AbortController();
  const frames: AgentMessage[] = [];
  const events: string[] = [];
  const stored = new Map<string, DiffRecoveryRecord>();
  const send = async (msg: AgentMessage) => {
    frames.push(msg);
    if (msg.content.startsWith('<shell_script>')) {
      events.push('shell');
      const ctx = msg.git_diff_context as Record<string, unknown> | undefined;
      const evidence = opts.evidence?.(ctx, msg);
      const records = (evidence as { records?: DiffRecoveryRecord[] } | undefined)?.records;
      records?.forEach((r) => stored.set(r.id, r));
      const { pendingShellScripts } = await import('../agent/agentServer/runtimeState');
      setTimeout(
        () =>
          pendingShellScripts
            .get(sessionId)
            ?.resolve(
              `TERMINAL OUTPUT:\n${SECRET_OUTPUT_MARKER}`,
              opts.shellError ?? false,
              undefined,
              evidence,
            ),
        1,
      );
    }
    const req = msg.git_diff_request;
    if (!req) return;
    events.push(req.phase ?? 'legacy');
    const body =
      req.phase === 'baseline'
        ? (opts.baseline ?? defaultBaseline(opts.heads ?? {}))(req)
        : req.phase === 'recover'
          ? (opts.recover ?? nativeRecover)(req, stored)
          : (opts.final ?? (() => ({ status: 'unavailable', repositories: [] })))(req);
    if (!body) return;
    setTimeout(() => {
      handleGitDiffResponseFrame(
        {
          session_id: sessionId,
          sender: 'client',
          content: '',
          git_diff_response: { request_id: req.request_id, ...body },
        },
        'sub-a',
        connection.signal,
        log,
      );
    }, 1);
  };
  return { connection, frames, events, stored, send: (m: AgentMessage) => void send(m) };
}

const recoveryCalls = () =>
  mocks.complete.mock.calls.filter(
    (call) => (call[1] as Array<{ content: string }>)[0]?.content === DIFF_RECOVERY_SYSTEM_PROMPT,
  );

async function turn(
  sessionId: string,
  content: string,
  opts: ClientOptions,
  capability: { recovery?: boolean; turn?: boolean } = { recovery: true, turn: true },
  hooks: { client?: (c: ReturnType<typeof fakeClient>) => void } = {},
) {
  const client = fakeClient(sessionId, opts);
  hooks.client?.(client);
  mocks.complete.mockImplementation(async (...args: unknown[]) => {
    const messages = args[1] as Array<{ content: string }>;
    if (messages[0]?.content === DIFF_RECOVERY_SYSTEM_PROMPT) {
      client.events.push('recovery-model');
      return mocks.recoveryResult(...args);
    }
    if (messages[0]?.content === DIFF_RECONSTRUCTION_SYSTEM_PROMPT) {
      client.events.push('reconstruction-model');
      return mocks.reconstructionResult(...args);
    }
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
      supportsGitDiff: true,
      supportsGitTurnDiff: capability.turn !== false,
      supportsDiffRecovery: capability.recovery === true,
    },
  );
  const requests = client.frames.filter((f) => f.git_diff_request).map((f) => f.git_diff_request!);
  const final = client.frames.find((f) => f.content.includes('<final_answer>'));
  return { ...client, requests, final };
}

function queueResults(...results: unknown[]) {
  const queue = [...results];
  mocks.nextResult.mockImplementation(async () => queue.shift() ?? finalAnswer('done'));
}

function manifest(body: unknown, usage = true) {
  const content = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    content,
    finish_reason: 'stop',
    model: 'test-model',
    assistantMessage: { role: 'assistant', content },
    ...(usage ? { usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } } : {}),
  };
}

/**
 * One shell in ROOT that reports `records(ctx)` as evidence. The default
 * script is not write-like (its changes are known only through the records).
 */
function shellTurn(script = `cd ${ROOT} && ${SECRET_SCRIPT_MARKER} && make`) {
  queueResults(
    toolCalls([{ id: 'c1', name: 'shell_script', arguments: { script } }]),
    finalAnswer('done'),
  );
}

const evidenceFor =
  (make: (toolCallId: string) => DiffRecoveryRecord[], omitted?: number) =>
  (ctx: Record<string, unknown> | undefined) =>
    ctx?.turn_id
      ? {
          turn_id: ctx.turn_id,
          records: make(String(ctx.tool_call_id)),
          ...(omitted ? { omitted } : {}),
        }
      : undefined;

async function diffCount(sessionId: string) {
  return AgentSessionDiff.count({ where: { sessionId } });
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
let restoreDeps: () => void = () => undefined;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.log.child.mockReturnValue(mocks.log);
  clearDiffRenderCacheForTesting();
  restoreResolver = setSkillResolverForTesting(async () => ({ matches: [], warnings: [] }));
  restoreDeps = () => undefined;
});
afterEach(() => {
  restoreResolver();
  restoreDeps();
});

// ---------------------------------------------------------------------------
// Pure validators
// ---------------------------------------------------------------------------

describe('diff_recovery_evidence validation', () => {
  const expected = { turnId: 'grun_x', toolCallId: 'c1' };
  const ok = { turn_id: 'grun_x', records: [rec('r1', 'c1', ROOT, ['src/a.ts'])] };

  it('accepts bounded metadata for exactly this turn and tool call', () => {
    expect(validateDiffRecoveryEvidence(ok, expected)).toEqual(ok);
    expect(
      validateDiffRecoveryEvidence(
        { ...ok, records: [rec('f1', 'c1', NOTES, ['todo.md'], 'file')], omitted: 2 },
        expected,
      ),
    ).toMatchObject({ omitted: 2 });
  });

  it.each([
    ['foreign turn', { ...ok, turn_id: 'grun_other' }],
    ['other tool call', { ...ok, records: [rec('r1', 'c0', ROOT, ['a'])] }],
    [
      '33 records',
      { ...ok, records: Array.from({ length: 33 }, (_, i) => rec(`r${i}`, 'c1', ROOT, ['a'])) },
    ],
    [
      '301 paths',
      {
        ...ok,
        records: [
          rec(
            'r1',
            'c1',
            ROOT,
            Array.from({ length: 301 }, (_, i) => `f${i}`),
          ),
        ],
      },
    ],
    ['absolute path', { ...ok, records: [rec('r1', 'c1', ROOT, ['/etc/passwd'])] }],
    ['dotdot path', { ...ok, records: [rec('r1', 'c1', ROOT, ['../x'])] }],
    ['relative root', { ...ok, records: [rec('r1', 'c1', 'app', ['a'])] }],
    [
      'duplicate id',
      { ...ok, records: [rec('r1', 'c1', ROOT, ['a']), rec('r1', 'c1', ROOT, ['b'])] },
    ],
    [
      'file kind with git oid',
      { ...ok, records: [{ ...rec('f', 'c1', NOTES, ['a'], 'file'), after: OID_2 }] },
    ],
    [
      'git kind with a non-oid',
      { ...ok, records: [{ ...rec('g', 'c1', ROOT, ['a']), after: 'HEAD' }] },
    ],
    ['raw patch smuggled into id', { ...ok, records: [rec('diff --git a/x', 'c1', ROOT, ['a'])] }],
    [
      'missing complete',
      { ...ok, records: [{ ...rec('r1', 'c1', ROOT, ['a']), complete: 'yes' }] },
    ],
    ['negative omitted', { ...ok, omitted: -1 }],
  ])('rejects the whole reply: %s', (_label, raw) => {
    expect(validateDiffRecoveryEvidence(raw, expected)).toBeNull();
  });
});

describe('recovery manifest parsing', () => {
  const allowed = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
  it('accepts only the strict schema with allowlisted unique ids', () => {
    expect(parseRecoveryManifest('{"evidenceIds":["r1","r2"]}', allowed)).toEqual({
      evidenceIds: ['r1', 'r2'],
    });
    expect(parseRecoveryManifest('```json\n{"evidenceIds":["r3"]}\n```', allowed)).toEqual({
      evidenceIds: ['r3'],
    });
    expect(parseRecoveryManifest('{"unavailable":true}', allowed)).toEqual({ unavailable: true });
  });
  it.each([
    '{"evidenceIds":["nope"]}',
    '{"evidenceIds":["r1","r1"]}',
    '{"evidenceIds":["r1","r2","r3","r4","r5","r6","r7"]}',
    '{"evidenceIds":[]}',
    '{"evidenceIds":["r1"],"patch":"diff --git a/x b/x"}',
    '{"unavailable":false}',
    '{"evidenceIds":"r1"}',
    'Sure! {"evidenceIds":["r1"]}',
    'diff --git a/x b/x',
    '',
  ])('rejects %s', (content) => {
    expect(parseRecoveryManifest(content, allowed)).toBeNull();
  });
});

describe('recover reply validation', () => {
  const req: GitDiffRequest = {
    request_id: 'req1',
    candidate_paths: [],
    eligible_commits: [],
    phase: 'recover',
    recovery: { turn_id: 'grun_x', evidence_ids: ['r1', 'r2'] },
  };
  const selected = [rec('r1', 'c1', ROOT, ['a']), rec('r2', 'c2', WORKTREE, ['b'])];
  const good = {
    request_id: 'req1',
    status: 'ok',
    repositories: [{ root: ROOT, patch: filePatch('a'), scope: 'working_tree' }],
    recovery: { turn_id: 'grun_x', evidence_ids: ['r2', 'r1'], omitted: 0 },
  };
  it('accepts the exact turn/id set and selected roots', () => {
    const v = validateGitRecoveryResponse(good, req, selected);
    expect(v.repositories).toEqual([{ root: ROOT, patch: filePatch('a'), scope: 'working_tree' }]);
    expect(v.recovery).toEqual({ turn_id: 'grun_x', evidence_ids: ['r1', 'r2'], omitted: 0 });
  });
  it.each([
    ['other turn', { ...good, recovery: { ...good.recovery, turn_id: 'grun_y' } }],
    ['subset ids', { ...good, recovery: { ...good.recovery, evidence_ids: ['r1'] } }],
    ['extra id', { ...good, recovery: { ...good.recovery, evidence_ids: ['r1', 'r2', 'r3'] } }],
    ['missing echo', { ...good, recovery: undefined }],
    [
      'unselected root',
      { ...good, repositories: [{ root: '/Users/dev/other', patch: '', scope: 'working_tree' }] },
    ],
    [
      'commit claim',
      { ...good, repositories: [{ root: ROOT, patch: '', scope: 'commit', commit: OID_1 }] },
    ],
    ['turn claim', { ...good, repositories: [{ root: ROOT, patch: '', scope: 'turn' }] }],
    [
      'baseline fields',
      {
        ...good,
        repositories: [{ root: ROOT, patch: '', scope: 'working_tree', baselineHead: OID_1 }],
      },
    ],
    ['duplicate root', { ...good, repositories: [good.repositories[0], good.repositories[0]] }],
    [
      'oversized',
      {
        ...good,
        repositories: [
          { root: ROOT, patch: 'x'.repeat(2 * 1024 * 1024 + 1), scope: 'working_tree' },
        ],
      },
    ],
    [
      'unselected patch file',
      {
        ...good,
        repositories: [{ root: ROOT, patch: filePatch('not-selected'), scope: 'working_tree' }],
      },
    ],
    [
      'forged file header',
      {
        ...good,
        repositories: [
          {
            root: ROOT,
            patch: filePatch('a').replace('+++ b/a', '+++ b/not-selected'),
            scope: 'working_tree',
          },
        ],
      },
    ],
    ['patch on failure', { ...good, status: 'unavailable' }],
  ])('rejects %s', (_label, raw) => {
    expect(() => validateGitRecoveryResponse(raw, req, selected)).toThrow();
  });
});

describe('rename recovery allowlist', () => {
  it('accepts both verified rename paths and rejects an unverified origin', () => {
    const request = { request_id: 'rename', recovery: { turn_id: 'run', evidence_ids: ['r'] } };
    const selected = [rec('r', 'c', ROOT, ['old.txt', 'new.txt'])];
    const patch =
      'diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n';
    const reply = {
      request_id: 'rename',
      status: 'ok',
      repositories: [{ root: ROOT, scope: 'working_tree', patch }],
      recovery: { turn_id: 'run', evidence_ids: ['r'], omitted: 0 },
    };
    expect(validateGitRecoveryResponse(reply, request, selected).repositories).toHaveLength(1);
    expect(() =>
      validateGitRecoveryResponse(reply, request, [rec('r', 'c', ROOT, ['new.txt'])]),
    ).toThrow();
  });
});

describe('recovered summary hydration', () => {
  it('keeps provenance booleans and strips unknown metadata', () => {
    const summary = {
      id: 'sdiff_abcdefgh12',
      fileCount: 1,
      repositoryCount: 1,
      createdAt: new Date().toISOString(),
      scope: 'working_tree',
      displayLimit: 300,
      recovered: true,
      recoveryIncomplete: true,
      evidence: ['leak'],
    };
    expect(cleanSessionDiffSummary(summary)).toEqual({
      id: 'sdiff_abcdefgh12',
      fileCount: 1,
      repositoryCount: 1,
      createdAt: summary.createdAt,
      scope: 'working_tree',
      displayLimit: 300,
      recovered: true,
      recoveryIncomplete: true,
    });
    // recoveryIncomplete never appears without the recovered marker.
    expect(cleanSessionDiffSummary({ ...summary, recovered: false })).not.toHaveProperty(
      'recoveryIncomplete',
    );
  });
});

// ---------------------------------------------------------------------------
// Run-scoped evidence correlation
// ---------------------------------------------------------------------------

describe('run-scoped evidence store', () => {
  const run = (recovery = true): GitRunState =>
    createGitRunState({
      sessionId: 's',
      subscriptionId: 'sub-a',
      send: () => undefined,
      turnDiff: true,
      diffRecovery: recovery,
    });

  it('accepts only issued tool calls and replaces matching ids with the latest metadata', () => {
    const r = run();
    expect(shellRecoveryContext(r, 'c1')).toEqual({ turn_id: r.runId, tool_call_id: 'c1' });
    // Not issued -> ignored.
    expect(
      recordDiffRecoveryEvidence(r, 'c9', {
        turn_id: r.runId,
        records: [rec('x', 'c9', ROOT, ['a'])],
      }),
    ).toBe(0);
    expect(
      recordDiffRecoveryEvidence(r, 'c1', {
        turn_id: r.runId,
        records: [rec('wt', 'c1', WORKTREE, ['a'])],
      }),
    ).toBe(1);
    shellRecoveryContext(r, 'c2');
    recordDiffRecoveryEvidence(r, 'c2', {
      turn_id: r.runId,
      records: [rec('wt', 'c2', WORKTREE, ['a', 'b'])],
    });
    expect([...r.recovery!.records.values()]).toEqual([rec('wt', 'c2', WORKTREE, ['a', 'b'])]);
  });

  it('caps the per-run store at 32 records and counts the overflow', () => {
    const r = run();
    for (let i = 0; i < 2; i++) {
      shellRecoveryContext(r, `c${i}`);
      recordDiffRecoveryEvidence(r, `c${i}`, {
        turn_id: r.runId,
        records: Array.from({ length: 20 }, (_, j) => rec(`r${i}_${j}`, `c${i}`, ROOT, ['a'])),
      });
    }
    expect(r.recovery!.records.size).toBe(32);
    expect(r.recovery!.omitted).toBe(8);
  });

  it('a run without the capability has no store and issues no correlation', () => {
    const r = run(false);
    expect(r.recovery).toBeUndefined();
    expect(shellRecoveryContext(r, 'c1')).toBeUndefined();
    expect(recordDiffRecoveryEvidence(r, 'c1', { turn_id: r.runId, records: [] })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Structured automatic outcome (legacy wrapper preserved)
// ---------------------------------------------------------------------------

describe('automatic capture outcome', () => {
  function outcomeRun(sessionId: string, reply: (req: GitDiffRequest) => Body, turnDiff = true) {
    const connection = new AbortController();
    return createGitRunState({
      sessionId,
      subscriptionId: 'sub-a',
      connection: connection.signal,
      turnDiff,
      diffRecovery: true,
      send: (msg) => {
        const req = msg.git_diff_request;
        if (!req) return;
        const body = reply(req);
        if (!body) return;
        setTimeout(
          () =>
            handleGitDiffResponseFrame(
              {
                session_id: sessionId,
                sender: 'client',
                content: '',
                git_diff_response: { request_id: req.request_id, ...body },
              },
              'sub-a',
              connection.signal,
              log,
            ),
          1,
        );
      },
    });
  }
  const now = () => new Date().toISOString();

  it('reports every empty type distinctly', async () => {
    await AgentSession.create({ id: 'o-1', subscriptionId: 'sub-a' } as any);
    const noRepo = outcomeRun('o-1', () => null);
    expect(await captureSessionDiffOutcome(noRepo, [], undefined, log)).toMatchObject({
      status: 'no_repository',
    });

    const noChanges = outcomeRun('o-1', emptyTurnFinal);
    recordTurnBaselines(noChanges, [
      { root: ROOT, head: OID_1, capturedAt: now(), source: 'turn_start' },
    ]);
    expect(await captureSessionDiffOutcome(noChanges, [], undefined, log)).toMatchObject({
      status: 'no_changes',
    });

    const unavailable = outcomeRun('o-1', () => ({ status: 'unavailable', repositories: [] }));
    unavailable.candidates.add(ROOT, 'working_directory');
    expect(await captureSessionDiffOutcome(unavailable, [], undefined, log)).toMatchObject({
      status: 'workspace_unavailable',
    });

    const notRepo = outcomeRun('o-1', () => ({ status: 'not_repository', repositories: [] }));
    notRepo.candidates.add(NOTES, 'working_directory');
    expect(await captureSessionDiffOutcome(notRepo, [], undefined, log)).toMatchObject({
      status: 'no_repository',
    });

    const invalid = outcomeRun('o-1', () => ({ status: 'bogus' }));
    invalid.candidates.add(ROOT, 'working_directory');
    expect(await captureSessionDiffOutcome(invalid, [], undefined, log)).toMatchObject({
      status: 'capture_failed',
    });

    const missing = outcomeRun('o-1', () => ({ status: 'ok', repositories: [] }));
    missing.candidates.add(ROOT, 'working_directory');
    missing.baselineFailures = 1;
    expect(await captureSessionDiffOutcome(missing, [], undefined, log)).toMatchObject({
      status: 'missing_baseline',
    });

    const captured = outcomeRun('o-1', (req) => ({
      status: 'ok',
      repositories: [
        { root: req.candidate_paths[0], patch: filePatch('a'), scope: 'working_tree' },
      ],
    }));
    captured.candidates.add(ROOT, 'working_directory');
    const outcome = await captureSessionDiffOutcome(captured, [], undefined, log);
    expect(outcome.status).toBe('captured');
    expect(outcome.summary).toMatchObject({ scope: 'working_tree', fileCount: 1 });

    // Legacy wrapper still returns just the summary (or undefined).
    const legacy = outcomeRun(
      'o-1',
      (req) => ({
        status: 'ok',
        repositories: [
          { root: req.candidate_paths[0], patch: filePatch('b'), scope: 'working_tree' },
        ],
      }),
      false,
    );
    legacy.candidates.add(ROOT, 'working_directory');
    expect(await captureSessionDiffBeforeFinal(legacy, [], undefined, log)).toMatchObject({
      fileCount: 1,
    });
    expect(pendingGitDiffCaptureCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full agent turns
// ---------------------------------------------------------------------------

describe('agent-assisted recovery in a real agent turn', () => {
  it('worktree created+committed+deleted: recovers the verified record with provenance', async () => {
    shellTurn(
      `git -C ${ROOT} worktree add ${WORKTREE} && cd ${WORKTREE} && ${SECRET_SCRIPT_MARKER}`,
    );
    mocks.recoveryResult.mockImplementation(async (_m: unknown, messages: any[]) => {
      const ids = JSON.parse(messages[1].content).records.map((r: { id: string }) => r.id);
      return manifest({ evidenceIds: ids });
    });
    const t = await turn('r-wt', `Fix the bug in ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('wt-1', tc, WORKTREE, ['src/fix.ts', 'src/new.ts'])]),
    });
    // Shell correlation: outer run id + this exact tool call id.
    const shell = t.frames.find((f) => f.content.startsWith('<shell_script>'))!;
    expect(shell.git_diff_context).toMatchObject({
      turn_id: expect.stringMatching(/^grun_/),
      tool_call_id: 'c1',
    });
    // Normal capture first, then exactly one manifest call and one recover request.
    expect(t.events.slice(-3)).toEqual(['final', 'recovery-model', 'recover']);
    expect(t.events.filter((e) => e === 'recovery-model')).toHaveLength(1);
    const recoverReq = t.requests.find((r) => r.phase === 'recover')!;
    expect(recoverReq).toEqual({
      request_id: expect.any(String),
      candidate_paths: [],
      eligible_commits: [],
      phase: 'recover',
      recovery: { turn_id: shell.git_diff_context!.turn_id, evidence_ids: ['wt-1'] },
    });

    // Restricted model call: no tools, fixed prompt, current input + metadata only.
    const [call] = recoveryCalls();
    const [model, messages, options] = call as [
      string,
      Array<{ role: string; content: string }>,
      any,
    ];
    expect(model).toBe('test-model');
    expect(messages).toHaveLength(2);
    expect(options.tools).toBeUndefined();
    expect(options.maxTokens).toBe(1000);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(messages[1].content);
    expect(payload.userInput).toBe(`Fix the bug in ${ROOT}`);
    expect(payload.records).toEqual([
      {
        id: 'wt-1',
        toolCallId: 'c1',
        kind: 'git',
        root: WORKTREE,
        paths: ['src/fix.ts', 'src/new.ts'],
        pathCount: 2,
        complete: true,
      },
    ]);
    const sent = JSON.stringify(messages);
    expect(sent).not.toContain('SECRET_TOKEN');
    expect(sent).not.toContain(SECRET_OUTPUT_MARKER);
    expect(sent).not.toContain('system prompt');
    expect(sent).not.toContain(OID_1);

    // Usage accounted through the existing recorder.
    expect(mocks.recordTokenUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'sub-a' }),
      { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      'test-model',
      'agent',
      'r-wt',
    );

    // Final content unchanged; recovered summary attached live and persisted.
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toMatchObject({
      scope: 'working_tree',
      fileCount: 2,
      recovered: true,
      recoveryIncomplete: false,
      displayLimit: 300,
    });
    const stored = await loadSessionDiffPayload('r-wt', 'sub-a', t.final!.session_diff!.id);
    expect(stored!.row.payload.startsWith('gz1:')).toBe(true);
    expect(stored!.payload.recovery).toEqual({
      kind: 'agent_assisted',
      turnId: shell.git_diff_context!.turn_id,
      evidenceIds: ['wt-1'],
      complete: true,
      limitations: [],
    });
    expect(stored!.payload.repositories).toEqual([
      {
        root: WORKTREE,
        patch: filePatch('src/fix.ts') + filePatch('src/new.ts'),
        scope: 'working_tree',
      },
    ]);
    // Hydrated transcript keeps the provenance; provider copies never see it.
    const session = await AgentSession.findOne({ where: { id: 'r-wt' } });
    const history = JSON.parse(session!.historyJson);
    const persistedFinal = history[history.length - 1];
    expect(persistedFinal.session_diff).toMatchObject({ recovered: true });
    expect(JSON.stringify(buildTranscript(history))).toContain('"recovered":true');
    expect(JSON.stringify(mocks.nextResult.mock.calls)).not.toContain('recovered');
    expect(pendingGitDiffCaptureCount()).toBe(0);
  });

  it('non-Git explicit file write (no repository) recovers a file record', async () => {
    shellTurn(`printf hi > '${NOTES}/todo.md'`);
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['f-1'] }));
    const t = await turn('r-file', 'update my notes', {
      evidence: evidenceFor((tc) => [rec('f-1', tc, NOTES, ['todo.md'], 'file')]),
    });
    expect(t.events.filter((e) => e === 'recovery-model')).toHaveLength(1);
    expect(t.final!.session_diff).toMatchObject({ recovered: true, fileCount: 1 });
  });

  it('a normal captured snapshot skips the AI even with verified records', async () => {
    shellTurn();
    const t = await turn('r-normal', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: (req) => ({
        status: 'ok',
        repositories: (req.baselines ?? []).map((b) => ({
          root: b.root,
          patch: filePatch('src/a.ts'),
          scope: 'turn',
          baselineHead: b.head,
          head: OID_2,
          baselineCapturedAt: b.capturedAt,
          baselineSource: b.source,
        })),
      }),
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['src/a.ts'])]),
    });
    expect(recoveryCalls()).toHaveLength(0);
    expect(t.requests.some((r) => r.phase === 'recover')).toBe(false);
    expect(t.final!.session_diff).toMatchObject({ scope: 'turn' });
    expect(t.final!.session_diff!.recovered).toBeUndefined();
  });

  it.each([
    ['no_changes', { heads: { [ROOT]: OID_1 } }],
    [
      'workspace_unavailable',
      { heads: { [ROOT]: OID_1 }, final: () => ({ status: 'unavailable', repositories: [] }) },
    ],
    ['capture_failed', { heads: { [ROOT]: OID_1 }, final: () => ({ status: 'nope' }) }],
    [
      'missing_baseline',
      {
        baseline: () => ({ status: 'unavailable', repositories: [] }),
        final: () => ({ status: 'ok', repositories: [] }),
      },
    ],
  ] as Array<[string, ClientOptions]>)(
    '%s without verified records never calls the AI',
    async (label, opts) => {
      shellTurn(READ_ONLY_SCRIPT);
      const t = await turn(`r-empty-${label}`, `Look at ${ROOT}`, opts);
      expect(recoveryCalls()).toHaveLength(0);
      expect(t.final!.session_diff).toBeUndefined();
      expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    },
  );

  it('no repository and no records: no AI call', async () => {
    queueResults(finalAnswer('hello'));
    const t = await turn('r-norepo', 'say hi', {});
    expect(recoveryCalls()).toHaveLength(0);
    expect(t.final!.session_diff).toBeUndefined();
  });

  it.each([
    [
      'foreign turn id',
      (ctx: any) => ({
        turn_id: 'grun_forged',
        records: [rec('x', String(ctx.tool_call_id), ROOT, ['a'])],
      }),
    ],
    [
      'other tool call id',
      (ctx: any) => ({ turn_id: ctx.turn_id, records: [rec('x', 'c-other', ROOT, ['a'])] }),
    ],
    ['malformed record', (ctx: any) => ({ turn_id: ctx.turn_id, records: [{ id: 'x' }] })],
  ])('evidence with %s is ignored (no AI call)', async (_label, evidence) => {
    shellTurn(READ_ONLY_SCRIPT);
    const t = await turn(`r-bad-${_label.replace(/\s/g, '')}`, `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: (ctx) => evidence(ctx),
    });
    expect(recoveryCalls()).toHaveLength(0);
    expect(t.final!.session_diff).toBeUndefined();
  });

  it('a client without the capability gets no correlation and evidence is ignored', async () => {
    shellTurn();
    const t = await turn(
      'r-nocap',
      `Fix ${ROOT}`,
      {
        heads: { [ROOT]: OID_1 },
        evidence: () => ({ turn_id: 'grun_x', records: [rec('x', 'c1', ROOT, ['a'])] }),
      },
      { recovery: false, turn: true },
    );
    const shell = t.frames.find((f) => f.content.startsWith('<shell_script>'))!;
    expect(shell.git_diff_context?.turn_id).toBeUndefined();
    expect(shell.git_diff_context?.tool_call_id).toBeUndefined();
    expect(recoveryCalls()).toHaveLength(0);
  });

  it.each([
    ['unknown id', { evidenceIds: ['forged'] }],
    ['duplicate ids', { evidenceIds: ['r1', 'r1'] }],
    ['patch content', '{"evidenceIds":["r1"],"patch":"diff --git a/etc/passwd b/etc/passwd"}'],
    ['prose', 'I think r1 is relevant'],
    ['unavailable', { unavailable: true }],
  ])('a malicious or empty manifest (%s) never reaches the native store', async (_l, body) => {
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest(body));
    const id = `r-mal-${_l.replace(/\s/g, '')}`;
    const t = await turn(id, `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
    });
    expect(recoveryCalls()).toHaveLength(1);
    expect(t.requests.some((r) => r.phase === 'recover')).toBe(false);
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount(id)).toBe(0);
  });

  it('a forged native recover reply is rejected (no snapshot)', async () => {
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['r1'] }));
    const t = await turn('r-forged', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
      recover: (req) => ({
        status: 'ok',
        repositories: [
          { root: '/Users/dev/secret', patch: filePatch('id_rsa'), scope: 'working_tree' },
        ],
        recovery: {
          turn_id: req.recovery!.turn_id,
          evidence_ids: req.recovery!.evidence_ids,
          omitted: 0,
        },
      }),
    });
    expect(t.requests.some((r) => r.phase === 'recover')).toBe(true);
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('r-forged')).toBe(0);
  });

  it('a partial selection with native omissions attempts AI but never attaches a partial card', async () => {
    queueResults(
      toolCalls([{ id: 'c1', name: 'shell_script', arguments: { script: `cd ${ROOT} && make` } }]),
      toolCalls([
        { id: 'c2', name: 'shell_script', arguments: { script: `cd ${WORKTREE} && make` } },
      ]),
      finalAnswer('done'),
    );
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['r-b'] }));
    mocks.reconstructionResult.mockResolvedValue(manifest({ unavailable: true }));
    const t = await turn('r-partial', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: (ctx) =>
        ctx?.tool_call_id === 'c1'
          ? { turn_id: ctx.turn_id, records: [rec('r-a', 'c1', ROOT, ['a.ts'])] }
          : {
              turn_id: ctx!.turn_id,
              records: [rec('r-b', 'c2', WORKTREE, ['b.ts'], 'git', false)],
              omitted: 3,
            },
    });
    expect(
      JSON.parse((recoveryCalls()[0][1] as any)[1].content).records.map((r: any) => r.id),
    ).toEqual(['r-a', 'r-b']);
    // Manifest + one reconstruction attempt for the unselected verified path.
    expect(t.events.slice(-4)).toEqual([
      'final',
      'recovery-model',
      'recover',
      'reconstruction-model',
    ]);
    const recon = JSON.parse((mocks.reconstructionResult.mock.calls[0][1] as any)[1].content);
    expect(recon.allowedPaths).toEqual([
      { path: `${ROOT}/a.ts`, creationVerified: false, deletionAllowed: false },
    ]);
    // Truncated record + native omissions remain unresolvable: withheld.
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('r-partial')).toBe(0);
  });

  it('an unselected verified file is AI-reconstructed and merged without touching the replayed file', async () => {
    queueResults(
      toolCalls([{ id: 'c1', name: 'shell_script', arguments: { script: `cd ${NOTES} && make` } }]),
      finalAnswer('done'),
    );
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['f-a'] }));
    mocks.reconstructionResult.mockResolvedValue(
      manifest({ files: [{ path: `${NOTES}/b.md`, before: null, after: 'b\n' }] }),
    );
    const t = await turn('r-merge-native', 'update notes', {
      evidence: evidenceFor((tc) => [
        rec('f-a', tc, NOTES, ['a.md'], 'file'),
        rec('f-b', tc, NOTES, ['b.md'], 'file'),
      ]),
    });
    expect(t.final!.session_diff).toMatchObject({
      recovered: true,
      recoveryIncomplete: false,
      recoveryMethod: 'ai_reconstructed',
      fileCount: 2,
    });
    const stored = await loadSessionDiffPayload(
      'r-merge-native',
      'sub-a',
      t.final!.session_diff!.id,
    );
    expect(stored!.payload.recovery).toMatchObject({
      kind: 'ai_reconstructed',
      base: 'checkpoint',
      evidenceIds: ['f-a'],
      complete: true,
    });
    expect(stored!.payload.repositories).toEqual([
      { root: NOTES, patch: filePatch('a.md'), scope: 'working_tree' },
      {
        root: NOTES,
        patch: buildFilePatch('b.md', null, 'b\n'),
        scope: 'working_tree',
        reconstructed: true,
      },
    ]);
  });

  it('an older selected checkpoint cannot cover a later record on the same path', async () => {
    queueResults(
      toolCalls([{ id: 'c1', name: 'shell_script', arguments: { script: `cd ${NOTES} && make` } }]),
      finalAnswer('done'),
    );
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['old'] }));
    mocks.reconstructionResult.mockResolvedValue(
      manifest({ files: [{ path: `${NOTES}/a.md`, before: 'old\n', after: 'new\n' }] }),
    );
    const t = await turn('r-same-path-stale', 'update notes', {
      evidence: evidenceFor((tc) => [
        rec('old', tc, NOTES, ['a.md'], 'file'),
        rec('new', tc, NOTES, ['a.md'], 'file'),
      ]),
    });
    expect(mocks.reconstructionResult).toHaveBeenCalledOnce();
    expect(t.final?.session_diff).toBeUndefined();
    expect(await diffCount('r-same-path-stale')).toBe(0);
  });

  it('the next turn never sees or recovers an older turn record', async () => {
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['old-1'] }));
    const first = await turn('r-next', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('old-1', tc, ROOT, ['a'])]),
    });
    expect(first.final!.session_diff).toMatchObject({ recovered: true });
    const firstTurnId = first.frames.find((f) => f.git_diff_context)!.git_diff_context!.turn_id;
    mocks.complete.mockClear();

    // Second turn: a shell with no evidence; a stale-turn record is replayed.
    shellTurn(READ_ONLY_SCRIPT);
    const second = await turn('r-next', 'continue', {
      heads: { [ROOT]: OID_2 },
      evidence: () => ({ turn_id: firstTurnId, records: [rec('old-1', 'c1', ROOT, ['a'])] }),
    });
    const secondTurnId = second.frames.find((f) => f.git_diff_context)!.git_diff_context!.turn_id;
    expect(secondTurnId).not.toBe(firstTurnId);
    expect(recoveryCalls()).toHaveLength(0);
    expect(second.final!.session_diff).toBeUndefined();
  });

  it('the AI deadline aborts the provider call and still delivers the original final', async () => {
    restoreDeps = setDiffRecoveryDepsForTesting({ totalTimeoutMs: 120 });
    shellTurn();
    let providerSignal: AbortSignal | undefined;
    mocks.recoveryResult.mockImplementation(
      (_model: unknown, _messages: unknown, options: { signal: AbortSignal }) => {
        providerSignal = options.signal;
        return new Promise(() => undefined); // never resolves
      },
    );
    const started = Date.now();
    const t = await turn('r-timeout', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(providerSignal?.aborted).toBe(true);
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('r-timeout')).toBe(0);
  });

  it('the shared 20 s budget also covers the native recover request', async () => {
    restoreDeps = setDiffRecoveryDepsForTesting({ totalTimeoutMs: 150 });
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['r1'] }));
    const t = await turn('r-native-timeout', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
      recover: () => null, // native never answers
    });
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('r-native-timeout')).toBe(0);
    expect(pendingGitDiffCaptureCount()).toBe(0);
  });

  it('a usage recorder failure never loses the recovered snapshot or the final', async () => {
    mocks.recordTokenUsage.mockRejectedValueOnce(new Error('db down') as never);
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['r1'] }));
    // The agent calls carry no usage, so the first recorder call is the recovery one.
    const t = await turn('r-usage', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
    });
    expect(mocks.recordTokenUsage).toHaveBeenCalledTimes(1);
    expect(t.final!.session_diff).toMatchObject({ recovered: true });
  });

  it('does not resurrect a Git checkpoint after successful net-empty normal capture', async () => {
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['r1'] }));
    const t = await turn('r-reverted', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
      final: () => ({ status: 'ok', repositories: [] }),
    });
    expect(mocks.recoveryResult).not.toHaveBeenCalled();
    expect(t.final?.session_diff).toBeUndefined();
  });

  it('a stalled recovered-snapshot insert cannot hold the original final past the deadline', async () => {
    restoreDeps = setDiffRecoveryDepsForTesting({ totalTimeoutMs: 100 });
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['r1'] }));
    const stalled = vi
      .spyOn(AgentSessionDiff, 'create')
      .mockImplementationOnce(() => new Promise(() => {}) as any);
    try {
      const start = Date.now();
      const t = await turn('r-save-timeout', `Fix ${ROOT}`, {
        heads: { [ROOT]: OID_1 },
        evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
      });
      expect(Date.now() - start).toBeLessThan(1500);
      expect(t.final?.content).toContain('done');
      expect(stalled).toHaveBeenCalledOnce();
      expect(t.final?.session_diff).toBeUndefined();
    } finally {
      stalled.mockRestore();
    }
  });

  it('cancel during recovery stores and attaches nothing late', async () => {
    shellTurn();
    let release!: () => void;
    const holder: { client?: ReturnType<typeof fakeClient> } = {};
    mocks.recoveryResult.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(manifest({ evidenceIds: ['r1'] }));
          holder.client!.connection.abort();
          setTimeout(release, 5);
        }),
    );
    const t = await turn(
      'r-cancel',
      `Fix ${ROOT}`,
      {
        heads: { [ROOT]: OID_1 },
        evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a'])]),
      },
      { recovery: true, turn: true },
      { client: (c) => (holder.client = c) },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(t.requests.some((r) => r.phase === 'recover')).toBe(false);
    expect(t.frames.some((f) => f.session_diff)).toBe(false);
    expect(await diffCount('r-cancel')).toBe(0);
  });

  it('runs at most once per outer run', async () => {
    const connection = new AbortController();
    await AgentSession.create({ id: 'r-once', subscriptionId: 'sub-a' } as any);
    const r = createGitRunState({
      sessionId: 'r-once',
      subscriptionId: 'sub-a',
      connection: connection.signal,
      turnDiff: true,
      diffRecovery: true,
      send: () => undefined,
    });
    shellRecoveryContext(r, 'c1');
    recordDiffRecoveryEvidence(r, 'c1', {
      turn_id: r.runId,
      records: [rec('r1', 'c1', ROOT, ['a'])],
    });
    const complete = vi.fn(async () => manifest({ unavailable: true }));
    restoreDeps = setDiffRecoveryDepsForTesting({ complete: complete as any });
    await recoverSessionDiff(r, { model: 'm', signal: undefined, log });
    // Manifest + one reconstruction attempt (the record path stayed missing).
    expect(complete).toHaveBeenCalledTimes(2);
    await recoverSessionDiff(r, { model: 'm', signal: undefined, log });
    expect(complete).toHaveBeenCalledTimes(2);
  });
});

describe('recovered snapshot viewer', () => {
  const app = express();
  app.use('/api/agent', createAgentRouter());

  it('replays a complete 100-file recovered payload with provenance and the 300-panel cap', async () => {
    await AgentSession.create({ id: 'v-rec', subscriptionId: 'sub-a' } as any);
    const patch = Array.from({ length: 100 }, (_, i) =>
      filePatch(`src/f${String(i).padStart(3, '0')}.ts`),
    ).join('');
    const connection = new AbortController();
    const r = createGitRunState({
      sessionId: 'v-rec',
      subscriptionId: 'sub-a',
      connection: connection.signal,
      turnDiff: true,
      diffRecovery: true,
      send: (msg) => {
        const req = msg.git_diff_request;
        if (!req) return;
        setTimeout(
          () =>
            handleGitDiffResponseFrame(
              {
                session_id: 'v-rec',
                sender: 'client',
                content: '',
                git_diff_response: {
                  request_id: req.request_id,
                  status: 'ok',
                  repositories: [
                    { root: WORKTREE, patch: `${patch}<script>x</script>`, scope: 'working_tree' },
                  ],
                  recovery: { turn_id: r.runId, evidence_ids: ['r1', 'r2'], omitted: 0 },
                },
              },
              'sub-a',
              connection.signal,
              log,
            ),
          1,
        );
      },
    });
    shellRecoveryContext(r, 'c1');
    recordDiffRecoveryEvidence(r, 'c1', {
      turn_id: r.runId,
      records: [
        rec(
          'r1',
          'c1',
          WORKTREE,
          Array.from({ length: 50 }, (_, i) => `src/f${String(i).padStart(3, '0')}.ts`),
        ),
        rec(
          'r2',
          'c1',
          WORKTREE,
          Array.from({ length: 50 }, (_, i) => `src/f${String(i + 50).padStart(3, '0')}.ts`),
        ),
      ],
    });
    restoreDeps = setDiffRecoveryDepsForTesting({
      complete: (async () => manifest({ evidenceIds: ['r1', 'r2'] })) as any,
    });
    const summary = (await recoverSessionDiff(r, { model: 'm', signal: undefined, log }))!;
    // The 300-panel viewer cap is a display limit, never a coverage gap.
    expect(summary).toMatchObject({ recovered: true, recoveryIncomplete: false, fileCount: 100 });
    const res = await request(app)
      .get(`/api/agent/sessions/v-rec/diffs/${summary.id}`)
      .set('x-test-subscription', 'sub-a');
    expect(res.status).toBe(200);
    const html: string = res.body.html;
    expect(html).toContain('Recovered turn changes');
    expect(html).not.toContain('Partial recovery');
    expect(html).toContain('recovered from turn checkpoints');
    expect((html.match(/<details class="file"/g) ?? []).length).toBe(100);
    expect(html).not.toContain('Showing ');
    expect(html).not.toContain('<script>x</script>');
    expect(
      (
        await request(app)
          .get(`/api/agent/sessions/v-rec/diffs/${summary.id}`)
          .set('x-test-subscription', 'sub-b')
      ).status,
    ).toBe(404);
  }, 60_000);

  it('refuses known-partial stored snapshots (409) and keeps legacy working-tree ones', async () => {
    const { compressString } = await import('../compression');
    await AgentSession.create({ id: 'v-old', subscriptionId: 'sub-a' } as any);
    const store = async (id: string, payload: Record<string, unknown>) =>
      AgentSessionDiff.create({
        id,
        sessionId: 'v-old',
        subscriptionId: 'sub-a',
        runId: 'grun_old',
        scope: 'working_tree',
        commitOid: null,
        fileCount: 1,
        repositoryCount: 1,
        payload: compressString(JSON.stringify({ version: 1, ...payload })),
      } as any);
    const repo = { root: ROOT, patch: filePatch('a.ts'), scope: 'working_tree' };
    await store('sdiff_oldpartial1', {
      repositories: [repo],
      displayLimit: 300,
      recovery: {
        kind: 'agent_assisted',
        turnId: 'grun_old',
        evidenceIds: ['r1'],
        complete: false,
        limitations: [],
      },
    });
    await store('sdiff_oldnobase01', { repositories: [repo], baselines: [], displayLimit: 300 });
    await store('sdiff_legacywt001', { repositories: [repo] });
    const get = (id: string) =>
      request(app).get(`/api/agent/sessions/v-old/diffs/${id}`).set('x-test-subscription', 'sub-a');
    for (const id of ['sdiff_oldpartial1', 'sdiff_oldnobase01']) {
      const res = await get(id);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'Diff incomplete', code: 'diff_incomplete' });
      expect(JSON.stringify(res.body)).not.toContain('a.ts');
    }
    const legacy = await get('sdiff_legacywt001');
    expect(legacy.status).toBe(200);
    expect(legacy.body.html).toContain('Working tree changes');
    // Transcript replay no longer offers known-partial cards.
    const summary = (id: string, extra: Record<string, unknown>) => ({
      id,
      fileCount: 1,
      repositoryCount: 1,
      createdAt: new Date().toISOString(),
      scope: 'working_tree',
      ...extra,
    });
    const transcript = JSON.stringify(
      buildTranscript([
        { role: 'user', content: 'a' },
        {
          role: 'assistant',
          content: '<final_answer>\none\n</final_answer>',
          session_diff: summary('sdiff_oldpartial1', { recovered: true, recoveryIncomplete: true }),
        },
        { role: 'user', content: 'b' },
        {
          role: 'assistant',
          content: '<final_answer>\ntwo\n</final_answer>',
          session_diff: summary('sdiff_oldnobase01', { baselineUnavailable: true }),
        },
        { role: 'user', content: 'c' },
        {
          role: 'assistant',
          content: '<final_answer>\nthree\n</final_answer>',
          session_diff: summary('sdiff_legacywt001', {}),
        },
      ] as any),
    );
    expect(transcript).not.toContain('sdiff_oldpartial1');
    expect(transcript).not.toContain('sdiff_oldnobase01');
    expect(transcript).toContain('sdiff_legacywt001');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// AI reconstruction from write-like shell evidence (no native records)
// ---------------------------------------------------------------------------

describe('write-like shell classification', () => {
  const ok = { cwd: ROOT, status: 'succeeded' as const };
  const kinds = (script: string) => classifyShellWrites(script, ok)?.kinds ?? [];
  const paths = (script: string, input: Parameters<typeof classifyShellWrites>[1] = ok) =>
    (classifyShellWrites(script, input)?.targets ?? []).map((t) => t.path);

  it.each([
    ['echo hi > out.txt', 'redirect'],
    ['printf x >> log.txt', 'redirect'],
    ['echo x | tee -a a.txt', 'tee'],
    ['touch new.ts', 'touch'],
    ['mkdir -p build', 'mkdir'],
    ['cp a.ts b.ts', 'cp'],
    ['mv a.ts b.ts', 'mv'],
    ['rm -f a.ts', 'rm'],
    ["sed -i '' 's/a/b/' a.ts", 'sed -i'],
    ["perl -pi -e 's/a/b/' a.ts", 'perl -i'],
    ["python3 -c \"from pathlib import Path; Path('a.txt').write_text('x')\"", 'python write'],
    ["python3 - <<'PY'\nopen('a.txt', 'w').write('x')\nPY", 'python open'],
    ['git apply fix.patch', 'git apply'],
    ['git -C /x checkout -- a.ts', 'git checkout'],
  ])('%s is write-like (%s)', (script, kind) => {
    expect(kinds(script)).toContain(kind);
  });

  it.each([
    'ls -la',
    'cat a.ts | grep foo > /dev/null 2>&1',
    'echo oops >&2',
    'git status && git diff',
    "cat <<'EOF'\nline > not-a-file\nEOF",
    'python3 -c "print(open(\'a.txt\').read())"',
    "grep -r 'a > b' src",
  ])('read-only %j is not write-like', (script) => {
    expect(classifyShellWrites(script, ok)).toBeUndefined();
  });

  it('resolves only literal paths: cwd, $HOME, $PWD and single literal assignments', () => {
    expect(
      paths(`OUT=${NOTES}\necho x > "$OUT/a.md"; echo y > $HOME/b.md; echo z > $PWD/c.md`),
    ).toEqual([`${NOTES}/a.md`, '/Users/dev/b.md', `${ROOT}/c.md`]);
    // Unknown cwd: relative and $PWD are dropped; dynamic paths are never expanded.
    expect(
      paths('echo x > rel.txt; echo y > "$(pwd)/a"; echo z > *.log', { status: 'succeeded' }),
    ).toEqual([]);
    // A later `cd` moves the base; a reassigned variable becomes unknown.
    expect(paths(`cd ${NOTES} && echo x > a.md; D=/a; D=/b; echo > $D/x`)).toEqual([
      `${NOTES}/a.md`,
    ]);
  });

  it('marks sensitive targets and never allowlists them', () => {
    const found = classifyShellWrites(`echo KEY=1 > ${ROOT}/.env && echo x > ${ROOT}/ok.ts`, ok)!;
    expect(found.sensitive).toBe(true);
    expect(found.targets.map((t) => t.path)).toEqual([`${ROOT}/ok.ts`]);
  });

  it('creation is verified only by explicit evidence on a script that stops on failure', () => {
    const created = (script: string, status: 'succeeded' | 'failed' = 'succeeded', output = '') =>
      classifyShellWrites(script, { cwd: ROOT, status, output })!.targets.map((t) => [
        t.path,
        t.created,
      ]);
    expect(created("python3 -c \"open('n.txt', 'x').write('hi')\"")).toEqual([
      [`${ROOT}/n.txt`, false],
    ]);
    expect(created('set -e\nmkdir out\ncat > out/a.txt <<EOF\nhi\nEOF')).toEqual([
      [`${ROOT}/out/a.txt`, true],
    ]);
    expect(created('mkdir out; cat > out/a.txt')).toEqual([[`${ROOT}/out/a.txt`, false]]);
    expect(created('set -eC\necho hi > n.txt')).toEqual([[`${ROOT}/n.txt`, true]]);
    expect(created('echo hi > n.txt')).toEqual([[`${ROOT}/n.txt`, false]]);
    expect(created("python3 -c \"open('n.txt', 'x').write('hi')\"", 'failed')).toEqual([
      [`${ROOT}/n.txt`, false],
    ]);
    expect(created('mktemp /tmp/tmp.XXXXXX', 'succeeded', '/tmp/tmp.Ab12Cd\n')).toEqual([
      ['/tmp/tmp.Ab12Cd', true],
    ]);
  });

  it('never proves creation through disabled modes, masked failures or unrelated mktemp output', () => {
    for (const script of [
      'set -e; set +o noclobber; echo hi > README.md',
      'set -e; set -n; mkdir out; echo x > out/n.md',
      'set -e; set -o noexec; mkdir out; echo x > out/n.md',
      'set -eC; rm -f README.md; printf hi > README.md',
      'set -eC; mv README.md /tmp/old; printf hi > README.md',
      'set -e; rm -rf build; mkdir build; printf x > build/out.txt',
      'set -eC; find . -name README.md -delete; printf hi > README.md',
      'set -eC; git clean -fdx; printf hi > dist.js',
      'set -eC; npx rimraf build; mkdir build; printf x > build/a',
      'set -e; shopt -u -o errexit; mkdir src; printf x > src/a',
      'set -e; "set" +e; mkdir src; printf x > src/a',
      'set -e; mkdir src 2>&1 | cat; echo x > src/a.ts',
      'set -eC; echo hi > README.md | cat',
      'mkdir src & wait; echo x > src/a.ts',
      'set -e; echo $(mkdir src); echo x > src/a.ts',
      'set -e; (set -C); echo hi > README.md',
      'set -e; f() { set -C; }; echo hi > README.md',
      'set -e; trap true ERR; mkdir src; echo x > src/a.ts',
      'python3 -c "try: open(\"n.txt\",\"x\"); except: pass"',
      'set -eC; set +C; echo hi > README.md',
      'set -e; mkdir src 2>/dev/null || true; echo x > src/index.ts',
      'set -eC; echo hi > README.md || true',
      'set -e; set +e; mkdir src; echo x > src/index.ts',
      'mkdir src; set -e; echo x > src/index.ts',
      'set -e; t=$(mktemp); ls /tmp/keep.log; echo x >> /tmp/keep.log',
    ]) {
      const found = classifyShellWrites(script, {
        cwd: ROOT,
        status: 'succeeded',
        output: '/tmp/keep.log',
      });
      expect(
        found?.targets.some((t) => t.created),
        script,
      ).toBe(false);
    }
    expect(
      classifyShellWrites('git log | tee', { cwd: ROOT, status: 'succeeded' }),
    ).toBeUndefined();
    expect(redactSecrets('{"password": "hidden-json"}').text).not.toContain('hidden-json');
  });

  it('redacts obvious secrets', () => {
    const { text, redacted } = redactSecrets(
      'API_TOKEN=abc123 curl -H "Authorization: Bearer zzz" https://u:pw@h sk-abcdefghijklmnopqrstu',
    );
    expect(redacted).toBe(true);
    for (const secret of ['abc123', 'zzz', 'u:pw', 'sk-abcdefghijklmnopqrstu'])
      expect(text).not.toContain(secret);
  });
});

describe('deterministic reconstruction diff and strict reply', () => {
  it('builds valid git-style hunks for creation, edits, missing EOL and deletion', () => {
    expect(buildFilePatch('n.txt', null, 'a\nb\n')).toBe(
      'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n',
    );
    const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].join('\n') + '\n';
    const after = before.replace('5\n', 'five\n');
    expect(buildFilePatch('m.txt', before, after)).toBe(
      'diff --git a/m.txt b/m.txt\n--- a/m.txt\n+++ b/m.txt\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n',
    );
    expect(buildFilePatch('e.txt', 'x\n', 'x\ny')).toBe(
      'diff --git a/e.txt b/e.txt\n--- a/e.txt\n+++ b/e.txt\n@@ -1 +1,2 @@\n x\n+y\n\\ No newline at end of file\n'.replace(
        '@@ -1 +1,2 @@',
        '@@ -1,1 +1,2 @@',
      ),
    );
    expect(buildFilePatch('d.txt', 'gone\n', null)).toBe(
      'diff --git a/d.txt b/d.txt\ndeleted file mode 100644\n--- a/d.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-gone\n',
    );
  });

  const allow = new Map([
    [`${NOTES}/a.md`, { path: `${NOTES}/a.md`, created: true, removed: false }],
    [`${NOTES}/b.md`, { path: `${NOTES}/b.md`, created: false, removed: false }],
  ]);
  it.each([
    ['path outside the allowlist', { files: [{ path: '/etc/passwd', before: 'x', after: 'y' }] }],
    ['relative path', { files: [{ path: 'a.md', before: null, after: 'y' }] }],
    ['unverified creation', { files: [{ path: `${NOTES}/b.md`, before: null, after: 'y' }] }],
    ['unverified deletion', { files: [{ path: `${NOTES}/b.md`, before: 'x', after: null }] }],
    ['extra key', { files: [{ path: `${NOTES}/a.md`, before: null, after: 'y', patch: 'x' }] }],
    [
      'extra top-level key',
      { files: [{ path: `${NOTES}/a.md`, before: null, after: 'y' }], root: '/' },
    ],
    [
      'duplicate path',
      {
        files: [
          { path: `${NOTES}/a.md`, before: null, after: 'y' },
          { path: `${NOTES}/a.md`, before: null, after: 'z' },
        ],
      },
    ],
    [
      'oversized file',
      { files: [{ path: `${NOTES}/a.md`, before: null, after: 'x'.repeat(256 * 1024 + 1) }] },
    ],
    ['NUL byte', { files: [{ path: `${NOTES}/a.md`, before: null, after: 'a\u0000b' }] }],
  ])('rejects the whole reply on %s', (_label, body) => {
    expect(parseReconstructionFiles(body as Record<string, unknown>, allow)).toBeNull();
  });

  it('accepts an allowlisted creation and bounds model limitations', () => {
    expect(
      parseReconstructionFiles(
        {
          files: [{ path: `${NOTES}/a.md`, before: null, after: 'hi\n' }],
          limitations: ['a\nb', 'c', 'd', 'e'],
        },
        allow,
      ),
    ).toEqual({
      files: [{ path: `${NOTES}/a.md`, before: null, after: 'hi\n' }],
      limitations: ['a b', 'c', 'd'],
    });
  });

  it('keeps the reconstruction method through summary hydration', () => {
    const summary = {
      id: 'sdiff_abcdefgh12',
      fileCount: 1,
      repositoryCount: 1,
      createdAt: new Date().toISOString(),
      scope: 'working_tree',
      recovered: true,
      recoveryIncomplete: true,
      recoveryMethod: 'ai_reconstructed',
    };
    expect(cleanSessionDiffSummary(summary)?.recoveryMethod).toBe('ai_reconstructed');
    expect(
      cleanSessionDiffSummary({ ...summary, recoveryMethod: 'magic' })?.recoveryMethod,
    ).toBeUndefined();
    expect(
      cleanSessionDiffSummary({ ...summary, recovered: undefined })?.recoveryMethod,
    ).toBeUndefined();
  });
});

describe('AI reconstruction in a real agent turn', () => {
  const app = express();
  app.use('/api/agent', createAgentRouter());
  const reconstructionCalls = () =>
    mocks.complete.mock.calls.filter(
      (call) =>
        (call[1] as Array<{ content: string }>)[0]?.content === DIFF_RECONSTRUCTION_SYSTEM_PROMPT,
    );
  const CREATE_SCRIPT = `set -eC
API_TOKEN=supersecret123
printf 'hi\\n' > todo.md`;
  const writeShell = (script = CREATE_SCRIPT, id = 'c1', workingDirectory = NOTES) =>
    toolCalls([
      { id, name: 'shell_script', arguments: { script, working_directory: workingDirectory } },
    ]);

  it('no Git + write + zero records: one tool-free AI call; full known coverage is unverified, not partial', async () => {
    queueResults(writeShell(), finalAnswer('done'));
    mocks.reconstructionResult.mockResolvedValue(
      manifest({ files: [{ path: `${NOTES}/todo.md`, before: null, after: 'hi\n' }] }),
    );
    const t = await turn('ai-ok', 'create my todo', {});
    expect(t.events.slice(-2)).toEqual(['final', 'reconstruction-model']);
    expect(recoveryCalls()).toHaveLength(0);
    expect(t.requests.some((r) => r.phase === 'recover')).toBe(false);
    const [call] = reconstructionCalls();
    const [, messages, options] = call as [string, Array<{ content: string }>, any];
    expect(messages).toHaveLength(2);
    expect(options.tools).toBeUndefined();
    expect(options.maxTokens).toBe(4096);
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const payload = JSON.parse(messages[1].content);
    expect(payload.userInput).toBe('create my todo');
    expect(payload.allowedPaths).toEqual([
      { path: `${NOTES}/todo.md`, creationVerified: true, deletionAllowed: false },
    ]);
    expect(payload.commands).toMatchObject([{ toolCallId: 'c1', status: 'succeeded', cwd: NOTES }]);
    const sent = JSON.stringify(messages);
    expect(sent).not.toContain('supersecret123');
    expect(sent).not.toContain('system prompt');

    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toMatchObject({
      recovered: true,
      recoveryIncomplete: false,
      recoveryMethod: 'ai_reconstructed',
      fileCount: 1,
    });
    expect(mocks.recordTokenUsage).toHaveBeenCalledTimes(1);
    const stored = await loadSessionDiffPayload('ai-ok', 'sub-a', t.final!.session_diff!.id);
    expect(stored!.payload.repositories).toEqual([
      {
        root: NOTES,
        patch: buildFilePatch('todo.md', null, 'hi\n'),
        scope: 'working_tree',
        reconstructed: true,
      },
    ]);
    // complete = known coverage only; the content stays explicitly unverified.
    expect(stored!.payload.recovery).toMatchObject({
      kind: 'ai_reconstructed',
      evidenceIds: [],
      toolCallIds: ['c1'],
      complete: true,
    });
    expect(stored!.payload.recovery!.base).toBeUndefined();
    expect(stored!.payload.recovery!.limitations[0]).toMatch(/not verified/);
    expect(stored!.payload.recovery!.limitations).toContain(
      'Writes the backend did not recognise (for example dynamic paths) cannot be detected.',
    );

    const res = await request(app)
      .get(`/api/agent/sessions/ai-ok/diffs/${t.final!.session_diff!.id}`)
      .set('x-test-subscription', 'sub-a');
    expect(res.status).toBe(200);
    expect(res.body.html).toContain('AI-reconstructed turn changes');
    expect(res.body.html).toContain('Unverified');
    expect(res.body.html).toContain('AI-reconstructed (unverified)');
    expect(res.body.html).toContain('They may be inaccurate.');
    expect(res.body.html).not.toContain('partial or inaccurate');
    expect(res.body.html).not.toContain('Recovered turn changes');
  }, 60_000);

  it.each([
    [
      'model notes a gap',
      {
        files: [
          { path: `${NOTES}/a.md`, before: null, after: 'a\n' },
          { path: `${NOTES}/b.md`, before: null, after: 'b\n' },
        ],
        limitations: ['b.md is a guess'],
      },
    ],
    [
      'subset of the required paths',
      { files: [{ path: `${NOTES}/a.md`, before: null, after: 'a\n' }] },
    ],
  ])(
    'a reconstruction with %s is rejected (missing new file one of two => no button)',
    async (label, body) => {
      queueResults(writeShell(`set -eC\nprintf a > a.md\nprintf b > b.md`), finalAnswer('done'));
      mocks.reconstructionResult.mockResolvedValue(manifest(body));
      const id = `ai-subset-${label.replace(/\W/g, '')}`;
      const t = await turn(id, 'create two files', {});
      const payload = JSON.parse((reconstructionCalls()[0][1] as any)[1].content);
      expect(payload.allowedPaths.map((p: any) => p.path)).toEqual([
        `${NOTES}/a.md`,
        `${NOTES}/b.md`,
      ]);
      expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
      expect(t.final!.session_diff).toBeUndefined();
      expect(await diffCount(id)).toBe(0);
    },
  );

  it('automatic capture of one file + an uncovered non-Git write: AI fills it and merges, verified file untouched', async () => {
    queueResults(
      writeShell(`echo x > a.ts`, 'c1', ROOT),
      writeShell(`echo more >> n.md`, 'c2', NOTES),
      finalAnswer('done'),
    );
    mocks.reconstructionResult.mockResolvedValue(
      manifest({ files: [{ path: `${NOTES}/n.md`, before: 'n\n', after: 'n\nmore\n' }] }),
    );
    const t = await turn('ai-merge-auto', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: (req) => ({
        status: 'ok',
        repositories: (req.baselines ?? []).map((b) => ({
          root: b.root,
          patch: filePatch('a.ts'),
          scope: 'turn',
          baselineHead: b.head,
          head: OID_1,
          baselineCapturedAt: b.capturedAt,
          baselineSource: b.source,
        })),
      }),
    });
    // The verified ROOT file is never offered to the model.
    const payload = JSON.parse((reconstructionCalls()[0][1] as any)[1].content);
    expect(payload.allowedPaths.map((p: any) => p.path)).toEqual([`${NOTES}/n.md`]);
    expect(t.final!.session_diff).toMatchObject({
      scope: 'mixed',
      fileCount: 2,
      recovered: true,
      recoveryIncomplete: false,
      recoveryMethod: 'ai_reconstructed',
      baselineUnavailable: false,
    });
    const stored = await loadSessionDiffPayload(
      'ai-merge-auto',
      'sub-a',
      t.final!.session_diff!.id,
    );
    expect(stored!.payload.recovery).toMatchObject({ base: 'automatic', complete: true });
    expect(stored!.payload.repositories.map((r) => [r.root, r.scope, r.reconstructed])).toEqual([
      [ROOT, 'turn', undefined],
      [NOTES, 'working_tree', true],
    ]);
    expect(stored!.payload.repositories[0].patch).toBe(filePatch('a.ts'));
    const res = await request(app)
      .get(`/api/agent/sessions/ai-merge-auto/diffs/${t.final!.session_diff!.id}`)
      .set('x-test-subscription', 'sub-a');
    expect(res.status).toBe(200);
    expect(res.body.html).toContain('Turn changes with AI-reconstructed files');
    expect(res.body.html).toContain(`${NOTES} · AI-reconstructed (unverified)`);
    expect(res.body.html).toContain('Unverified:');

    // Same turn shape, AI unavailable: no card at all (never the partial automatic one).
    mocks.complete.mockClear();
    queueResults(
      writeShell(`echo x > a.ts`, 'c1', ROOT),
      writeShell(`echo more >> n.md`, 'c2', NOTES),
      finalAnswer('done'),
    );
    mocks.reconstructionResult.mockResolvedValue(manifest({ unavailable: true }));
    const none = await turn('ai-merge-none', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: (req) => ({
        status: 'ok',
        repositories: (req.baselines ?? []).map((b) => ({
          root: b.root,
          patch: filePatch('a.ts'),
          scope: 'turn',
          baselineHead: b.head,
          head: OID_1,
          baselineCapturedAt: b.capturedAt,
          baselineSource: b.source,
        })),
      }),
    });
    expect(reconstructionCalls()).toHaveLength(1);
    expect(none.final!.session_diff).toBeUndefined();
    expect(await diffCount('ai-merge-none')).toBe(0);
  }, 60_000);

  it('a complete automatic capture of 100 files attaches with no extra model call', async () => {
    queueResults(writeShell(`echo x > f000.ts`, 'c1', ROOT), finalAnswer('done'));
    const patch = Array.from({ length: 100 }, (_, i) =>
      filePatch(`f${String(i).padStart(3, '0')}.ts`),
    ).join('');
    const t = await turn('ai-complete-100', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: (req) => ({
        status: 'ok',
        repositories: (req.baselines ?? []).map((b) => ({
          root: b.root,
          patch,
          scope: 'turn',
          baselineHead: b.head,
          head: OID_1,
          baselineCapturedAt: b.capturedAt,
          baselineSource: b.source,
        })),
      }),
    });
    expect(t.events).not.toContain('reconstruction-model');
    expect(t.events).not.toContain('recovery-model');
    expect(t.final!.session_diff).toMatchObject({
      scope: 'turn',
      fileCount: 100,
      displayLimit: 300,
    });
    expect(t.final!.session_diff!.recovered).toBeUndefined();
  });

  it('a disclosed sensitive exclusion is a policy limit: AI attempted, card withheld', async () => {
    queueResults(writeShell(`echo x > a.ts`, 'c1', ROOT), finalAnswer('done'));
    mocks.reconstructionResult.mockResolvedValue(manifest({ unavailable: true }));
    const t = await turn('ai-sensitive', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: (req) => ({
        status: 'ok',
        reason: 'Excluded 1 sensitive file from the snapshot.',
        repositories: (req.baselines ?? []).map((b) => ({
          root: b.root,
          patch: filePatch('a.ts'),
          scope: 'turn',
          baselineHead: b.head,
          head: OID_1,
          baselineCapturedAt: b.capturedAt,
          baselineSource: b.source,
        })),
      }),
    });
    expect(reconstructionCalls()).toHaveLength(1);
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('ai-sensitive')).toBe(0);
  });

  it('manifest and reconstruction share one budget: a stalled second call is aborted', async () => {
    restoreDeps = setDiffRecoveryDepsForTesting({ totalTimeoutMs: 200 });
    shellTurn();
    mocks.recoveryResult.mockImplementation(
      () => new Promise((r) => setTimeout(() => r(manifest({ unavailable: true })), 120)),
    );
    let providerSignal: AbortSignal | undefined;
    mocks.reconstructionResult.mockImplementation(
      (_m: unknown, _msgs: unknown, o: { signal: AbortSignal }) => {
        providerSignal = o.signal;
        return new Promise(() => undefined);
      },
    );
    const started = Date.now();
    const t = await turn('ai-two-call-budget', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a.ts'])]),
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(t.events.filter((e) => e.endsWith('-model'))).toEqual([
      'recovery-model',
      'reconstruction-model',
    ]);
    expect(providerSignal?.aborted).toBe(true);
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('ai-two-call-budget')).toBe(0);
  });

  it.each([
    [
      'unknown before passed off as creation',
      { files: [{ path: `${NOTES}/plan.md`, before: null, after: 'x' }] },
    ],
    [
      'malicious path',
      { files: [{ path: '/Users/dev/.ssh/authorized_keys', before: 'a', after: 'b' }] },
    ],
    ['unavailable', { unavailable: true }],
    ['forged evidence ids', { evidenceIds: ['r1'] }],
    ['prose', 'Here is the diff: ...'],
  ])('%s: no patch, original final', async (label, body) => {
    queueResults(writeShell(`echo more >> plan.md`), finalAnswer('done'));
    mocks.reconstructionResult.mockResolvedValue(manifest(body));
    const id = `ai-bad-${label.replace(/\W/g, '')}`;
    const t = await turn(id, 'append to plan', {});
    expect(reconstructionCalls()).toHaveLength(1);
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount(id)).toBe(0);
  });

  it('a modification with a model-supplied before is saved as unverified', async () => {
    queueResults(writeShell(`echo more >> plan.md`), finalAnswer('done'));
    mocks.reconstructionResult.mockResolvedValue(
      manifest({
        files: [{ path: `${NOTES}/plan.md`, before: 'a\n', after: 'a\nmore\n' }],
        limitations: [],
      }),
    );
    const t = await turn('ai-modify', 'append', {});
    const stored = await loadSessionDiffPayload('ai-modify', 'sub-a', t.final!.session_diff!.id);
    expect(stored!.payload.recovery!.limitations).toContain(
      'Earlier file contents were inferred by the model and may be inaccurate.',
    );
  });

  it('read-only scripts never trigger reconstruction', async () => {
    shellTurn(READ_ONLY_SCRIPT);
    const t = await turn('ai-readonly', `Look at ${ROOT}`, {});
    expect(reconstructionCalls()).toHaveLength(0);
    expect(t.events).not.toContain('reconstruction-model');
    expect(t.final!.session_diff).toBeUndefined();
  });

  it('a successful normal capture skips reconstruction', async () => {
    queueResults(writeShell(`echo x > a.ts`, 'c1', ROOT), finalAnswer('done'));
    const t = await turn('ai-normal', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: (req) => ({
        status: 'ok',
        repositories: (req.baselines ?? []).map((b) => ({
          root: b.root,
          patch: filePatch('a.ts'),
          scope: 'turn',
          baselineHead: b.head,
          head: OID_1,
          baselineCapturedAt: b.capturedAt,
          baselineSource: b.source,
        })),
      }),
    });
    expect(reconstructionCalls()).toHaveLength(0);
    expect(t.final!.session_diff!.recovered).toBeUndefined();
  });

  it('verified native records keep the checkpoint path (no reconstruction)', async () => {
    shellTurn();
    mocks.recoveryResult.mockResolvedValue(manifest({ evidenceIds: ['r1'] }));
    const t = await turn('ai-native', `Fix ${ROOT}`, {
      evidence: evidenceFor((tc) => [rec('r1', tc, ROOT, ['a.ts'])]),
    });
    expect(reconstructionCalls()).toHaveLength(0);
    expect(t.final!.session_diff).toMatchObject({ recovered: true, recoveryMethod: 'checkpoint' });
  });

  it('no_changes still attempts, but never revives writes inside a net-empty root', async () => {
    queueResults(
      writeShell(`echo x > a.ts`, 'c1', ROOT),
      writeShell(`set -e\nmkdir new\necho hi > new/n.md`, 'c2', NOTES),
      finalAnswer('done'),
    );
    mocks.reconstructionResult.mockResolvedValue(manifest({ unavailable: true }));
    await turn('ai-reverted', `Fix ${ROOT}`, { heads: { [ROOT]: OID_1 }, final: emptyTurnFinal });
    expect(reconstructionCalls()).toHaveLength(1);
    const payload = JSON.parse((reconstructionCalls()[0][1] as any)[1].content);
    expect(payload.allowedPaths.map((p: any) => p.path)).toEqual([`${NOTES}/new/n.md`]);
    expect(payload.allowedPaths[0].creationVerified).toBe(false);

    // Writes only inside a net-empty root are exempt: nothing is missing, so
    // there is nothing to show and no model call.
    mocks.complete.mockClear();
    queueResults(writeShell(`echo x > a.ts`, 'c1', ROOT), finalAnswer('done'));
    const t2 = await turn('ai-reverted-2', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: emptyTurnFinal,
    });
    expect(reconstructionCalls()).toHaveLength(0);
    expect(t2.final!.session_diff).toBeUndefined();
  });

  it('unknown write targets still cause one AI attempt instead of silently skipping recovery', async () => {
    queueResults(
      writeShell('python3 -c "make_dynamic_file().write_text(value)"'),
      finalAnswer('done'),
    );
    mocks.reconstructionResult.mockResolvedValue(manifest({ unavailable: true }));
    const t = await turn('ai-unknown-target', 'write a file', {});
    expect(reconstructionCalls()).toHaveLength(1);
    expect(JSON.parse((reconstructionCalls()[0][1] as any)[1].content).allowedPaths).toEqual([]);
    expect(t.final?.session_diff).toBeUndefined();
  });

  it('offers only the current turn write evidence', async () => {
    queueResults(writeShell(`echo one > first.md`, 'c-old'), finalAnswer('done'));
    mocks.reconstructionResult.mockResolvedValue(manifest({ unavailable: true }));
    await turn('ai-turns', 'first', {});
    mocks.complete.mockClear();
    queueResults(writeShell(`echo two > second.md`, 'c-new'), finalAnswer('done'));
    await turn('ai-turns', 'second', {});
    const payload = JSON.parse((reconstructionCalls()[0][1] as any)[1].content);
    expect(payload.userInput).toBe('second');
    expect(payload.commands.map((c: any) => c.toolCallId)).toEqual(['c-new']);
    expect(JSON.stringify(payload)).not.toContain('first.md');
  });

  it('a failed write still counts (partial) and is labelled so', async () => {
    queueResults(writeShell(`echo partial > part.md && false`), finalAnswer('done'));
    mocks.reconstructionResult.mockResolvedValue(
      manifest({ files: [{ path: `${NOTES}/part.md`, before: 'old\n', after: 'partial\n' }] }),
    );
    const t = await turn('ai-failed', 'write part', { shellError: true });
    const payload = JSON.parse((reconstructionCalls()[0][1] as any)[1].content);
    expect(payload.commands[0].status).toBe('failed');
    expect(payload.allowedPaths[0].creationVerified).toBe(false);
    const stored = await loadSessionDiffPayload('ai-failed', 'sub-a', t.final!.session_diff!.id);
    expect(stored!.payload.recovery!.limitations).toContain(
      'Some write commands failed or reported no status; reconstructed content may be inaccurate.',
    );
  });

  it('cancel before the shell reply records no write evidence', async () => {
    queueResults(writeShell(`echo x > n.md`), finalAnswer('done'));
    const holder: { client?: ReturnType<typeof fakeClient> } = {};
    await turn(
      'ai-cancel',
      'write',
      { evidence: () => (holder.client!.connection.abort(), undefined) },
      { recovery: true, turn: true },
      { client: (c) => (holder.client = c) },
    );
    expect(reconstructionCalls()).toHaveLength(0);
    expect(await diffCount('ai-cancel')).toBe(0);
  });

  it('the shared deadline aborts the reconstruction call and keeps the final', async () => {
    restoreDeps = setDiffRecoveryDepsForTesting({ totalTimeoutMs: 120 });
    queueResults(writeShell(), finalAnswer('done'));
    let providerSignal: AbortSignal | undefined;
    mocks.reconstructionResult.mockImplementation(
      (_m: unknown, _msgs: unknown, o: { signal: AbortSignal }) => {
        providerSignal = o.signal;
        return new Promise(() => undefined);
      },
    );
    const started = Date.now();
    const t = await turn('ai-timeout', 'create my todo', {});
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(providerSignal?.aborted).toBe(true);
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('ai-timeout')).toBe(0);
  });
});

describe('coverage assessment', () => {
  const state = (writes: any[], extra: Record<string, unknown> = {}) =>
    ({
      records: new Map(),
      issuedToolCalls: new Set(),
      omitted: 0,
      attempted: false,
      writes,
      revertedRoots: [],
      ...extra,
    }) as any;
  const write = (targets: string[], extra: Record<string, unknown> = {}) => ({
    toolCallId: 'c1',
    status: 'succeeded',
    cwd: '/private/tmp/w',
    script: '',
    output: '',
    truncated: false,
    redacted: false,
    kinds: ['redirect'],
    targets: targets.map((path) => ({ path, created: false, removed: false })),
    ...extra,
  });
  const auto = (root: string, patch: string) => ({
    repository: { root, patch, scope: 'turn' as const },
    source: 'automatic' as const,
    turnVerified: true,
  });

  it('parses header paths safely: renames, /dev/null, quoted and basename-only never cover', () => {
    const patch = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 90%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-+++ b/injected.ts',
      'diff --git "a/sp ace.ts" "b/sp ace.ts"',
      'diff --git a/empty.ts b/empty.ts',
      'new file mode 100644',
      '',
    ].join('\n');
    expect([...patchCoveredPaths('/private/tmp/w', patch)].sort()).toEqual([
      '/tmp/w/empty.ts',
      '/tmp/w/gone.ts',
      '/tmp/w/src/new.ts',
      '/tmp/w/src/old.ts',
    ]);
    // A same-basename file in another directory is not covered.
    const c = coverageAssessment({
      state: state([write(['/tmp/w/other/new.ts', '/private/tmp/w/src/new.ts'])]),
      verified: [auto('/tmp/w', patch)],
      unchangedRoots: [],
      records: [],
    });
    expect([...c.missing.keys()]).toEqual(['/tmp/w/other/new.ts']);
    expect(c.complete).toBe(false);
  });

  it('exempts net-empty roots; unknown targets, truncation and budgets block', () => {
    const ok = coverageAssessment({
      state: state([write(['/tmp/w/a.ts'])]),
      verified: [],
      unchangedRoots: ['/private/tmp/w'],
      records: [],
    });
    expect(ok).toMatchObject({ complete: true, blocking: [] });
    for (const [w, extra, flag] of [
      [write([], { unresolved: true }), {}, 'write_target_unknown'],
      [write([], { truncated: true }), {}, 'write_evidence_truncated'],
      [write([], { kinds: ['git checkout'], cwd: '/elsewhere' }), {}, 'write_target_unknown'],
      [write([]), { writesOmitted: 1 }, 'writes_over_budget'],
      [write([]), { nativeOmitted: 2 }, 'native_omitted'],
    ] as Array<[any, Record<string, unknown>, string]>) {
      const c = coverageAssessment({
        state: state([w], extra),
        verified: [],
        unchangedRoots: [],
        records: [],
      });
      expect(c.blocking).toContain(flag);
      expect(c.complete).toBe(false);
    }
    // Git operations inside an authoritative turn root are covered by it.
    const git = coverageAssessment({
      state: state([write([], { kinds: ['git checkout'], cwd: '/tmp/w/src' })]),
      verified: [auto('/tmp/w', filePatch('a.ts'))],
      unchangedRoots: [],
      records: [],
    });
    expect(git.complete).toBe(true);
  });

  it('a later write without a checkpoint invalidates checkpoint path coverage', () => {
    const c = coverageAssessment({
      state: state([write([`${NOTES}/a.md`], { toolCallId: 'c2' })], {
        issuedToolCalls: new Set(['c1', 'c2']),
      }),
      verified: [
        {
          repository: { root: NOTES, patch: filePatch('a.md'), scope: 'working_tree' },
          source: 'checkpoint',
          turnVerified: false,
          evidenceIds: ['r1'],
        },
      ],
      unchangedRoots: [],
      records: [rec('r1', 'c1', NOTES, ['a.md'], 'file')],
    });
    expect(c.complete).toBe(false);
    expect(c.blocking).toContain('checkpoint_not_final');
  });

  it('records need their paths covered; truncated records block', () => {
    const c = coverageAssessment({
      state: undefined,
      verified: [auto(ROOT, filePatch('a.ts'))],
      unchangedRoots: [],
      records: [
        rec('r1', 'c1', ROOT, ['a.ts', 'b.ts']),
        rec('r2', 'c1', NOTES, ['n.md'], 'file', false),
      ],
    });
    expect([...c.missing.values()]).toEqual([
      { path: `${ROOT}/b.ts`, created: false, removed: false },
      { path: `${NOTES}/n.md`, created: true, removed: false },
    ]);
    expect(c.blocking).toEqual(['native_record_truncated']);
  });

  it('dedupes replayed sections already covered and reads native reasons', () => {
    const covered = patchCoveredPaths(ROOT, filePatch('a.ts'));
    expect(withoutCoveredSections(ROOT, filePatch('a.ts') + filePatch('b.ts'), covered)).toBe(
      filePatch('b.ts'),
    );
    expect(reasonDisclosesExclusion('Excluded 2 sensitive files from the snapshot.')).toBe(true);
    expect(
      reasonDisclosesExclusion(
        'Turn baseline unavailable for 1 repository; showing uncommitted changes only.',
      ),
    ).toBe(false);
    expect(reasonDisclosesExclusion(undefined)).toBe(false);
  });

  it('write classification flags unresolved targets', () => {
    const ok = { cwd: ROOT, status: 'succeeded' as const };
    expect(classifyShellWrites('echo x > "$OUT"', ok)?.unresolved).toBe(true);
    expect(classifyShellWrites('cp -r src', ok)?.unresolved).toBe(true);
    expect(classifyShellWrites('python3 -c "Path(p).write_text(v)"', ok)?.unresolved).toBe(true);
    expect(classifyShellWrites('echo x > a.ts 2>/dev/null', ok)?.unresolved).toBe(false);
    expect(classifyShellWrites('echo x > rel.ts', { status: 'succeeded' })?.unresolved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task bookkeeping and Python Path variables (agent bootstrap/cleanup turns)
// ---------------------------------------------------------------------------

const TASK_BOOTSTRAP = `TASK_ID="$(date +%Y%m%d-%H%M%S)-repo-and-tmp"
TASK_DIR="$HOME/.omniAgent/garbage/$TASK_ID"
CONFIG_DIR="$HOME/.omnikey/garbage/$TASK_ID"
mkdir -p "$TASK_DIR"/{prompts,logs,handoffs,tmp} "$CONFIG_DIR"
touch "$TASK_DIR/.omniagent-owned"
printf 'running\\n' > "$TASK_DIR/status"
printf 'type\\tpath\\n' > "$TASK_DIR/ledger.tsv"
printf 'tmp\\t%s\\n' "$TASK_DIR" >> "$TASK_DIR/ledger.tsv"`;
const TASK_CLEANUP = `TASK_DIR=$(ls -td "$HOME/.omniAgent/garbage"/*-repo-and-tmp 2>/dev/null | head -1)
cat > "$TASK_DIR/summary.md" <<'EOF'
# Summary
Patched README and appended the scratch note.
EOF
printf 'complete\\n' > "$TASK_DIR/status"
rm -rf "$TASK_DIR/prompts" "$TASK_DIR/logs" "$TASK_DIR/handoffs" "$TASK_DIR/tmp"`;
const README_PATCH = `python3 - <<'PY'
from pathlib import Path
p=Path('${ROOT}/README.md');s=p.read_text();assert 'old' in s;p.write_text(s.replace('old','new'))
PY`;
const SCRATCH = '/private/tmp/omni-scratch';
const SCRATCH_APPEND = `printf 'more\\n' >> ${SCRATCH}/notes.txt`;

describe('task bookkeeping and Python Path variable classification', () => {
  it('a printed TASK_DIR label is data and does not invalidate task provenance', () => {
    const result = classifyShellWrites(TASK_BOOTSTRAP + '\nprintf \'TASK_DIR=%s\\n\' "$TASK_DIR"', {
      cwd: ROOT,
      status: 'succeeded',
    });
    expect(result?.unresolved).toBe(false);
  });

  const ok = { cwd: ROOT, status: 'succeeded' as const };
  const classify = (script: string, input: Parameters<typeof classifyShellWrites>[1] = ok) =>
    classifyShellWrites(script, input)!;
  const names = (script: string) =>
    (classify(script).auxiliaryTargets ?? []).map((a) => `${a.name}${a.removed ? ':rm' : ''}`);

  it('bootstrap and cleanup bookkeeping resolve to auxiliary entries, not unknown targets', () => {
    const boot = classify(TASK_BOOTSTRAP);
    expect(boot.unresolved).toBe(false);
    expect(boot.targets).toEqual([]);
    expect(names(TASK_BOOTSTRAP)).toEqual(['.omniagent-owned', 'status', 'ledger.tsv']);
    const clean = classify(TASK_CLEANUP);
    expect(clean.unresolved).toBe(false);
    expect(clean.targets).toEqual([]);
    expect(names(TASK_CLEANUP)).toEqual([
      'summary.md',
      'status',
      'prompts:rm',
      'logs:rm',
      'handoffs:rm',
      'tmp:rm',
    ]);
    expect(clean.auxiliaryTargets!.every((a) => a.path === undefined)).toBe(true);
    // Literal task directories carry the resolved path.
    const literal = classify(
      `echo done > /Users/dev/.omniAgent/garbage/t-1/summary.md; rm -rf /Users/dev/.omnikey/garbage/t-1/tmp`,
    );
    expect(literal).toMatchObject({ unresolved: false, targets: [] });
    expect(literal.auxiliaryTargets).toEqual([
      { name: 'summary.md', path: '/Users/dev/.omniAgent/garbage/t-1/summary.md', removed: false },
      { name: 'tmp', path: '/Users/dev/.omnikey/garbage/t-1/tmp', removed: true },
    ]);
  });

  it.each([
    [
      'a worktree under the task directory',
      `${TASK_BOOTSTRAP}\necho x > "$TASK_DIR/worktree/a.ts"`,
    ],
    ['an integration file', `${TASK_BOOTSTRAP}\necho x > "$TASK_DIR/integration.md"`],
    ['an arbitrary markdown file', `${TASK_BOOTSTRAP}\necho x > "$TASK_DIR/notes.md"`],
    ['removing the whole task directory', `${TASK_BOOTSTRAP}\nrm -rf "$TASK_DIR"`],
    ['writing a scratch name as a file', `${TASK_BOOTSTRAP}\necho x > "$TASK_DIR/tmp"`],
    ['a nested metadata name', `${TASK_BOOTSTRAP}\necho x > "$TASK_DIR/tmp/status"`],
    ['an unrelated unknown write (mixed script)', `${TASK_BOOTSTRAP}\necho x > "$OUT/a.md"`],
    [
      'a reassigned task variable',
      `${TASK_BOOTSTRAP}\nTASK_DIR="$HOME/work"\necho x > "$TASK_DIR/status"`,
    ],
    [
      'eval rebinding',
      `${TASK_BOOTSTRAP}\neval "TASK_DIR=/Users/dev/repo"\nrm -rf "$TASK_DIR/tmp"; echo x > "$TASK_DIR/status"`,
    ],
    ['source rebinding', `${TASK_BOOTSTRAP}\nsource /tmp/config.sh\necho x > "$TASK_DIR/status"`],
    ['dot source rebinding', `${TASK_BOOTSTRAP}\n. /tmp/config.sh\necho x > "$TASK_DIR/status"`],
    [
      'metadata symlink',
      `${TASK_BOOTSTRAP}\nln -sf /Users/dev/repo/README.md "$TASK_DIR/summary.md"\necho x >> "$TASK_DIR/summary.md"`,
    ],
    ...[
      'export "TASK_DIR=/Users/dev/repo"',
      "export 'TASK_DIR=/Users/dev/repo'",
      'readonly "TASK_DIR=/Users/dev/repo"',
      'TASK_DIR[0]=/Users/dev/repo',
      "trap 'TASK_DIR=/Users/dev/repo' DEBUG",
      `e''val "TASK_DIR=/Users/dev/repo"`,
    ].map((rebind) => [
      'obscured rebinding ' + rebind,
      `${TASK_BOOTSTRAP}\n${rebind}\nrm -rf "$TASK_DIR/tmp"; echo x > "$TASK_DIR/status"`,
    ]),
    ...[
      'export "TASK""_DIR=/Users/dev/repo"',
      `declare -g TA''SK_DIR=/Users/dev/repo`,
      String.raw`export TASK\_DIR=/Users/dev/repo`,
      `printf -v TASK''_DIR %s /Users/dev/repo`,
      'read -r TASK""_DIR <<< /Users/dev/repo',
      'p=TASK; export "${p}_DIR=/Users/dev/repo"',
      ': ${TASK_DIR::=/Users/dev/repo}',
    ].map((rebind) => [
      'split-name rebinding ' + rebind,
      `${TASK_BOOTSTRAP}\n${rebind}\nrm -rf "$TASK_DIR/tmp"; echo x > "$TASK_DIR/status"`,
    ]),
    [
      'continued assignment',
      `${TASK_BOOTSTRAP}\nTASK_` +
        String.fromCharCode(92, 10) +
        `DIR=/Users/dev/repo\nrm -rf "$TASK_DIR/tmp"; echo x > "$TASK_DIR/status"`,
    ],
    ['an argument-provided directory', `TASK_DIR="$1"\necho x > "$TASK_DIR/status"`],
    ['a traversal child', `TASK_DIR="$HOME/.omniAgent/garbage/.."\necho x > "$TASK_DIR/status"`],
    [
      'a slash-producing date format',
      `TASK_DIR="$HOME/.omniAgent/garbage/$(date +%D)"\necho x > "$TASK_DIR/status"`,
    ],
    [
      'ls without -d',
      `TASK_DIR=$(ls -t "$HOME/.omniAgent/garbage"/* | head -1)\necho x > "$TASK_DIR/status"`,
    ],
    [
      'a single-quoted assignment',
      `TASK_DIR='$HOME/.omniAgent/garbage/t'\necho x > "$TASK_DIR/status"`,
    ],
    [
      'use before the assignment',
      `echo x > "$TASK_DIR/status"\nTASK_DIR="$HOME/.omniAgent/garbage/t"`,
    ],
    [
      'a literal non-metadata entry',
      `echo x > /Users/dev/.omniAgent/garbage/t-1/worktree/a.ts\necho y > "$Q/z"`,
    ],
  ])('%s is never treated as bookkeeping', (_label, script) => {
    expect(classify(script).unresolved).toBe(true);
  });

  it.each([
    ['a non-garbage directory', `TASK_DIR="$HOME/projects/app"`, '/Users/dev/projects/app/status'],
    [
      'a conditional assignment',
      `if true; then\nTASK_DIR="$HOME/.omniAgent/garbage/t"\nfi`,
      '/Users/dev/.omniAgent/garbage/t/status',
    ],
    [
      'a variable-built literal task path',
      `D="$HOME/.omniAgent/garbage/t"\nTASK_DIR="$D"`,
      '/Users/dev/.omniAgent/garbage/t/status',
    ],
  ])('%s that resolves literally stays a normal target', (_label, prefix, path) => {
    const found = classify(`${prefix}\necho x > "$TASK_DIR/status"`);
    expect(found.auxiliaryTargets).toEqual([]);
    expect(found.targets.map((t) => t.path)).toEqual([path]);
  });

  it('a literal deliverable inside the task directory stays a normal target', () => {
    const found = classify(`echo x > /Users/dev/.omniAgent/garbage/t-1/worktree/a.ts`);
    expect(found.targets.map((t) => t.path)).toEqual([
      '/Users/dev/.omniAgent/garbage/t-1/worktree/a.ts',
    ]);
    expect(found.auxiliaryTargets).toEqual([]);
  });

  it('a mixed script keeps its bookkeeping and its unknown write separately', () => {
    const found = classify(`${TASK_CLEANUP}\necho x > "$DEST/out.md"`);
    expect(found.unresolved).toBe(true);
    expect(found.auxiliaryTargets!.map((a) => a.name)).toContain('summary.md');
  });

  it('resolves one literal Path variable binding to its write target', () => {
    expect(classify(README_PATCH)).toMatchObject({
      unresolved: false,
      targets: [{ path: `${ROOT}/README.md`, created: false, removed: false }],
    });
    expect(classify(README_PATCH).kinds).toContain('python write');
    const inline = `python3 -c "from pathlib import Path; out = Path('docs/a.md'); out.write_bytes(b'x')"`;
    expect(classify(inline)).toMatchObject({
      unresolved: false,
      targets: [{ path: `${ROOT}/docs/a.md` }],
    });
    // A leading literal cd is the base of a relative literal.
    expect(
      classify(`cd /elsewhere\npython3 -c "p=Path('a.md');p.write_text('z')"`).targets,
    ).toMatchObject([{ path: '/elsewhere/a.md' }]);
    // A relative literal without a known cwd stays unknown.
    expect(classify(inline, { status: 'succeeded' }).unresolved).toBe(true);
  });

  it.each([
    ['reassignment', `p=Path('/a/x');p=Path('/a/y');p.write_text('z')`],
    ['augmented assignment', `p=Path('/a');p/='x';p.write_text('z')`],
    ['aliasing', `p=Path('/a/x');q=p;q.write_text('z')`],
    ['tuple binding', `p=Path('/a/x');a, p = 1, Path('/b');p.write_text('z')`],
    ['for loop', `p=Path('/a/x')\nfor p in []: pass\np.write_text('z')`],
    ['with-as', `p=Path('/a/x')\nwith open('/a/y') as p: pass\np.write_text('z')`],
    ['walrus', `p=Path('/a/x');(p := Path('/b'));p.write_text('z')`],
    ['conditional statement', `if c: p=Path('/a/x')\np.write_text('z')`],
    ['indented (block) binding', `if c:\n    p=Path('/a/x')\np.write_text('z')`],
    ['a ternary value', `p=Path('/a/x') if c else Path('/b');p.write_text('z')`],
    ['a dynamic path', `p=Path(base)/'x';p.write_text('z')`],
    ['a joined path', `p=Path('/a') / 'x';p.write_text('z')`],
    ['a function parameter', `p=Path('/a/x')\ndef f(p):\n    p.write_text('z')`],
    ['exec', `p=Path('/a/x');exec('p=1');p.write_text('z')`],
    ['an unbound variable', `p.write_text('z')`],
    ['a keyword argument', `f(\np=Path('/a/x'))\np.write_text('z')`],
    [
      'a relative path after a second cd',
      `cd /elsewhere\ncd sub\npython3 -c "p=Path('a.md');p.write_text('z')"`,
    ],
  ])('python %s stays unknown', (_label, body) => {
    const script = body.startsWith('cd ') ? body : `python3 - <<'PY'\n${body}\nPY`;
    expect(classify(script).unresolved).toBe(true);
  });
});

describe('task bookkeeping coverage', () => {
  const TASK = '/Users/dev/.omniAgent/garbage/t-1';
  const state = (writes: any[]) =>
    ({
      records: new Map(),
      issuedToolCalls: new Set(['c1', 'c2']),
      omitted: 0,
      attempted: false,
      writes,
      revertedRoots: [],
    }) as any;
  const write = (extra: Record<string, unknown>) => ({
    toolCallId: 'c2',
    status: 'succeeded',
    cwd: ROOT,
    script: '',
    output: '',
    truncated: false,
    redacted: false,
    kinds: ['rm'],
    targets: [],
    ...extra,
  });
  const checkpoint = (root: string, rel: string) => ({
    repository: { root, patch: filePatch(rel), scope: 'working_tree' as const },
    source: 'checkpoint' as const,
    turnVerified: false,
    evidenceIds: ['r1'],
  });
  const assess = (w: any, root: string, rel: string) =>
    coverageAssessment({
      state: state([w]),
      verified: [checkpoint(root, rel)],
      unchangedRoots: [],
      records: [rec('r1', 'c1', root, [rel], 'file')],
    });

  it('bookkeeping needs no coverage and keeps an unrelated checkpoint final', () => {
    const c = assess(
      write({
        auxiliaryTargets: [
          { name: 'tmp', removed: true },
          { name: 'status', removed: false },
        ],
      }),
      SCRATCH,
      'notes.txt',
    );
    expect(c).toMatchObject({ complete: true, blocking: [] });
    expect(c.missing.size).toBe(0);
  });

  it('bookkeeping that reaches a checkpointed path still invalidates it', () => {
    // Pattern-only removal of tmp/ covers tmp/ of any task directory.
    expect(
      assess(write({ auxiliaryTargets: [{ name: 'tmp', removed: true }] }), `${TASK}/tmp`, 'a.txt')
        .blocking,
    ).toContain('checkpoint_not_final');
    expect(
      assess(
        write({ auxiliaryTargets: [{ name: 'summary.md', removed: false }] }),
        TASK,
        'summary.md',
      ).blocking,
    ).toContain('checkpoint_not_final');
    // A literal directory removal reaches files below it.
    expect(
      assess(
        write({ targets: [{ path: SCRATCH, created: false, removed: true }] }),
        SCRATCH,
        'notes.txt',
      ).blocking,
    ).toContain('checkpoint_not_final');
    // An unknown target in the same later script always invalidates.
    expect(
      assess(
        write({ unresolved: true, auxiliaryTargets: [{ name: 'tmp', removed: true }] }),
        SCRATCH,
        'notes.txt',
      ).blocking,
    ).toEqual(expect.arrayContaining(['checkpoint_not_final', 'write_target_unknown']));
  });
});

describe('bootstrap + README patch + scratch append + cleanup in a real agent turn', () => {
  const PREEXISTING = Array.from({ length: 10 }, (_, i) => `src/dirty${i}.ts`);
  const shell = (id: string, script: string) =>
    toolCalls([{ id, name: 'shell_script', arguments: { script, working_directory: ROOT } }]);
  const autoFinal = (req: GitDiffRequest): Body => ({
    status: 'ok',
    repositories: (req.baselines ?? []).map((b) => ({
      root: b.root,
      patch: [...PREEXISTING, 'README.md'].map((p) => filePatch(p)).join(''),
      scope: 'turn',
      baselineHead: b.head,
      head: OID_1,
      baselineCapturedAt: b.capturedAt,
      baselineSource: b.source,
    })),
  });
  const evidence = (ctx: Record<string, unknown> | undefined) => {
    const tc = String(ctx?.tool_call_id);
    if (!ctx?.turn_id || (tc !== 'c2' && tc !== 'c3')) return undefined;
    return {
      turn_id: ctx.turn_id,
      records:
        tc === 'c2'
          ? [rec('r-readme', tc, ROOT, ['README.md'])]
          : [rec('r-tmp', tc, SCRATCH, ['notes.txt'], 'file')],
    };
  };
  const finished = () =>
    log.info.mock.calls
      .filter((c: any[]) => c[0] === 'Diff recovery finished')
      .map((c: any[]) => c[1]);

  it('yields one combined complete snapshot (automatic README + checkpointed scratch file)', async () => {
    queueResults(
      shell('c1', TASK_BOOTSTRAP),
      shell('c2', README_PATCH),
      shell('c3', SCRATCH_APPEND),
      shell('c4', TASK_CLEANUP),
      finalAnswer('done'),
    );
    mocks.recoveryResult.mockImplementation(async (_m: unknown, messages: any[]) =>
      manifest({ evidenceIds: JSON.parse(messages[1].content).records.map((r: any) => r.id) }),
    );
    const t = await turn('task-bookkeeping-ok', `Patch ${ROOT}/README.md`, {
      heads: { [ROOT]: OID_1 },
      final: autoFinal,
      evidence,
    });
    expect(t.events.filter((e) => e === 'reconstruction-model')).toHaveLength(0);
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toMatchObject({
      recovered: true,
      recoveryIncomplete: false,
      recoveryMethod: 'checkpoint',
      fileCount: 12,
    });
    expect(finished().map((f: any) => f.result)).toEqual(['saved_checkpoint']);
    const stored = await loadSessionDiffPayload(
      'task-bookkeeping-ok',
      'sub-a',
      t.final!.session_diff!.id,
    );
    expect(stored!.payload.recovery).toMatchObject({ kind: 'agent_assisted', complete: true });
    expect(stored!.payload.repositories.map((r) => [r.root, r.scope])).toEqual([
      [ROOT, 'turn'],
      [SCRATCH, 'working_tree'],
    ]);
  }, 60_000);

  it('an unknown write after the scratch checkpoint still withholds the snapshot', async () => {
    queueResults(
      shell('c1', TASK_BOOTSTRAP),
      shell('c2', README_PATCH),
      shell('c3', SCRATCH_APPEND),
      shell('c4', `${TASK_CLEANUP}\necho x > "$DEST/notes.txt"`),
      finalAnswer('done'),
    );
    mocks.recoveryResult.mockImplementation(async (_m: unknown, messages: any[]) =>
      manifest({ evidenceIds: JSON.parse(messages[1].content).records.map((r: any) => r.id) }),
    );
    mocks.reconstructionResult.mockResolvedValue(manifest({ unavailable: true }));
    const t = await turn('task-bookkeeping-unknown', `Patch ${ROOT}/README.md`, {
      heads: { [ROOT]: OID_1 },
      final: autoFinal,
      evidence,
    });
    expect(t.final!.content).toBe('<final_answer>\ndone\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(await diffCount('task-bookkeeping-unknown')).toBe(0);
    const [result] = finished();
    expect(result.result).toBe('withheld_uncertain');
    expect(result.blocking).toEqual(
      expect.arrayContaining(['checkpoint_not_final', 'write_target_unknown']),
    );
  }, 60_000);
});
