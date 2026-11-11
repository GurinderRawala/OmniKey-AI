import { execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
  INSTRUCTIONS_INPUT_MAX_BYTES,
  createDefaultTransport,
  createHttpTransport,
  runSkillsCli,
  type Prompter,
  type SkillsDeps,
} from '../skills';

// The disposable-backend smoke test loads the real API Skills router. Replace
// the API's shared db module so nothing can open the application database.
vi.mock('../../../api/src/db', async () => {
  const { Sequelize } = await import('sequelize');
  return { sequelize: new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false }) };
});

const LICENSE = 'LICENSE-KEY-do-not-print-7f3a';
const SECRET = 'SECRET-INSTRUCTION-BODY-c41e';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-cli-skills-'));
const allStderr: string[] = [];

// ── Fake backend (ephemeral loopback port, closed in afterAll) ─────────────

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}
interface FakeSkill {
  id: string;
  name: string;
  keyword: string;
  instructions: string;
  enabled: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
type Override = (
  req: Recorded,
) => { status: number; body?: unknown; raw?: string; delayMs?: number } | undefined;

const fake = {
  server: undefined as http.Server | undefined,
  baseUrl: '',
  requests: [] as Recorded[],
  skills: new Map<string, FakeSkill>(),
  tokens: new Set<string>(),
  issued: 0,
  nextId: 1,
  override: undefined as Override | undefined,
  activation: undefined as { status: number; body: unknown } | undefined,
};

const TS = '2026-11-11T00:00:00.000Z';
const summary = ({ instructions: _omit, ...rest }: FakeSkill) => rest;
const err = (code: string, message: string, fields?: Record<string, string>) => ({
  error: { code, message, ...(fields ? { fields } : {}) },
});

function seed(partial: Partial<FakeSkill> = {}): FakeSkill {
  const id = partial.id ?? `cskill${fake.nextId++}`;
  const skill: FakeSkill = {
    id,
    name: 'Review',
    keyword: 'code review',
    instructions: `${SECRET} check edge cases.`,
    enabled: true,
    revision: 1,
    createdAt: TS,
    updatedAt: TS,
    ...partial,
  };
  fake.skills.set(id, skill);
  return skill;
}

function route(req: Recorded): { status: number; body?: unknown } {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/subscription/activate') {
    if (fake.activation) return fake.activation;
    const token = `tok-${++fake.issued}`;
    fake.tokens.add(token);
    return { status: 200, body: { token, subscriptionStatus: 'active' } };
  }
  if (!url.pathname.startsWith('/api/skills')) return { status: 404, body: 'Not found' };
  const auth = String(req.headers.authorization ?? '');
  if (!auth.startsWith('Bearer ') || !fake.tokens.has(auth.slice(7))) {
    return { status: 401, body: { error: 'Invalid or expired token.' } };
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (url.pathname === '/api/skills' && req.method === 'GET') {
    const skills = [...fake.skills.values()].map(summary);
    return { status: 200, body: { skills } };
  }
  if (url.pathname === '/api/skills' && req.method === 'POST') {
    for (const k of ['name', 'keyword', 'instructions']) {
      if (typeof body[k] !== 'string' || !(body[k] as string).trim()) {
        return {
          status: 400,
          body: err('VALIDATION_ERROR', 'Invalid skill.', { [k]: 'Required.' }),
        };
      }
    }
    const kw = (body.keyword as string).toLowerCase();
    if ([...fake.skills.values()].some((s) => s.keyword.toLowerCase() === kw)) {
      return { status: 409, body: err('KEYWORD_CONFLICT', 'Keyword already used.') };
    }
    const skill = seed({
      name: body.name as string,
      keyword: body.keyword as string,
      instructions: body.instructions as string,
      enabled: body.enabled !== false,
    });
    return { status: 201, body: { skill } };
  }
  if (url.pathname === '/api/skills/match' && req.method === 'POST') {
    const text = String(body.text ?? '').toLowerCase();
    const matches = [...fake.skills.values()]
      .filter((s) => s.enabled && text.includes(s.keyword.toLowerCase()))
      .map(({ id, name, keyword, revision }) => ({ id, name, keyword, revision }));
    return { status: 200, body: { matches, warnings: [] } };
  }
  const id = decodeURIComponent(url.pathname.slice('/api/skills/'.length));
  const skill = fake.skills.get(id);
  if (!skill) return { status: 404, body: err('NOT_FOUND', 'Skill not found.') };
  if (req.method === 'GET') return { status: 200, body: { skill } };
  const ifMatch = req.headers['if-match'];
  if (ifMatch === undefined) {
    return { status: 428, body: err('REVISION_REQUIRED', 'A revision is required.') };
  }
  if (ifMatch !== `"${skill.revision}"`) {
    return {
      status: 409,
      body: err('REVISION_CONFLICT', 'Skill changed. Reload before retrying.'),
    };
  }
  if (req.method === 'DELETE') {
    fake.skills.delete(id);
    return { status: 204 };
  }
  if (req.method === 'PATCH') {
    Object.assign(skill, body, { revision: skill.revision + 1 });
    return { status: 200, body: { skill } };
  }
  return { status: 404, body: err('NOT_FOUND', 'Not found.') };
}

async function startFake(): Promise<void> {
  fake.server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const rec: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      fake.requests.push(rec);
      const o = fake.override?.(rec);
      const r = o ?? route(rec);
      const send = () => {
        if (res.destroyed) return;
        if (o?.raw !== undefined) {
          res.writeHead(r.status, { 'Content-Type': 'text/html' }).end(o.raw);
        } else if (r.body === undefined) {
          res.writeHead(r.status).end();
        } else {
          res.writeHead(r.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r.body));
        }
      };
      if (o?.delayMs) setTimeout(send, o.delayMs).unref();
      else send();
    });
  });
  await new Promise<void>((resolve) => fake.server!.listen(0, '127.0.0.1', resolve));
  fake.baseUrl = `http://127.0.0.1:${(fake.server!.address() as AddressInfo).port}`;
}

