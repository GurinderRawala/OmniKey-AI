/**
 * Git-first final diffs with the editing agent's own unified patches as the
 * per-file fallback (`supports_agent_patches: true`), against a real isolated
 * in-memory SQLite database, a fake native client answering Git control
 * frames on the run's own connection, a fake AI provider (the editing agent
 * only: no second model call may ever happen) and the real Pierre SSR route.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '../agent/types';
import { finalAnswer, toolCalls } from './helpers/agentSkillsHarness';

const mocks = vi.hoisted(() => {
  const log = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn(), child: vi.fn() };
  return { log, complete: vi.fn(), recordTokenUsage: vi.fn(async () => undefined) };
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
import { createGitRunState, handleGitDiffResponseFrame } from '../agent/gitDiff/coordinator';
import {
  cleanSessionDiffSummary,
  isKnownPartialPayload,
  type GitDiffRequest,
} from '../agent/gitDiff/contracts';
import {
  AGENT_PATCH_INSTRUCTION,
  AGENT_PATCH_MAX_FILE_BYTES,
  AgentPatchError,
  parseAgentFinal,
  parseAgentPatchBlock,
  renderAgentPatchSection,
  validateAgentPatchEntry,
  withAgentPatchInstruction,
} from '../agent/gitDiff/agentPatch';
import { agentRepositories, patchCoveredPaths } from '../agent/gitDiff/finalDiff';
import { isSensitivePath } from '../agent/gitDiff/pathPolicy';
import { clearDiffRenderCacheForTesting } from '../agent/gitDiff/ssrRenderer';
import { setSkillResolverForTesting } from '../agent/skillContext';
import { buildTranscript } from '../agent/agentServer/transcript';
import { getAgentSettings } from '../agentSettingsStore';

const log = mocks.log as any;
const ROOT = '/Users/dev/projects/app';
const OTHER = '/Users/dev/projects/widget';
const NOTES = '/Users/dev/notes';
const OID_1 = '1'.repeat(40);
const AGENT_LINE = 'AGENT_PATCH_LINE_7f3c';

function gitPatch(path: string, line = 'x'): string {
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

/** A valid one-file agent patch for `abs` (header uses the basename). */
function agentPatch(abs: string, line = AGENT_LINE): string {
  const name = abs.split('/').pop()!;
  return [
    `diff --git a/${name} b/${name}`,
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-old',
    `+${line}`,
    '',
  ].join('\n');
}