// ── Harness ────────────────────────────────────────────────────────────────

type Answer = { kind: 'text' | 'editor' | 'confirm'; value: string | boolean | Error };

interface Harness {
  out: string;
  err: string;
  code: number;
  prompts: string[];
  exitCodes: number[];
}

async function cli(
  argv: string[],
  opts: {
    interactive?: boolean;
    stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
    answers?: Answer[];
    timeoutMs?: number;
    baseUrl?: string;
    stdinTimeoutMs?: number;
  } = {},
): Promise<Harness> {
  const h: Harness = { out: '', err: '', code: -1, prompts: [], exitCodes: [] };
  const answers = [...(opts.answers ?? [])];
  const next = (kind: Answer['kind'], message: string) => {
    h.prompts.push(message);
    const a = answers.shift();
    if (!a || a.kind !== kind) throw new Error(`unexpected ${kind} prompt: ${message}`);
    if (a.value instanceof Error) throw a.value;
    return a.value;
  };
  const prompter: Prompter = {
    text: async (m) => String(next('text', m)),
    editor: async (m) => String(next('editor', m)),
    confirm: async (m) => Boolean(next('confirm', m)),
  };
  const stdin = opts.stdin ?? Object.assign(new PassThrough(), { isTTY: false });
  const deps: SkillsDeps = {
    io: {
      stdout: (s) => (h.out += s),
      stderr: (s) => (h.err += s),
      stdin,
      interactive: !!opts.interactive,
      prompter: () => prompter,
    },
    transport: () =>
      createHttpTransport({
        baseUrl: opts.baseUrl ?? fake.baseUrl,
        licenseKey: LICENSE,
        timeoutMs: opts.timeoutMs ?? 5_000,
        activationTimeoutMs: opts.timeoutMs ?? 5_000,
      }),
    setExitCode: (c) => h.exitCodes.push(c),
    stdinTimeoutMs: opts.stdinTimeoutMs,
  };
  h.code = await runSkillsCli(argv, deps);
  allStderr.push(h.err);
  expect(answers).toEqual([]); // every scripted answer was consumed
  return h;
}

const skillRequests = () => fake.requests.filter((r) => r.url.startsWith('/api/skills'));
const writeTmp = (name: string, content: string | Buffer) => {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content);
  return p;
};
const stdinOf = (text: string) => {
  const s = Object.assign(new PassThrough(), { isTTY: false });
  s.end(text);
  return s;
};
const parseJsonStdout = (h: Harness) => JSON.parse(h.out);
const jsonError = (h: Harness) => JSON.parse(h.err.trim()).error;

let exitSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await startFake();
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code}) called`);
  }) as never);
});

afterAll(async () => {
  exitSpy.mockRestore();
  await new Promise<void>((resolve) => fake.server?.close(() => resolve()) ?? resolve());
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const stderr = allStderr.join('\n');
  expect(stderr).not.toContain(LICENSE);
  expect(stderr).not.toContain(SECRET);
  expect(stderr).not.toMatch(/tok-\d+/);
  expect(stderr).not.toMatch(/at .*\.ts:\d+/); // no stack traces
});

beforeEach(() => {
  fake.requests = [];
  fake.skills.clear();
  fake.override = undefined;
  fake.activation = undefined;
});

afterEach(() => {
  expect(exitSpy).not.toHaveBeenCalled();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('command parsing and help', () => {
  it('shows help for skills and every subcommand with exit 0 and no HTTP', async () => {
    const h = await cli(['skills', '--help']);
    expect(h.code).toBe(EXIT_OK);
    for (const sub of ['list', 'show', 'add', 'edit', 'enable', 'disable', 'delete', 'match']) {
      expect(h.out).toContain(sub);
      const sh = await cli(['skills', sub, '--help']);
      expect(sh.code).toBe(EXIT_OK);
      expect(sh.out).toContain('Usage:');
    }
    expect((await cli(['skills', 'match', '--help'])).out).toMatch(
      /Does not\s+send it to the agent/,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('maps commander usage errors to exit 2', async () => {
    for (const argv of [
      ['skills'],
      ['skills', 'bogus'],
      ['skills', 'delete', 'id1', 'id2', '--yes'],
      ['skills', 'show', 'a', 'b'],
      ['skills', 'show'],
      ['skills', 'list', '--bogus'],
      ['skills', 'add', '--name'],
    ]) {
      const h = await cli(argv);
      expect(h.code, argv.join(' ')).toBe(EXIT_USAGE);
      expect(h.out).toBe('');
    }
    expect(fake.requests).toHaveLength(0);
  });
});

describe('list / show', () => {
  it('lists skills as a table and as the exact API envelope with clean stdout', async () => {
    seed({ id: 'a1', name: 'SQL', keyword: 'sql' });
    seed({ id: 'b2', name: 'Docs', keyword: 'docs', enabled: false, revision: 3 });
    const h = await cli(['skills', 'list']);
    expect(h.code).toBe(EXIT_OK);
    expect(h.out).toMatch(/a1\s+yes\s+1\s+SQL {2}\[sql\]/);
    expect(h.out).toMatch(/b2\s+no\s+3\s+Docs {2}\[docs\]/);
    expect(h.out).not.toContain(SECRET);

    const j = await cli(['skills', 'list', '--json']);
    expect(j.code).toBe(EXIT_OK);
    expect(j.err).toBe('');
    expect(parseJsonStdout(j)).toEqual({
      skills: [...fake.skills.values()].map(summary),
    });
    const auth = skillRequests()[0].headers.authorization;
    expect(auth).toMatch(/^Bearer tok-\d+$/);
  });

  it('reports an empty collection', async () => {
    const h = await cli(['skills', 'list']);
    expect(h.code).toBe(EXIT_OK);
    expect(h.out).toContain('No skills yet');
  });

  it('treats a list 404 as an old backend without echoing the body', async () => {
    fake.override = (r) =>
      r.url === '/api/skills'
        ? { status: 404, raw: '<html>Cannot GET /api/skills</html>' }
        : undefined;
    const h = await cli(['skills', 'list', '--json']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(h.out).toBe('');
    expect(jsonError(h)).toMatchObject({ code: 'BACKEND_UNSUPPORTED', status: 404 });
    expect(h.err).not.toContain('html');
  });

  it('shows a skill with instructions, and JSON equal to the envelope', async () => {
    const s = seed({ id: 'id/with space' });
    const h = await cli(['skills', 'show', 'id/with space']);
    expect(h.code).toBe(EXIT_OK);
    expect(h.out).toContain('Keyword:   code review');
    expect(h.out).toContain(`${SECRET} check edge cases.`);
    expect(skillRequests()[0].url).toBe('/api/skills/id%2Fwith%20space');

    const j = await cli(['skills', 'show', s.id, '--json']);
    expect(parseJsonStdout(j)).toEqual({ skill: s });
    expect(j.err).toBe('');
  });

  it('fails with exit 1 for a missing skill', async () => {
    const h = await cli(['skills', 'show', 'nope']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(h.err).toContain('Skill not found.');
    expect(h.out).toBe('');
  });

  it('rejects malformed success responses', async () => {
    fake.override = (r) =>
      r.url === '/api/skills' ? { status: 200, body: { skills: [{}] } } : undefined;
    const h = await cli(['skills', 'list', '--json']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(jsonError(h).code).toBe('BAD_RESPONSE');
    expect(h.out).toBe('');
  });
});

describe('add', () => {
  it('creates from flags and an instructions file', async () => {
    const file = writeTmp('review.md', `${SECRET}\nline two\n`);
    const h = await cli([
      'skills',
      'add',
      '--name',
      ' SQL review ',
      '--keyword',
      'sql review',
      '--instructions-file',
      file,
    ]);
    expect(h.code).toBe(EXIT_OK);
    expect(h.out).toContain('Skill created.');
    expect(h.out).not.toContain(SECRET);
    const post = skillRequests().find((r) => r.method === 'POST')!;
    expect(post.url).toBe('/api/skills');
    expect(post.body).toEqual({
      name: 'SQL review',
      keyword: 'sql review',
      instructions: `${SECRET}\nline two\n`,
      enabled: true,
    });
  });

  it('creates disabled from stdin with JSON output', async () => {
    const h = await cli(
      [
        'skills',
        'add',
        '--name',
        'N',
        '--keyword',
        'k',
        '--instructions-file',
        '-',
        '--disabled',
        '--json',
      ],
      { stdin: stdinOf('from stdin') },
    );
    expect(h.code).toBe(EXIT_OK);
    expect(h.err).toBe('');
    const body = parseJsonStdout(h);
    expect(body.skill).toMatchObject({
      name: 'N',
      keyword: 'k',
      enabled: false,
      instructions: 'from stdin',
    });
    expect(Object.keys(body)).toEqual(['skill']);
  });

  it('requires all fields when not interactive and sends nothing', async () => {
    const h = await cli(['skills', 'add', '--name', 'N']);
    expect(h.code).toBe(EXIT_USAGE);
    expect(h.err).toContain('--keyword, --instructions-file');
    expect(fake.requests).toHaveLength(0);
    expect(
      (await cli(['skills', 'add', '--name', ' ', '--keyword', 'k', '--instructions-file', '-']))
        .code,
    ).toBe(EXIT_USAGE);
  });

  it('prompts for missing fields on a terminal', async () => {
    const h = await cli(['skills', 'add'], {
      interactive: true,
      answers: [
        { kind: 'text', value: '' }, // blank name re-prompts
        { kind: 'text', value: 'Prompted' },
        { kind: 'text', value: 'prompted kw' },
        { kind: 'editor', value: 'Edited instructions' },
      ],
    });
    expect(h.code).toBe(EXIT_OK);
    expect(h.prompts).toHaveLength(4);
    expect(skillRequests().find((r) => r.method === 'POST')!.body).toEqual({
      name: 'Prompted',
      keyword: 'prompted kw',
      instructions: 'Edited instructions',
      enabled: true,
    });
  });

  it('treats a cancelled prompt as failure without sending', async () => {
    const h = await cli(['skills', 'add', '--name', 'N'], {
      interactive: true,
      answers: [{ kind: 'text', value: new Error('User force closed the prompt') }],
    });
    expect(h.code).toBe(EXIT_FAILURE);
    expect(h.err).toContain('Cancelled.');
    expect(fake.requests).toHaveLength(0);
  });

  it('reports prompt initialization errors separately without leaking input or raw errors', async () => {
    const h = await cli(['skills', 'add', '--name', 'N', '--json'], {
      interactive: true,
      answers: [{ kind: 'text', value: new Error('editor load failed SECRET-PROMPT-INPUT') }],
    });
    expect(h.code).toBe(EXIT_FAILURE);
    expect(h.err).toContain('PROMPT_ERROR');
    expect(h.err).not.toContain('Cancelled');
    expect(h.err).not.toContain('SECRET-PROMPT-INPUT');
    expect(h.out).toBe('');
    expect(fake.requests).toHaveLength(0);
  });

  it('refuses to read stdin from a terminal', async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    const h = await cli(
      ['skills', 'add', '--name', 'N', '--keyword', 'k', '--instructions-file', '-'],
      {
        stdin: tty,
      },
    );
    expect(h.code).toBe(EXIT_USAGE);
    expect(fake.requests).toHaveLength(0);
  });

  it('bounds stdin by size and time', async () => {
    const big = stdinOf('x'.repeat(INSTRUCTIONS_INPUT_MAX_BYTES + 1));
    const h = await cli(
      ['skills', 'add', '--name', 'N', '--keyword', 'k', '--instructions-file', '-', '--json'],
      { stdin: big },
    );
    expect(h.code).toBe(EXIT_FAILURE);
    expect(jsonError(h).code).toBe('FILE_ERROR');

    const open = Object.assign(new PassThrough(), { isTTY: false });
    open.write('partial');
    const t = await cli(
      ['skills', 'add', '--name', 'N', '--keyword', 'k', '--instructions-file', '-'],
      {
        stdin: open,
        stdinTimeoutMs: 50,
      },
    );
    expect(t.code).toBe(EXIT_FAILURE);
    expect(t.err).toMatch(/not closed within/);
    expect(fake.requests).toHaveLength(0);
  });

  it('rejects missing, non-regular, oversized, non-UTF-8 and blank files', async () => {
    const fifo = path.join(tmpRoot, 'pipe');
    let hasFifo = false;
    try {
      execFileSync('mkfifo', [fifo]);
      hasFifo = true;
    } catch {
      /* mkfifo unavailable (e.g. Windows): skip that case */
    }
    const cases: [string, number, RegExp][] = [
      [path.join(tmpRoot, 'missing.md'), EXIT_FAILURE, /does not exist/],
      [tmpRoot, EXIT_FAILURE, /regular file/],
      [
        writeTmp('big.md', 'x'.repeat(INSTRUCTIONS_INPUT_MAX_BYTES + 1)),
        EXIT_FAILURE,
        /larger than/,
      ],
      [writeTmp('bad.md', Buffer.from([0xff, 0xfe, 0x41])), EXIT_FAILURE, /UTF-8/],
      [writeTmp('blank.md', '  \n\t'), EXIT_USAGE, /blank/],
      ...(hasFifo ? ([[fifo, EXIT_FAILURE, /regular file/]] as [string, number, RegExp][]) : []),
    ];
    for (const [file, code, msg] of cases) {
      const h = await cli([
        'skills',
        'add',
        '--name',
        'N',
        '--keyword',
        'k',
        '--instructions-file',
        file,
      ]);
      expect(h.code, file).toBe(code);
      expect(h.err).toMatch(msg);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it('strips a UTF-8 BOM from instruction files', async () => {
    const file = writeTmp(
      'bom.md',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Hi')]),
    );
    const h = await cli([
      'skills',
      'add',
      '--name',
      'N',
      '--keyword',
      'k',
      '--instructions-file',
      file,
    ]);
    expect(h.code).toBe(EXIT_OK);
    expect(
      (skillRequests().find((r) => r.method === 'POST')!.body as { instructions: string })
        .instructions,
    ).toBe('Hi');
  });

  it('exits 1 for server validation and keyword conflicts, with field details', async () => {
    const file = writeTmp('ok.md', 'body');
    fake.override = (r) =>
      r.method === 'POST' && r.url === '/api/skills'
        ? {
            status: 400,
            body: err('VALIDATION_ERROR', 'Invalid skill.', { keyword: 'Reserved keyword.' }),
          }
        : undefined;
    const v = await cli([
      'skills',
      'add',
      '--name',
      'N',
      '--keyword',
      '@omniagent',
      '--instructions-file',
      file,
    ]);
    expect(v.code).toBe(EXIT_FAILURE);
    expect(v.err).toContain('keyword: Reserved keyword.');

    fake.override = undefined;
    seed({ keyword: 'dup' });
    const c = await cli([
      'skills',
      'add',
      '--name',
      'N',
      '--keyword',
      'DUP',
      '--instructions-file',
      file,
      '--json',
    ]);
    expect(c.code).toBe(EXIT_FAILURE);
    expect(c.out).toBe('');
    expect(jsonError(c)).toMatchObject({ code: 'KEYWORD_CONFLICT', status: 409 });
  });
});

describe('edit', () => {
  it('fetches the revision and patches only provided fields with If-Match', async () => {
    const s = seed({ id: 'e1', revision: 4 });
    const file = writeTmp('new.md', 'New body');
    const h = await cli([
      'skills',
      'edit',
      'e1',
      '--keyword',
      'sql',
      '--instructions-file',
      file,
      '--json',
    ]);
    expect(h.code).toBe(EXIT_OK);
    const [get, patch] = skillRequests();
    expect(get).toMatchObject({ method: 'GET', url: '/api/skills/e1' });
    expect(patch).toMatchObject({
      method: 'PATCH',
      url: '/api/skills/e1',
      body: { keyword: 'sql', instructions: 'New body' },
    });
    expect(patch.headers['if-match']).toBe('"4"');
    expect(parseJsonStdout(h).skill).toMatchObject({ id: s.id, revision: 5, keyword: 'sql' });
  });

  it('reports stale revisions as conflicts (server 409 and --revision mismatch)', async () => {
    seed({ id: 'e2', revision: 2 });
    fake.override = (r) =>
      r.method === 'PATCH'
        ? { status: 409, body: err('REVISION_CONFLICT', 'Skill changed. Reload before retrying.') }
        : undefined;
    const h = await cli(['skills', 'edit', 'e2', '--name', 'X', '--json']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(h.out).toBe('');
    expect(jsonError(h)).toMatchObject({ code: 'REVISION_CONFLICT', status: 409 });

    fake.override = undefined;
    fake.requests = [];
    const m = await cli(['skills', 'edit', 'e2', '--name', 'X', '--revision', '1']);
    expect(m.code).toBe(EXIT_FAILURE);
    expect(m.err).toContain('current revision is 2');
    expect(skillRequests().some((r) => r.method === 'PATCH')).toBe(false);

    expect((await cli(['skills', 'edit', 'e2', '--name', 'X', '--revision', '01'])).code).toBe(
      EXIT_USAGE,
    );
  });

  it('requires a field when not interactive', async () => {
    seed({ id: 'e3' });
    const h = await cli(['skills', 'edit', 'e3']);
    expect(h.code).toBe(EXIT_USAGE);
    expect(fake.requests).toHaveLength(0);
  });

  it('edits interactively, sending only changed fields, and skips unchanged edits', async () => {
    seed({ id: 'e4', name: 'Old', keyword: 'kw' });
    const h = await cli(['skills', 'edit', 'e4'], {
      interactive: true,
      answers: [
        { kind: 'text', value: 'Old' },
        { kind: 'text', value: 'new kw' },
        { kind: 'confirm', value: true },
        { kind: 'editor', value: 'Changed' },
      ],
    });
    expect(h.code).toBe(EXIT_OK);
    const patch = skillRequests().find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ keyword: 'new kw', instructions: 'Changed' });
    expect(patch.headers['if-match']).toBe('"1"');

    fake.requests = [];
    const n = await cli(['skills', 'edit', 'e4'], {
      interactive: true,
      answers: [
        { kind: 'text', value: 'Old' },
        { kind: 'text', value: 'new kw' },
        { kind: 'confirm', value: false },
      ],
    });
    expect(n.code).toBe(EXIT_OK);
    expect(n.out).toContain('No changes.');
    expect(skillRequests().some((r) => r.method === 'PATCH')).toBe(false);
  });
});

describe('enable / disable', () => {
  it('toggles with If-Match and skips no-op changes', async () => {
    seed({ id: 't1', revision: 7 });
    const d = await cli(['skills', 'disable', 't1']);
    expect(d.code).toBe(EXIT_OK);
    expect(d.out).toContain('disabled (revision 8)');
    expect(d.out).toContain('use Stop');
    const patch = skillRequests().find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ enabled: false });
    expect(patch.headers['if-match']).toBe('"7"');

    fake.requests = [];
    const again = await cli(['skills', 'disable', 't1', '--json']);
    expect(again.code).toBe(EXIT_OK);
    expect(parseJsonStdout(again).skill.enabled).toBe(false);
    expect(skillRequests().some((r) => r.method === 'PATCH')).toBe(false);

    const e = await cli(['skills', 'enable', 't1', '--json']);
    expect(e.code).toBe(EXIT_OK);
    expect(parseJsonStdout(e).skill).toMatchObject({ enabled: true, revision: 9 });
  });

  it('uses an explicit --revision without fetching', async () => {
    seed({ id: 't2', revision: 3 });
    const h = await cli(['skills', 'disable', 't2', '--revision', '2']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(skillRequests().map((r) => r.method)).toEqual(['PATCH']);
    expect(h.err).toContain('Skill changed');
  });
});

describe('delete', () => {
  it('requires --yes when not interactive', async () => {
    seed({ id: 'd1' });
    const h = await cli(['skills', 'delete', 'd1']);
    expect(h.code).toBe(EXIT_USAGE);
    expect(fake.requests).toHaveLength(0);
  });

  it('deletes with --yes, If-Match and JSON {"deleted":true}; remove alias works', async () => {
    seed({ id: 'd2', revision: 5 });
    const h = await cli(['skills', 'delete', 'd2', '--yes', '--json']);
    expect(h.code).toBe(EXIT_OK);
    expect(h.out.trim()).toBe(JSON.stringify({ deleted: true }, null, 2));
    const del = skillRequests().find((r) => r.method === 'DELETE')!;
    expect(del.headers['if-match']).toBe('"5"');
    expect(fake.skills.has('d2')).toBe(false);

    seed({ id: 'd3' });
    const r = await cli(['skills', 'remove', 'd3', '-y']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.out).toContain('deleted');
    expect(fake.skills.has('d3')).toBe(false);
  });

  it('confirms interactively; declining sends no DELETE', async () => {
    seed({ id: 'd4', name: 'Keep me' });
    const no = await cli(['skills', 'delete', 'd4'], {
      interactive: true,
      answers: [{ kind: 'confirm', value: false }],
    });
    expect(no.code).toBe(EXIT_FAILURE);
    expect(no.prompts[0]).toContain('Keep me');
    expect(skillRequests().some((r) => r.method === 'DELETE')).toBe(false);

    const yes = await cli(['skills', 'delete', 'd4'], {
      interactive: true,
      answers: [{ kind: 'confirm', value: true }],
    });
    expect(yes.code).toBe(EXIT_OK);
    expect(fake.skills.has('d4')).toBe(false);
  });

  it('fails for a missing skill', async () => {
    const h = await cli(['skills', 'delete', 'gone', '--yes']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(skillRequests().some((r) => r.method === 'DELETE')).toBe(false);
  });
});

describe('match preview', () => {
  it('calls the backend matcher with the exact text and words the result honestly', async () => {
    seed({ id: 'm1', name: 'SQL review', keyword: 'sql review', revision: 2 });
    const h = await cli(['skills', 'match', '--text', 'Please do a SQL review']);
    expect(h.code).toBe(EXIT_OK);
    const req = skillRequests().find((r) => r.url === '/api/skills/match')!;
    expect(req.method).toBe('POST');
    expect(req.body).toEqual({ text: 'Please do a SQL review' });
    expect(h.out).toContain('Preview only: nothing was sent to the agent.');
    expect(h.out).toContain('SQL review  [sql review]  m1 r2');
    expect(h.out).not.toContain(SECRET);

    const j = await cli(['skills', 'match', '--text', 'nothing here', '--json']);
    expect(parseJsonStdout(j)).toEqual({ matches: [], warnings: [] });
    expect(j.err).toBe('');
    const none = await cli(['skills', 'match', '--text', 'nothing here']);
    expect(none.out).toContain('No enabled skills would apply');
  });

  it('reads text from stdin and prints warnings', async () => {
    fake.override = (r) =>
      r.url === '/api/skills/match'
        ? {
            status: 200,
            body: {
              matches: [],
              warnings: [
                {
                  code: 'INVALID_SKILL',
                  skillId: 'bad1',
                  message: 'A saved skill is invalid and was skipped.',
                },
              ],
            },
          }
        : undefined;
    const h = await cli(['skills', 'match', '--text-file', '-'], { stdin: stdinOf('from pipe') });
    expect(h.code).toBe(EXIT_OK);
    expect(skillRequests()[0].body).toEqual({ text: 'from pipe' });
    expect(h.out).toContain('Warning (bad1): A saved skill is invalid and was skipped.');
  });

  it('validates input locally and maps limit errors', async () => {
    expect((await cli(['skills', 'match'])).code).toBe(EXIT_USAGE);
    expect((await cli(['skills', 'match', '--text', 'a', '--text-file', '-'])).code).toBe(
      EXIT_USAGE,
    );
    expect(fake.requests).toHaveLength(0);

    fake.override = (r) =>
      r.url === '/api/skills/match'
        ? {
            status: 413,
            body: err(
              'ACTIVE_LIMIT_EXCEEDED',
              'Too many skills matched. Use fewer keywords or disable some skills.',
            ),
          }
        : undefined;
    const h = await cli(['skills', 'match', '--text', 'x', '--json']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(jsonError(h)).toMatchObject({ code: 'ACTIVE_LIMIT_EXCEEDED', status: 413 });
  });

  it('prompts for text on a terminal', async () => {
    const h = await cli(['skills', 'match'], {
      interactive: true,
      answers: [{ kind: 'text', value: 'typed' }],
    });
    expect(h.code).toBe(EXIT_OK);
    expect(skillRequests()[0].body).toEqual({ text: 'typed' });
  });
});

describe('auth, availability and timeouts', () => {
  it('activates with the configured key without printing it', async () => {
    await cli(['skills', 'list']);
    const act = fake.requests.find((r) => r.url === '/api/subscription/activate')!;
    expect(act.body).toEqual({ key: LICENSE, licenseKey: LICENSE });
  });

  it('fails clearly on rejected and expired subscriptions', async () => {
    fake.activation = { status: 401, body: { error: 'Invalid subscription key.' } };
    const a = await cli(['skills', 'list', '--json']);
    expect(a.code).toBe(EXIT_FAILURE);
    expect(jsonError(a)).toMatchObject({ code: 'AUTH_FAILED', status: 401 });
    expect(skillRequests()).toHaveLength(0);

    fake.activation = {
      status: 403,
      body: { error: 'Subscription has expired.', subscriptionStatus: 'expired' },
    };
    const e = await cli(['skills', 'list']);
    expect(e.code).toBe(EXIT_FAILURE);
    expect(e.err).toContain('subscription has expired');
  });

  it('re-activates once when the token is rejected, then fails if still rejected', async () => {
    let rejected = 0;
    fake.override = (r) =>
      r.url === '/api/skills' && rejected++ === 0
        ? { status: 403, body: { error: 'Invalid or expired token.' } }
        : undefined;
    const ok = await cli(['skills', 'list']);
    expect(ok.code).toBe(EXIT_OK);
    expect(fake.requests.filter((r) => r.url === '/api/subscription/activate')).toHaveLength(2);

    fake.override = (r) =>
      r.url.startsWith('/api/skills')
        ? { status: 403, body: { error: 'Invalid or expired token.' } }
        : undefined;
    const bad = await cli(['skills', 'list']);
    expect(bad.code).toBe(EXIT_FAILURE);
    expect(bad.err).toContain('rejected the session token');
    expect(bad.err).not.toContain('jwt expired');
  });

  it('reports an unavailable daemon', async () => {
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const h = await cli(['skills', 'list', '--json'], { baseUrl: `http://127.0.0.1:${port}` });
    expect(h.code).toBe(EXIT_FAILURE);
    expect(jsonError(h).code).toBe('BACKEND_UNAVAILABLE');
    expect(h.out).toBe('');
  });

  it('times out slow requests', async () => {
    fake.override = (r) =>
      r.url === '/api/skills' ? { status: 200, body: { skills: [] }, delayMs: 2_000 } : undefined;
    const started = Date.now();
    const h = await cli(['skills', 'list'], { timeoutMs: 150 });
    expect(h.code).toBe(EXIT_FAILURE);
    expect(h.err).toContain('did not respond');
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('maps unstructured server errors without echoing them', async () => {
    fake.override = (r) =>
      r.url === '/api/skills' ? { status: 500, raw: 'Error: boom at /srv/x.ts:1' } : undefined;
    const h = await cli(['skills', 'list']);
    expect(h.code).toBe(EXIT_FAILURE);
    expect(h.err).toContain('HTTP 500');
    expect(h.err).not.toContain('boom');
  });

  it('reads the daemon port and license key from the existing config file', async () => {
    const home = fs.mkdtempSync(path.join(tmpRoot, 'home-'));
    const prevHome = process.env.HOME;
    const port = Number(new URL(fake.baseUrl).port);
    try {
      process.env.HOME = home;
      fs.mkdirSync(path.join(home, '.omnikey'));
      fs.writeFileSync(
        path.join(home, '.omnikey', 'config.json'),
        JSON.stringify({ OMNIKEY_PORT: port, OMNIKEY_LICENSE_KEY: LICENSE }),
      );
      // localhost may resolve to ::1 first; the fake listens on 127.0.0.1 only.
      const res = await createDefaultTransport()
        .request('GET', '/api/skills')
        .catch((e) => e);
      if (res.status !== undefined) {
        expect(res.status).toBe(200);
        expect(fake.requests[0].body).toEqual({ key: LICENSE, licenseKey: LICENSE });
      } else {
        expect(res.code).toBe('BACKEND_UNAVAILABLE');
        expect(res.message).toContain(`http://localhost:${port}`);
      }
      fs.writeFileSync(
        path.join(home, '.omnikey', 'config.json'),
        JSON.stringify({ OMNIKEY_PORT: 'abc' }),
      );
      expect(() => createDefaultTransport()).toThrow(/not a valid port/);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

// ── Disposable real backend smoke test ─────────────────────────────────────

describe('smoke: real API Skills router on a disposable SQLite database', () => {
  const apiSrc = path.resolve(__dirname, '../../../api/src');
  let server: http.Server | undefined;
  let seq: { close(): Promise<void>; query(sql: string): Promise<unknown> } | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    const express = (await import('express')).default;
    const { Sequelize } = await import('sequelize');
    const { createSkillRouter } = await import(path.join(apiSrc, 'skillRoutes.ts'));
    const { defineSkillModel } = await import(path.join(apiSrc, 'models', 'skill.ts'));
    const { createSkillStore } = await import(path.join(apiSrc, 'skills', 'skillStore.ts'));
    const storage = path.join(tmpRoot, 'smoke.sqlite');
    expect(path.resolve(storage).startsWith(path.resolve(os.tmpdir()))).toBe(true);
    const s = new Sequelize({ dialect: 'sqlite', storage, logging: false });
    seq = s;
    await s.query('CREATE TABLE subscriptions (id VARCHAR(255) PRIMARY KEY)');
    await s.query("INSERT INTO subscriptions (id) VALUES ('owner-a')");
    const model = defineSkillModel(s);
    await model.sync();
    const logger = { info: () => {}, warn: () => {}, error: () => {} };
    const store = createSkillStore({ sequelize: s, model, logger });
    const app = express();
    app.post('/api/subscription/activate', express.json(), (_req, res) => {
      res.json({ token: 'smoke-token' });
    });
    app.use(
      '/api/skills',
      createSkillRouter({
        store,
        logger,
        auth: (
          req: http.IncomingMessage,
          res: { locals: Record<string, unknown>; status(n: number): { json(b: unknown): void } },
          next: () => void,
        ) => {
          if (req.headers.authorization !== 'Bearer smoke-token') {
            res.status(401).json({ error: 'Invalid token.' });
            return;
          }
          res.locals.subscription = { id: 'owner-a' };
          next();
        },
      }),
    );
    server = await new Promise<http.Server>((resolve) => {
      const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    try {
      if (server) await new Promise<void>((r) => server!.close(() => r()));
    } finally {
      await seq?.close();
    }
  });

  it('runs the full lifecycle through HTTP only', async () => {
    const run = (argv: string[], opts: Parameters<typeof cli>[1] = {}) =>
      cli(argv, { baseUrl, ...opts });
    const file = writeTmp('smoke.md', `${SECRET}\r\nReview SQL carefully.`);

    const add = await run([
      'skills',
      'add',
      '--name',
      'SQL review',
      '--keyword',
      'sql review',
      '--instructions-file',
      file,
      '--json',
    ]);
    expect(add.code, add.err).toBe(EXIT_OK);
    const { skill } = parseJsonStdout(add);
    expect(skill).toMatchObject({
      name: 'SQL review',
      keyword: 'sql review',
      enabled: true,
      revision: 1,
    });
    expect(skill.instructions).toBe(`${SECRET}\nReview SQL carefully.`);

    const list = await run(['skills', 'list', '--json']);
    expect(parseJsonStdout(list).skills).toHaveLength(1);
    expect(parseJsonStdout(list).skills[0]).not.toHaveProperty('instructions');

    const match = await run(['skills', 'match', '--text', 'Please do a SQL   Review!', '--json']);
    expect(parseJsonStdout(match)).toEqual({
      matches: [{ id: skill.id, name: 'SQL review', keyword: 'sql review', revision: 1 }],
      warnings: [],
    });
    const miss = await run(['skills', 'match', '--text', 'nosql review', '--json']);
    expect(parseJsonStdout(miss).matches).toEqual([]);

    const dup = await run([
      'skills',
      'add',
      '--name',
      'Other',
      '--keyword',
      'SQL  Review',
      '--instructions-file',
      file,
      '--json',
    ]);
    expect(dup.code).toBe(EXIT_FAILURE);
    expect(jsonError(dup).code).toBe('KEYWORD_CONFLICT');

    const reserved = await run([
      'skills',
      'add',
      '--name',
      'R',
      '--keyword',
      '@omniagent',
      '--instructions-file',
      file,
    ]);
    expect(reserved.code).toBe(EXIT_FAILURE);

    const edit = await run(['skills', 'edit', skill.id, '--name', 'SQL review v2', '--json']);
    expect(parseJsonStdout(edit).skill).toMatchObject({ name: 'SQL review v2', revision: 2 });

    const stale = await run(['skills', 'disable', skill.id, '--revision', '1', '--json']);
    expect(stale.code).toBe(EXIT_FAILURE);
    expect(jsonError(stale).code).toBe('REVISION_CONFLICT');

    const disable = await run(['skills', 'disable', skill.id, '--json']);
    expect(parseJsonStdout(disable).skill).toMatchObject({ enabled: false, revision: 3 });
    const disabledMatch = await run(['skills', 'match', '--text', 'sql review', '--json']);
    expect(parseJsonStdout(disabledMatch).matches).toEqual([]);

    const enable = await run(['skills', 'enable', skill.id]);
    expect(enable.code).toBe(EXIT_OK);

    const show = await run(['skills', 'show', skill.id, '--json']);
    expect(parseJsonStdout(show).skill).toMatchObject({ enabled: true, revision: 4 });

    const del = await run(['skills', 'delete', skill.id, '--yes', '--json']);
    expect(parseJsonStdout(del)).toEqual({ deleted: true });
    const gone = await run(['skills', 'show', skill.id, '--json']);
    expect(gone.code).toBe(EXIT_FAILURE);
    expect(jsonError(gone).code).toBe('NOT_FOUND');
  });
});