function newFilePatch(abs: string, lines: string[]): string {
  const name = abs.split('/').pop()!;
  return [
    `diff --git a/${name} b/${name}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${name}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
    '',
  ].join('\n');
}

function report(files: unknown[], opts: { marker?: boolean } = {}): string {
  return [
    ...(opts.marker === false ? [] : ['[files_changed]']),
    `<file_patches>${JSON.stringify({ files })}</file_patches>`,
  ].join('\n');
}

type Body = Record<string, unknown> | null;
interface ClientOptions {
  heads?: Record<string, string | null>;
  final?: (req: GitDiffRequest) => Body;
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

/** Turn final: per baselined root its patch (default empty), plus extra entries. */
function turnFinal(patches: Record<string, string>, extra: Array<Record<string, unknown>> = []) {
  return (req: GitDiffRequest): Body => ({
    status: 'ok',
    repositories: [
      ...(req.baselines ?? []).map((b) => ({
        root: b.root,
        patch: patches[b.root] ?? '',
        scope: 'turn',
        baselineHead: b.head,
        head: b.head,
        baselineCapturedAt: b.capturedAt,
        baselineSource: b.source,
      })),
      ...extra,
    ],
  });
}

function fakeClient(sessionId: string, opts: ClientOptions) {
  const connection = new AbortController();
  const frames: AgentMessage[] = [];
  const send = async (msg: AgentMessage) => {
    frames.push(msg);
    if (msg.content.startsWith('<shell_script>')) {
      const { pendingShellScripts } = await import('../agent/agentServer/runtimeState');
      setTimeout(
        () => pendingShellScripts.get(sessionId)?.resolve('TERMINAL OUTPUT:\nok', false),
        1,
      );
    }
    const req = msg.git_diff_request;
    if (!req) return;
    const body =
      req.phase === 'baseline'
        ? defaultBaseline(opts.heads ?? {})(req)
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
  return { connection, frames, send: (m: AgentMessage) => void send(m) };
}

function queueResults(...results: unknown[]) {
  const queue = [...results];
  mocks.complete.mockImplementation(async () => queue.shift() ?? finalAnswer('done'));
}

async function turn(
  sessionId: string,
  content: string,
  opts: ClientOptions,
  capability: { patches?: boolean; turn?: boolean; recovery?: boolean } = {
    patches: true,
    turn: true,
  },
) {
  const client = fakeClient(sessionId, opts);
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
      ...(capability.patches ? { supportsAgentPatches: true } : {}),
      ...(capability.recovery ? ({ supportsDiffRecovery: true } as object) : {}),
    },
  );
  const requests = client.frames.filter((f) => f.git_diff_request).map((f) => f.git_diff_request!);
  const final = client.frames.find((f) => f.content.includes('<final_answer>'));
  return { ...client, requests, final };
}

/** Provider requests of the editing agent (the only model calls allowed). */
const modelRequests = () =>
  mocks.complete.mock.calls.map((call) => call[1] as Array<{ role: string; content: string }>);

const app = express();
app.use('/api/agent', createAgentRouter());
const view = (sessionId: string, diffId: string, sub = 'sub-a') =>
  request(app)
    .get(`/api/agent/sessions/${sessionId}/diffs/${diffId}`)
    .set('x-test-subscription', sub);

async function payloadOf(id: string) {
  const { decompressString } = await import('../compression');
  const row = await AgentSessionDiff.findOne({ where: { id } });
  return JSON.parse(decompressString(row!.payload)!);
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

// ---------------------------------------------------------------------------
// Strict patch validation
// ---------------------------------------------------------------------------

describe('agent patch entry validation', () => {
  const FILE = `${NOTES}/todo.md`;
  const reject = (entry: unknown) =>
    expect(() => validateAgentPatchEntry(entry)).toThrow(AgentPatchError);

  it('accepts a modification and re-emits canonical headers relative to the root', () => {
    const file = validateAgentPatchEntry({
      path: FILE,
      patch: `diff --git a/todo.md b/todo.md\nindex abcdef0..1234567 100644\n--- a/todo.md\n+++ b/todo.md\n@@ -1,2 +1,2 @@ heading\n keep\n-old\n+new\n`,
    });
    expect(file).toMatchObject({ path: FILE, kind: 'modified', binary: false });
    expect(renderAgentPatchSection(file, NOTES)).toBe(
      'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n@@ -1,2 +1,2 @@ heading\n keep\n-old\n+new\n',
    );
    // A repository-relative suffix header is accepted too; output uses our root.
    const nested = validateAgentPatchEntry({
      path: `${ROOT}/src/a.ts`,
      patch: gitPatch('src/a.ts'),
    });
    expect(renderAgentPatchSection(nested, ROOT)).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(renderAgentPatchSection(nested, ROOT)).not.toContain('index ');
  });

  it('accepts creation, deletion, rename, mode change, binary summary and newline markers', () => {
    expect(
      validateAgentPatchEntry({ path: FILE, patch: newFilePatch(FILE, ['a', 'b']) }),
    ).toMatchObject({
      kind: 'added',
      mode: '100644',
    });
    // Empty new file: header only.
    expect(
      validateAgentPatchEntry({
        path: FILE,
        patch: 'diff --git a/todo.md b/todo.md\nnew file mode 100644\n',
      }).kind,
    ).toBe('added');
    const deleted = validateAgentPatchEntry({
      path: FILE,
      patch:
        'diff --git a/todo.md b/todo.md\ndeleted file mode 100644\n--- a/todo.md\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n\\ No newline at end of file\n',
    });
    expect(deleted.kind).toBe('deleted');
    expect(renderAgentPatchSection(deleted, NOTES)).toContain(
      '+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n\\ No newline at end of file\n',
    );
    const renamed = validateAgentPatchEntry({
      path: `${NOTES}/done.md`,
      oldPath: FILE,
      patch:
        'diff --git a/todo.md b/done.md\nsimilarity index 90%\nrename from todo.md\nrename to done.md\n--- a/todo.md\n+++ b/done.md\n@@ -1 +1 @@\n-x\n+y\n',
    });
    expect(renamed).toMatchObject({ kind: 'renamed', oldPath: FILE });
    expect(renderAgentPatchSection(renamed, NOTES)).toContain(
      'rename from todo.md\nrename to done.md',
    );
    expect(
      validateAgentPatchEntry({
        path: `${NOTES}/done.md`,
        oldPath: FILE,
        patch:
          'diff --git a/todo.md b/done.md\nsimilarity index 100%\nrename from todo.md\nrename to done.md\n',
      }).hunks,
    ).toEqual([]);
    expect(
      validateAgentPatchEntry({
        path: `${NOTES}/run.sh`,
        patch: 'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n',
      }).modeChange,
    ).toEqual({ from: '100644', to: '100755' });
    expect(
      validateAgentPatchEntry({
        path: `${NOTES}/logo.png`,
        patch: 'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
      }).binary,
    ).toBe(true);
    // An empty context line whose single space was dropped still counts.
    expect(
      validateAgentPatchEntry({
        path: FILE,
        patch:
          'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n',
      }).hunks[0],
    ).toEqual(['@@ -1,3 +1,3 @@', ' a', ' ', '-b', '+c']);
  });

  it.each([
    ['relative path', { path: 'todo.md', patch: agentPatch('/x/todo.md') }],
    ['traversal', { path: `${NOTES}/../etc/passwd`, patch: agentPatch('/etc/passwd') }],
    ['control char path', { path: `${NOTES}/a\u0007.md`, patch: agentPatch('/a.md') }],
    ['quote in path', { path: `${NOTES}/a".md`, patch: agentPatch(`${NOTES}/a".md`) }],
    [
      'sensitive .ssh',
      { path: '/Users/dev/.ssh/config', patch: agentPatch('/Users/dev/.ssh/config') },
    ],
    ['sensitive .env', { path: `${ROOT}/.env`, patch: agentPatch(`${ROOT}/.env`) }],
    [
      'hidden home config',
      { path: '/Users/dev/.config/gh/hosts.yml', patch: agentPatch('/x/hosts.yml') },
    ],
    ['unknown field', { path: FILE, patch: agentPatch(FILE), before: 'x' }],
    ['missing patch', { path: FILE }],
    ['empty patch', { path: FILE, patch: '  ' }],
    ['header for another file', { path: FILE, patch: agentPatch(`${NOTES}/other.md`) }],
    ['two files in one entry', { path: FILE, patch: agentPatch(FILE) + agentPatch(FILE) }],
    [
      'no diff header',
      { path: FILE, patch: '--- a/todo.md\n+++ b/todo.md\n@@ -1 +1 @@\n-a\n+b\n' },
    ],
    [
      'hunk count too small',
      {
        path: FILE,
        patch:
          'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n@@ -1 +1 @@\n-a\n-b\n+c\n',
      },
    ],
    [
      'truncated hunk',
      {
        path: FILE,
        patch:
          'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n@@ -1,3 +1,3 @@\n a\n-b\n',
      },
    ],
    [
      'garbage hunk line',
      {
        path: FILE,
        patch:
          'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n@@ -1 +1 @@\n*a\n+b\n',
      },
    ],
    [
      'misplaced newline marker',
      {
        path: FILE,
        patch:
          'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n@@ -1 +1 @@\n\\ No newline at end of file\n-a\n+b\n',
      },
    ],
    [
      'file lines without hunk',
      { path: FILE, patch: 'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n' },
    ],
    ['header only, no change', { path: FILE, patch: 'diff --git a/todo.md b/todo.md\n' }],
    [
      'overlapping hunks',
      {
        path: FILE,
        patch:
          'diff --git a/todo.md b/todo.md\n--- a/todo.md\n+++ b/todo.md\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n@@ -1 +1 @@\n-a\n+z\n',
      },
    ],
    [
      'rename without oldPath',
      {
        path: `${NOTES}/done.md`,
        patch: 'diff --git a/done.md b/done.md\nrename from todo.md\nrename to done.md\n',
      },
    ],
    [
      'oldPath without rename lines',
      { path: `${NOTES}/done.md`, oldPath: FILE, patch: agentPatch(`${NOTES}/done.md`) },
    ],
    [
      'addition in a deleted file',
      {
        path: FILE,
        patch:
          'diff --git a/todo.md b/todo.md\ndeleted file mode 100644\n--- a/todo.md\n+++ /dev/null\n@@ -1 +0,0 @@\n+a\n',
      },
    ],
    [
      'GIT binary patch literal',
      { path: FILE, patch: 'diff --git a/todo.md b/todo.md\nGIT binary patch\nliteral 5\n' },
    ],
    ['NUL byte', { path: FILE, patch: agentPatch(FILE).replace('keep', 'ke\u0000ep') }],
    [
      'oversize file',
      { path: FILE, patch: newFilePatch(FILE, ['x'.repeat(AGENT_PATCH_MAX_FILE_BYTES)]) },
    ],
  ])('rejects %s', (_label, entry) => reject(entry));

  it('a batch fails closed on any bad entry, duplicates, bounds and wrong schema', () => {
    const good = { path: `${NOTES}/a.md`, patch: agentPatch(`${NOTES}/a.md`) };
    expect(parseAgentPatchBlock(JSON.stringify({ files: [good] }))).toHaveLength(1);
    const bad = [
      JSON.stringify({ files: [good, { path: 'rel', patch: agentPatch('/rel') }] }),
      JSON.stringify({ files: [good, { ...good }] }),
      JSON.stringify({ files: [good, { ...good, path: `${NOTES}/a.md/` }] }),
      JSON.stringify({ files: [] }),
      JSON.stringify({ files: [good], extra: 1 }),
      JSON.stringify([good]),
      JSON.stringify({
        files: Array.from({ length: 301 }, (_, i) => ({
          path: `${NOTES}/f${i}.md`,
          patch: agentPatch(`${NOTES}/f${i}.md`),
        })),
      }),
      JSON.stringify({
        files: Array.from({ length: 10 }, (_, i) => ({
          path: `${NOTES}/big${i}.md`,
          patch: newFilePatch(`${NOTES}/big${i}.md`, ['y'.repeat(250 * 1024)]),
        })),
      }),
      '{"files":[',
    ];
    for (const text of bad) expect(() => parseAgentPatchBlock(text)).toThrow(AgentPatchError);
  });

  it('sensitive policy keeps the agent task directory but no hidden component below it', () => {
    expect(isSensitivePath('/Users/dev/.omniAgent/garbage/t1/worktrees/app/src/a.ts')).toBe(false);
    expect(isSensitivePath('/Users/dev/.omniAgent/garbage/t1/worktrees/app/.config/x')).toBe(true);
    expect(isSensitivePath('/Users/dev/.zshrc')).toBe(true);
    expect(isSensitivePath('/tmp/repo/.git/config')).toBe(true);
    expect(isSensitivePath('/tmp/repo/key.pem')).toBe(true);
    expect(isSensitivePath('/tmp/repo/.github/workflows/ci.yml')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Final-answer protocol parsing
// ---------------------------------------------------------------------------

describe('final answer protocol parsing', () => {
  const FILE = `${NOTES}/todo.md`;
  const entry = { path: FILE, patch: agentPatch(FILE) };

  it('strips the marker and block from the final body and returns validated files', () => {
    const content = `<final_answer>\nDone.\n${report([entry])}\n</final_answer>`;
    const { display, report: r } = parseAgentFinal(content);
    expect(display).toBe('<final_answer>\nDone.\n</final_answer>');
    expect(r?.files?.map((f) => f.path)).toEqual([FILE]);
    expect(display).not.toContain(AGENT_LINE);
  });

  it('accepts a pretty-printed multi-line block and strips legacy changed_files', () => {
    const block = JSON.stringify({ files: [entry] }, null, 2);
    const content = `<final_answer>\nDone.\n[files_changed]\n<changed_files>["${FILE}"]</changed_files>\n<file_patches>\n${block}\n</file_patches>\n</final_answer>`;
    const parsed = parseAgentFinal(content);
    expect(parsed.display).toBe('<final_answer>\nDone.\n</final_answer>');
    expect(parsed.report?.files).toHaveLength(1);
  });

  it.each([
    ['fenced', `Example:\n\`\`\`\n${report([entry])}\n\`\`\``],
    ['inline', 'Add [files_changed] at the end.'],
    ['quoted', `> [files_changed]`],
    ['indented code', '    [files_changed]'],
  ])('%s protocol text is ignored and kept', (_label, body) => {
    const content = `<final_answer>\n${body}\n</final_answer>`;
    expect(parseAgentFinal(content)).toEqual({ display: content });
  });

  it('protocol lines outside the final body are ignored', () => {
    const content = `${report([entry])}\n<final_answer>\nDone.\n</final_answer>`;
    expect(parseAgentFinal(content).report).toBeUndefined();
  });

  it('marker only (no patches) is stripped and yields no files', () => {
    const r = parseAgentFinal('<final_answer>\nDone.\n[files_changed]\n</final_answer>');
    expect(r).toEqual({ display: '<final_answer>\nDone.\n</final_answer>', report: {} });
  });

  it.each([
    [
      'without marker',
      `<final_answer>\nDone.\n${report([entry], { marker: false })}\n</final_answer>`,
    ],
    [
      'malformed JSON',
      '<final_answer>\nDone.\n[files_changed]\n<file_patches>{"files":[}</file_patches>\n</final_answer>',
    ],
    [
      'trailing text after close',
      `<final_answer>\nDone.\n${report([entry])} trailing\n</final_answer>`,
    ],
    [
      'two blocks',
      `<final_answer>\nDone.\n${report([entry])}\n${report([entry], { marker: false })}\n</final_answer>`,
    ],
    [
      'one bad entry',
      `<final_answer>\nDone.\n${report([entry, { path: '/Users/dev/.ssh/id_rsa', patch: agentPatch('/Users/dev/.ssh/id_rsa') }])}\n</final_answer>`,
    ],
  ])('a rejected block (%s) is stripped and yields no files', (_label, content) => {
    const r = parseAgentFinal(content);
    expect(r.display).toBe('<final_answer>\nDone.\n</final_answer>');
    expect(r.report?.files).toBeUndefined();
    expect(r.report?.rejected).toBeTruthy();
    expect(r.display).not.toContain(AGENT_LINE);
  });

  it('a truncated (unclosed) block strips the rest of the body; nothing leaks', () => {
    const content = `<final_answer>\nDone.\n[files_changed]\n<file_patches>{"files":[{"path":"${FILE}","patch":"diff --git a/todo.md b/todo.md\\n+${AGENT_LINE}\n</final_answer>`;
    const r = parseAgentFinal(content);
    expect(r.display).toBe('<final_answer>\nDone.\n</final_answer>');
    expect(r.report?.rejected).toBe('malformed or truncated block');
  });

  it('the instruction is only added to a request copy of an agent-patch run, once', () => {
    const history = [
      { role: 'system' as const, content: 's' },
      { role: 'user' as const, content: '<user_input>\nhi\n</user_input>' },
      { role: 'assistant' as const, content: '' },
      { role: 'tool' as const, content: 'out', tool_call_id: 'c1' },
    ];
    const snapshot = JSON.stringify(history);
    const off = createGitRunState({ sessionId: 's', subscriptionId: 'x', send: () => undefined });
    expect(withAgentPatchInstruction(history, off)).toBe(history);
    expect(withAgentPatchInstruction(history, undefined)).toBe(history);
    const on = createGitRunState({
      sessionId: 's',
      subscriptionId: 'x',
      send: () => undefined,
      agentPatches: true,
    });
    const out = withAgentPatchInstruction(history, on);
    expect(out[1].content).toBe(`<user_input>\nhi\n</user_input>\n\n${AGENT_PATCH_INSTRUCTION}`);
    expect(withAgentPatchInstruction(out, on)).toBe(out);
    expect(JSON.stringify(history)).toBe(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Merge rules
// ---------------------------------------------------------------------------

describe('Git + agent merge', () => {
  it.each([
    ['/private/tmp/repo', '/tmp/repo/a.txt'],
    ['/tmp/repo', '/private/tmp/repo/a.txt'],
  ])('canonicalizes root %s and agent path %s before rendering', (root, path) => {
    const result = agentRepositories(
      parseAgentPatchBlock(JSON.stringify({ files: [{ path, patch: agentPatch(path) }] })),
      [],
      [root],
    );
    expect(result?.repositories[0].patch).toContain('diff --git a/a.txt b/a.txt');
  });

  it('Git file sections (incl. rename sides and quoted names) are never replaced', () => {
    const git = [
      {
        root: ROOT,
        scope: 'turn' as const,
        patch:
          gitPatch('src/a.ts') +
          'diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n' +
          'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"\n--- "a/caf\\303\\251.md"\n+++ "b/caf\\303\\251.md"\n@@ -1 +1 @@\n-a\n+b\n',
      },
    ];
    const covered = patchCoveredPaths(ROOT, git[0].patch);
    expect(covered.has(`${ROOT}/café.md`)).toBe(true);
    const files = parseAgentPatchBlock(
      JSON.stringify({
        files: [
          { path: `${ROOT}/src/a.ts`, patch: gitPatch('src/a.ts', 'agent') },
          { path: `${ROOT}/old.ts`, patch: agentPatch(`${ROOT}/old.ts`) },
          { path: `${ROOT}/café.md`, patch: agentPatch(`${ROOT}/café.md`) },
          { path: `${ROOT}/dist/ignored.js`, patch: agentPatch(`${ROOT}/dist/ignored.js`) },
          { path: `${NOTES}/n.md`, patch: agentPatch(`${NOTES}/n.md`) },
        ],
      }),
    );
    const merged = agentRepositories(files, git, [])!;
    expect(merged.duplicates).toBe(3);
    expect(merged.repositories.map((r) => [r.root, r.reconstructed])).toEqual([
      [ROOT, true],
      [NOTES, true],
    ]);
    // Ignored file inside the Git root is allowed, rendered root-relative.
    expect(merged.repositories[0].patch).toContain(
      'diff --git a/dist/ignored.js b/dist/ignored.js',
    );
  });

  it('collapses loose roots past the repository cap, or rejects the agent batch', () => {
    const files = parseAgentPatchBlock(
      JSON.stringify({
        files: Array.from({ length: 12 }, (_, i) => ({
          path: `/Users/dev/d${i}/f.md`,
          patch: agentPatch(`/Users/dev/d${i}/f.md`),
        })),
      }),
    );
    const merged = agentRepositories(files, [], [])!;
    expect(merged.repositories).toHaveLength(1);
    expect(merged.repositories[0].root).toBe('/Users/dev');
    const spread = parseAgentPatchBlock(
      JSON.stringify({
        files: Array.from({ length: 12 }, (_, i) => ({
          path: `/v${i}/f.md`,
          patch: agentPatch(`/v${i}/f.md`),
        })),
      }),
    );
    expect(agentRepositories(spread, [], [])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end agent turns
// ---------------------------------------------------------------------------

describe('agent patches in a real agent turn', () => {
  const shellThenFinal = (final: string) =>
    queueResults(
      toolCalls([{ id: 'c1', name: 'shell_script', arguments: { script: `cd ${ROOT} && make` } }]),
      finalAnswer(final),
    );

  it('no Git + valid agent patch: stripped final, labelled viewer, zero extra model calls', async () => {
    const file = `${NOTES}/todo.md`;
    shellThenFinal(`Updated notes.\n${report([{ path: file, patch: agentPatch(file) }])}`);
    const t = await turn('ap-nogit', 'update my notes', {});
    expect(mocks.complete).toHaveBeenCalledTimes(2); // shell turn + final only
    expect(t.final!.content).toBe('<final_answer>\nUpdated notes.\n</final_answer>');
    const summary = t.final!.session_diff!;
    expect(summary).toMatchObject({
      fileCount: 1,
      repositoryCount: 1,
      recovered: true,
      recoveryIncomplete: false,
      recoveryUncertain: true,
      recoveryMethod: 'ai_reconstructed',
    });
    expect(cleanSessionDiffSummary(summary)).toEqual(summary);
    const payload = await payloadOf(summary.id);
    expect(payload.recovery).toMatchObject({
      kind: 'agent_patch',
      complete: false,
      reportSource: 'agent_final',
    });
    expect(payload.repositories).toEqual([
      expect.objectContaining({ root: NOTES, scope: 'working_tree', reconstructed: true }),
    ]);
    const res = await view('ap-nogit', summary.id);
    expect(res.status).toBe(200);
    expect(res.body.html).toContain('Turn changes with AI-generated patches');
    expect(res.body.html).toContain('AI-generated patch (agent reported, unverified)');
    expect(res.body.html).toContain('not verified');
    expect((await view('ap-nogit', summary.id, 'sub-b')).status).toBe(404);
    // Every provider request carried the instruction on the request copy only.
    for (const messages of modelRequests()) {
      expect(JSON.stringify(messages)).toContain('omnikey_diff_report_instruction');
    }
    // The stored history never carries the instruction or the patch text.
    queueResults(finalAnswer('hello again'));
    await turn('ap-nogit', 'thanks', {});
    const next = JSON.stringify(modelRequests().at(-1));
    expect(next).not.toContain(AGENT_LINE);
    expect(next.match(/omnikey_diff_report_instruction>/g)?.length).toBe(2); // one open + close
  });

  it('mixed Git + agent: Git file wins, uncovered agent file added, counts are distinct roots', async () => {
    const notes = `${NOTES}/plan.md`;
    shellThenFinal(
      `Done.\n${report([
        { path: `${ROOT}/src/a.ts`, patch: gitPatch('src/a.ts', 'AGENT_VERSION') },
        { path: `${ROOT}/build/gen.ts`, patch: newFilePatch(`${ROOT}/build/gen.ts`, ['gen']) },
        { path: notes, patch: agentPatch(notes) },
      ])}`,
    );
    const t = await turn(`mix-${Date.now()}`, `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: turnFinal({ [ROOT]: gitPatch('src/a.ts', 'GIT_VERSION') }),
    });
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    const summary = t.final!.session_diff!;
    expect(summary).toMatchObject({
      fileCount: 3,
      repositoryCount: 2,
      recovered: true,
      scope: 'mixed',
    });
    const payload = await payloadOf(summary.id);
    const all = payload.repositories.map((r: any) => r.patch).join('');
    expect(all).toContain('GIT_VERSION');
    expect(all).not.toContain('AGENT_VERSION');
    expect(payload.repositories[0]).toMatchObject({ root: ROOT, scope: 'turn' });
    expect(payload.repositories[0].reconstructed).toBeUndefined();
    expect(payload.repositories.slice(1).map((r: any) => [r.root, r.reconstructed])).toEqual([
      [ROOT, true],
      [NOTES, true],
    ]);
    expect(payload.baselines).toHaveLength(1);
    const res = await view(t.final!.session_id, summary.id);
    expect(res.status).toBe(200);
    expect(res.body.html).toContain('Turn changes with AI-generated patches');
    expect(res.body.html).toContain('+ working tree');
  });

  it('complete Git + duplicate-only agent patch: plain Git snapshot, no second model call', async () => {
    shellThenFinal(
      `Done.\n${report([{ path: `${ROOT}/src/a.ts`, patch: gitPatch('src/a.ts', 'dup') }])}`,
    );
    const t = await turn('ap-dup', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: turnFinal({ [ROOT]: gitPatch('src/a.ts', 'GIT') }),
    });
    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(t.final!.content).toBe('<final_answer>\nDone.\n</final_answer>');
    expect(t.final!.session_diff).toMatchObject({ scope: 'turn', fileCount: 1 });
    expect(t.final!.session_diff!.recovered).toBeUndefined();
    const res = await view('ap-dup', t.final!.session_diff!.id);
    expect(res.body.html).toContain('Turn changes');
    expect(res.body.html).not.toContain('AI-generated');
  });

  it('multiple roots: a baseline-less root is omitted from Git and the agent fills it', async () => {
    const libFile = `${OTHER}/index.ts`;
    shellThenFinal(`Done.\n${report([{ path: libFile, patch: agentPatch(libFile) }])}`);
    const t = await turn(`roots-${Date.now()}`, `Fix ${ROOT} and ${OTHER}`, {
      heads: { [ROOT]: OID_1 },
      final: turnFinal({ [ROOT]: gitPatch('src/a.ts') }, [
        { root: OTHER, patch: gitPatch('unattributed.ts', 'OLD_WORK'), scope: 'working_tree' },
      ]),
    });
    const summary = t.final!.session_diff!;
    expect(summary).toMatchObject({ fileCount: 2, repositoryCount: 2, baselineUnavailable: false });
    const payload = await payloadOf(summary.id);
    const all = payload.repositories.map((r: any) => r.patch).join('');
    expect(all).not.toContain('OLD_WORK');
    expect(payload.repositories[1]).toMatchObject({ root: OTHER, reconstructed: true });
    expect(payload.notice).toContain(`Turn baseline unavailable for ${OTHER}`);
  });

  it('a baseline-less root alone (no agent patch) keeps only verified turn roots', async () => {
    queueResults(finalAnswer('Done.'));
    const t = await turn(`bl-${Date.now()}`, `Fix ${ROOT} and ${OTHER}`, {
      heads: { [ROOT]: OID_1 },
      final: turnFinal({ [ROOT]: gitPatch('src/a.ts') }, [
        { root: OTHER, patch: gitPatch('unattributed.ts'), scope: 'working_tree' },
      ]),
    });
    expect(t.final!.session_diff).toMatchObject({
      scope: 'turn',
      fileCount: 1,
      repositoryCount: 1,
    });
  });

  it.each([
    ['malformed hunk', (f: string) => agentPatch(f).replace('@@ -1,2 +1,2 @@', '@@ -1,9 +1,2 @@')],
    ['path traversal', () => agentPatch('/etc/passwd')],
  ])('%s: whole batch rejected, block stripped, nothing invented', async (_label, make) => {
    const file = `${NOTES}/x.md`;
    const path = _label === 'path traversal' ? `${NOTES}/../../etc/passwd` : file;
    shellThenFinal(`Done.\n${report([{ path, patch: make(file) }])}`);
    const id = `bad-${_label.replace(/\s/g, '')}`;
    const t = await turn(id, 'edit', {});
    expect(t.final!.content).toBe('<final_answer>\nDone.\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(await AgentSessionDiff.count({ where: { sessionId: id } })).toBe(0);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it('a sensitive path or oversize batch is rejected; Git still attaches', async () => {
    shellThenFinal(
      `Done.\n${report([
        { path: `${NOTES}/ok.md`, patch: agentPatch(`${NOTES}/ok.md`) },
        { path: `${ROOT}/.env`, patch: agentPatch(`${ROOT}/.env`) },
      ])}`,
    );
    const t = await turn('ap-sensitive', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: turnFinal({ [ROOT]: gitPatch('src/a.ts') }),
    });
    expect(t.final!.content).toBe('<final_answer>\nDone.\n</final_answer>');
    expect(t.final!.session_diff).toMatchObject({ scope: 'turn', fileCount: 1 });
    expect(t.final!.session_diff!.recovered).toBeUndefined();
  });

  it('no files changed: no protocol lines, no snapshot, normal model calls only', async () => {
    queueResults(finalAnswer('Just an answer.'));
    const t = await turn('ap-none', 'what is 2+2', {});
    expect(t.final!.content).toBe('<final_answer>\nJust an answer.\n</final_answer>');
    expect(t.final!.session_diff).toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });

  it('capability absent (old client or legacy recovery flag only): no instruction, nothing parsed', async () => {
    const file = `${NOTES}/todo.md`;
    for (const [id, capability] of [
      ['ap-old', { turn: true }],
      ['ap-legacy', { turn: true, recovery: true }],
    ] as const) {
      vi.clearAllMocks();
      queueResults(finalAnswer(`Done.\n${report([{ path: file, patch: agentPatch(file) }])}`));
      const t = await turn(id, 'edit', {}, capability);
      expect(JSON.stringify(modelRequests())).not.toContain('omnikey_diff_report_instruction');
      expect(t.final!.session_diff).toBeUndefined();
      expect(t.final!.content).toContain('[files_changed]'); // not this run's protocol
      expect(mocks.complete).toHaveBeenCalledTimes(1);
    }
  });

  it('diff view setting off: no Git work, no instruction, no collection', async () => {
    const settings = vi.mocked(getAgentSettings);
    const original = settings.getMockImplementation()!;
    settings.mockImplementation(async () => ({ ...(await original()), diffViewEnabled: false }));
    try {
      const file = `${NOTES}/todo.md`;
      queueResults(finalAnswer(`Done.\n${report([{ path: file, patch: agentPatch(file) }])}`));
      const t = await turn('ap-off', `Fix ${ROOT}`, { heads: { [ROOT]: OID_1 } });
      expect(t.requests).toEqual([]);
      expect(JSON.stringify(modelRequests())).not.toContain('omnikey_diff_report_instruction');
      expect(t.final!.session_diff).toBeUndefined();
      expect(await AgentSessionDiff.count({ where: { sessionId: 'ap-off' } })).toBe(0);
    } finally {
      settings.mockImplementation(original);
    }
  });

  it('error finals never parse agent patches but still capture Git', async () => {
    mocks.complete.mockRejectedValue(new Error('provider down'));
    const t = await turn('ap-err', `Fix ${ROOT}`, {
      heads: { [ROOT]: OID_1 },
      final: turnFinal({ [ROOT]: gitPatch('src/a.ts') }),
    });
    expect(t.final!.content).toContain('Agent failed to call language model');
    expect(t.final!.session_diff).toMatchObject({ scope: 'turn' });
  });
});

// ---------------------------------------------------------------------------
// Stored payloads: new agent_patch and every legacy recovered form
// ---------------------------------------------------------------------------

describe('stored snapshot serving', () => {
  const store = async (sessionId: string, id: string, payload: Record<string, unknown>) => {
    const { compressString } = await import('../compression');
    return AgentSessionDiff.create({
      id,
      sessionId,
      subscriptionId: 'sub-a',
      runId: 'grun_old',
      scope: 'working_tree',
      commitOid: null,
      fileCount: 1,
      repositoryCount: 1,
      payload: compressString(JSON.stringify({ version: 1, ...payload })),
    } as any);
  };
  const repo = { root: ROOT, patch: gitPatch('a.ts'), scope: 'working_tree' };

  it('agent_patch provenance is servable only in its exact form', () => {
    const recovery = {
      kind: 'agent_patch' as const,
      turnId: 't',
      evidenceIds: [],
      complete: false,
      limitations: [],
      reportSource: 'agent_final' as const,
    };
    const payload = (
      r: Record<string, unknown>,
      repositories: unknown[] = [{ ...repo, reconstructed: true }],
    ) => ({ version: 1, repositories, recovery: r }) as any;
    expect(isKnownPartialPayload(payload(recovery))).toBe(false);
    expect(isKnownPartialPayload(payload({ ...recovery, complete: true }))).toBe(true);
    expect(isKnownPartialPayload(payload({ ...recovery, reportSource: undefined }))).toBe(true);
    expect(isKnownPartialPayload(payload(recovery, [repo]))).toBe(true);
  });

  it('old verified/recovered/uncertain payloads still render; known-partial ones stay 409', async () => {
    await AgentSession.create({ id: 'legacy', subscriptionId: 'sub-a' } as any);
    const ai = {
      kind: 'ai_reconstructed',
      turnId: 'grun_old',
      evidenceIds: [],
      limitations: ['Legacy limitation line.'],
    };
    await store('legacy', 'sdiff_legacywt0001', { repositories: [repo] });
    await store('legacy', 'sdiff_legacychk001', {
      repositories: [repo],
      displayLimit: 300,
      recovery: {
        kind: 'agent_assisted',
        turnId: 'grun_old',
        evidenceIds: ['r1'],
        complete: true,
        limitations: [],
      },
    });
    await store('legacy', 'sdiff_legacyai0001', {
      repositories: [{ ...repo, reconstructed: true }],
      displayLimit: 300,
      recovery: { ...ai, complete: true },
    });
    await store('legacy', 'sdiff_legacyrep001', {
      repositories: [{ ...repo, reconstructed: true }],
      displayLimit: 300,
      recovery: {
        ...ai,
        complete: false,
        coverage: 'uncertain',
        reportSource: 'agent_final',
        uncertainty: ['baseline_unavailable'],
      },
    });
    await store('legacy', 'sdiff_legacyprt001', {
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
    await store('legacy', 'sdiff_legacynob001', {
      repositories: [repo],
      baselines: [],
      displayLimit: 300,
    });
    const expectations: Array<[string, number, string?]> = [
      ['sdiff_legacywt0001', 200, 'Working tree changes'],
      ['sdiff_legacychk001', 200, 'Recovered turn changes'],
      ['sdiff_legacyai0001', 200, 'AI-reconstructed turn changes'],
      ['sdiff_legacyrep001', 200, 'agent reported, not verified, not complete'],
      ['sdiff_legacyprt001', 409],
      ['sdiff_legacynob001', 409],
    ];
    for (const [id, status, text] of expectations) {
      const res = await view('legacy', id);
      expect(res.status, id).toBe(status);
      if (text) expect(res.body.html, id).toContain(text);
    }
    // Transcript replay hides only known-partial summaries.
    const summary = (id: string, extra: Record<string, unknown> = {}) => ({
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
          session_diff: summary('sdiff_legacyprt001', {
            recovered: true,
            recoveryIncomplete: true,
          }),
        },
        { role: 'user', content: 'b' },
        {
          role: 'assistant',
          content: '<final_answer>\ntwo\n</final_answer>',
          session_diff: summary('sdiff_legacyrep001', {
            recovered: true,
            recoveryIncomplete: false,
            recoveryMethod: 'ai_reconstructed',
            recoveryUncertain: true,
          }),
        },
      ] as any),
    );
    expect(transcript).not.toContain('sdiff_legacyprt001');
    expect(transcript).toContain('sdiff_legacyrep001');
  }, 60_000);
});
