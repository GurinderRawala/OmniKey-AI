import fs from 'fs';
import os from 'os';
import path from 'path';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { ConnectionError, Sequelize } from 'sequelize';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillError, type ResolveSkillsForInput } from '../skills/contracts';
import {
  createSkillInputResolver,
  createSkillStore,
  type SkillCrudStore,
} from '../skills/skillStore';

// The shared db module is replaced so importing the model never opens the
// application database; tests bind the model to an isolated TMPDIR file.
vi.mock('../db', async () => {
  const { Sequelize: S } = await import('sequelize');
  return { sequelize: new S({ dialect: 'sqlite', storage: ':memory:', logging: false }) };
});
const authMock = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../authMiddleware', () => ({
  authMiddleware: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    authMock.calls += 1;
    res.locals.subscription = { id: 'owner-a' };
    next();
  },
}));

import { createSkillRouter, SKILLS_JSON_BODY_LIMIT_BYTES } from '../skillRoutes';
import { defineSkillModel } from '../models/skill';

const SECRET = 'ROUTE-SECRET-INSTRUCTIONS-91c2';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-routes-'));
const logs: unknown[] = [];
const logger = {
  info: (...a: unknown[]) => logs.push(a),
  warn: (...a: unknown[]) => logs.push(a),
  error: (...a: unknown[]) => logs.push(a),
};
let seq: Sequelize;
let store: SkillCrudStore;

/** Test auth: owner from a header; mirrors authMiddleware's locals contract. */
const headerAuth: RequestHandler = (req, res, next) => {
  const owner = req.header('x-test-owner');
  res.locals.logger = logger;
  if (!owner) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return;
  }
  res.locals.subscription = { id: owner };
  next();
};

function makeApp(options: Parameters<typeof createSkillRouter>[0] = {}) {
  const app = express();
  // Same ordering as index.ts: skills router ahead of the global parser.
  app.use('/api/skills', createSkillRouter({ store, auth: headerAuth, logger, ...options }));
  app.use(express.json());
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });
  return app;
}

const createBody = (keyword: string, extra: Record<string, unknown> = {}) => ({
  name: 'Review',
  keyword,
  instructions: `${SECRET} check edge cases.`,
  ...extra,
});

beforeAll(async () => {
  expect(path.resolve(tmpRoot).startsWith(path.resolve(os.tmpdir()))).toBe(true);
  seq = new Sequelize({
    dialect: 'sqlite',
    storage: path.join(tmpRoot, 'routes.sqlite'),
    logging: false,
  });
  await seq.query('CREATE TABLE subscriptions (id VARCHAR(255) PRIMARY KEY)');
  await seq.query("INSERT INTO subscriptions (id) VALUES ('owner-a'), ('owner-b')");
  const model = defineSkillModel(seq);
  await model.sync();
  store = createSkillStore({ sequelize: seq, model, logger });
});

afterAll(async () => {
  await seq.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  expect(JSON.stringify(logs)).not.toContain(SECRET);
});

beforeEach(() => {
  authMock.calls = 0;
});

describe('Skills HTTP CRUD', () => {
  it('supports the full lifecycle with fixture shapes, strong ETags and no-store caching', async () => {
    const app = makeApp();
    const created = await request(app).post('/api/skills').set('x-test-owner', 'owner-a').send({
      name: 'Review',
      keyword: 'code review',
      instructions: 'Check edge cases.',
      enabled: true,
    });
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.headers['cache-control']).toBe('no-store');
    const skill = created.body.skill;
    expect(Object.keys(created.body)).toEqual(['skill']);
    expect(skill).toEqual({
      id: expect.any(String),
      name: 'Review',
      keyword: 'code review',
      instructions: 'Check edge cases.',
      enabled: true,
      revision: 1,
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: skill.createdAt,
    });

    const list = await request(app).get('/api/skills').set('x-test-owner', 'owner-a');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      skills: [
        {
          id: skill.id,
          name: 'Review',
          keyword: 'code review',
          enabled: true,
          revision: 1,
          createdAt: skill.createdAt,
          updatedAt: skill.updatedAt,
        },
      ],
    });

    const item = await request(app).get(`/api/skills/${skill.id}`).set('x-test-owner', 'owner-a');
    expect(item.status).toBe(200);
    expect(item.headers.etag).toBe('"1"');
    expect(item.body).toEqual({ skill });

    const missingRev = await request(app)
      .patch(`/api/skills/${skill.id}`)
      .set('x-test-owner', 'owner-a')
      .send({ enabled: false });
    expect(missingRev.status).toBe(428);
    expect(missingRev.body).toEqual({
      error: { code: 'REVISION_REQUIRED', message: 'A revision is required.' },
    });

    const patched = await request(app)
      .patch(`/api/skills/${skill.id}`)
      .set('x-test-owner', 'owner-a')
      .set('If-Match', '"1"')
      .send({ enabled: false });
    expect(patched.status).toBe(200);
    expect(patched.headers.etag).toBe('"2"');
    expect(patched.body.skill).toMatchObject({ enabled: false, revision: 2 });

    const stale = await request(app)
      .patch(`/api/skills/${skill.id}`)
      .set('x-test-owner', 'owner-a')
      .set('If-Match', '"1"')
      .send({ name: 'lost' });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({
      error: { code: 'REVISION_CONFLICT', message: 'Skill changed. Reload before retrying.' },
    });

    const staleDelete = await request(app)
      .delete(`/api/skills/${skill.id}`)
      .set('x-test-owner', 'owner-a')
      .set('If-Match', '"1"');
    expect(staleDelete.status).toBe(409);
    expect(staleDelete.body.error.code).toBe('REVISION_CONFLICT');

    const noRevDelete = await request(app)
      .delete(`/api/skills/${skill.id}`)
      .set('x-test-owner', 'owner-a');
    expect(noRevDelete.status).toBe(428);

    const deleted = await request(app)
      .delete(`/api/skills/${skill.id}`)
      .set('x-test-owner', 'owner-a')
      .set('If-Match', '"2"');
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');

    const gone = await request(app).get(`/api/skills/${skill.id}`).set('x-test-owner', 'owner-a');
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Skill not found.' } });
  });

  it.each([
    ['W/"1"'],
    ['*'],
    ['"0"'],
    ['"01"'],
    ['1'],
    ['"1", "2"'],
    ['"9007199254740993"'],
    ['"-1"'],
    ['"1.0"'],
    [''],
  ])('rejects malformed If-Match %j with 400', async (header) => {
    const app = makeApp();
    const s = await store.create('owner-a', createBody(`ifmatch ${Math.random()}`));
    const res = await request(app)
      .patch(`/api/skills/${s.id}`)
      .set('x-test-owner', 'owner-a')
      .set('If-Match', header)
      .send({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const del = await request(app)
      .delete(`/api/skills/${s.id}`)
      .set('x-test-owner', 'owner-a')
      .set('If-Match', header);
    expect(del.status).toBe(400);
    expect((await store.get('owner-a', s.id)).revision).toBe(1);
    await store.remove('owner-a', s.id, 1);
  });

  it('returns structured validation errors with field keys and no echoed content', async () => {
    const app = makeApp();
    const cases: Array<[unknown, string[]]> = [
      [{ ...createBody('k'), extra: 1 }, ['body']],
      [{ name: '', keyword: '@omniagent', instructions: '' }, ['instructions', 'keyword', 'name']],
      [{ ...createBody('k'), enabled: 'true' }, ['enabled']],
      [[createBody('k')], ['body']],
    ];
    for (const [payload, fields] of cases) {
      const res = await request(app)
        .post('/api/skills')
        .set('x-test-owner', 'owner-a')
        .send(payload as object);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(Object.keys(res.body.error.fields).sort()).toEqual(fields);
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
    }
    const s = await store.create('owner-a', createBody('patch me'));
    const empty = await request(app)
      .patch(`/api/skills/${s.id}`)
      .set('x-test-owner', 'owner-a')
      .set('If-Match', '"1"')
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.fields).toEqual({ body: expect.any(String) });
    await store.remove('owner-a', s.id, 1);
  });

  it('maps keyword conflicts (including disabled and racing creates) to 409 KEYWORD_CONFLICT', async () => {
    const app = makeApp();
    const off = await store.create('owner-a', createBody('Dup Key', { enabled: false }));
    const dup = await request(app)
      .post('/api/skills')
      .set('x-test-owner', 'owner-a')
      .send(createBody('ＤＵＰ   key'));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('KEYWORD_CONFLICT');
    const race = await Promise.all(
      [1, 2, 3].map(() =>
        request(app).post('/api/skills').set('x-test-owner', 'owner-b').send(createBody('dup key')),
      ),
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    await store.remove('owner-a', off.id, 1);
  });

  it('isolates owners: foreign ids are 404 and lists never cross owners', async () => {
    const app = makeApp();
    const s = await store.create('owner-a', createBody('owned only'));
    for (const req of [
      request(app).get(`/api/skills/${s.id}`),
      request(app).patch(`/api/skills/${s.id}`).set('If-Match', '"1"').send({ name: 'x' }),
      request(app).delete(`/api/skills/${s.id}`).set('If-Match', '"1"'),
    ]) {
      const res = await req.set('x-test-owner', 'owner-b');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    const listB = await request(app).get('/api/skills').set('x-test-owner', 'owner-b');
    expect(listB.body.skills.map((x: { id: string }) => x.id)).not.toContain(s.id);
    expect((await store.get('owner-a', s.id)).revision).toBe(1);
    await store.remove('owner-a', s.id, 1);
  });

  it('answers unknown subpaths with a structured 404 instead of falling through', async () => {
    const res = await request(makeApp()).get('/api/skills/a/b').set('x-test-owner', 'owner-a');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
  });
});

describe('Skills auth and parser boundary', () => {
  it('authenticates before parsing: unauthenticated malformed/oversized bodies get the auth error', async () => {
    const app = makeApp();
    const bad = await request(app)
      .post('/api/skills')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(bad.status).toBe(401);
    expect(bad.body).toEqual({ error: 'Missing bearer token.' });
    const huge = await request(app)
      .post('/api/skills')
      .set('Content-Type', 'application/json')
      // Advertise an oversized body without racing a multi-MB write against
      // the deliberate early auth response (which can reset the socket).
      .set('Content-Length', String(SKILLS_JSON_BODY_LIMIT_BYTES + 10))
      .send('{');
    expect(huge.status).toBe(401);
  });

  it('returns structured 400 for invalid JSON and JSON primitives, 413 for oversized bodies', async () => {
    const app = makeApp();
    const bad = await request(app)
      .post('/api/skills')
      .set('x-test-owner', 'owner-a')
      .set('Content-Type', 'application/json')
      .send(`{"instructions":"${SECRET}",`);
    expect(bad.status).toBe(400);
    expect(bad.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body must be valid JSON.',
        fields: { body: 'Request body must be valid JSON.' },
      },
    });
    const primitive = await request(app)
      .post('/api/skills/match')
      .set('x-test-owner', 'owner-a')
      .set('Content-Type', 'application/json')
      .send('"text"');
    expect(primitive.status).toBe(400);
    expect(primitive.body.error.code).toBe('VALIDATION_ERROR');
    const huge = await request(app)
      .post('/api/skills')
      .set('x-test-owner', 'owner-a')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ instructions: 'x'.repeat(SKILLS_JSON_BODY_LIMIT_BYTES) }));
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe('INPUT_LIMIT_EXCEEDED');
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it('uses its own parser limit rather than the global 100kb express.json default', async () => {
    const resolveSkills = vi.fn<ResolveSkillsForInput>(async () => ({ matches: [], warnings: [] }));
    const text = '😀'.repeat(50_000); // 200,000 UTF-8 bytes: over 100kb, under preview limits
    const res = await request(makeApp({ resolveSkills }))
      .post('/api/skills/match')
      .set('x-test-owner', 'owner-a')
      .send({ text });
    expect(res.status).toBe(200);
    expect(resolveSkills).toHaveBeenCalledWith('owner-a', text);
  });

  it('fails closed when authentication itself fails', async () => {
    const storeErrorAuth: RequestHandler = async () => {
      throw new ConnectionError(new Error('db down'));
    };
    const res = await request(makeApp({ auth: storeErrorAuth })).get('/api/skills');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: 'STORE_UNAVAILABLE',
        message: 'Skills are temporarily unavailable. Please retry.',
      },
    });
    const bugAuth: RequestHandler = () => {
      throw new TypeError('boom');
    };
    const bug = await request(makeApp({ auth: bugAuth })).get('/api/skills');
    expect(bug.status).toBe(500);
    expect(bug.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(bug.body)).not.toContain('boom');
  });

  it('returns 401 UNAUTHENTICATED when auth passes without an owner identity', async () => {
    const noOwner: RequestHandler = (_req, _res, next) => next();
    const res = await request(makeApp({ auth: noOwner }))
      .post('/api/skills')
      .send(createBody('no owner'));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' },
    });
  });

  it('uses the shared authMiddleware by default', async () => {
    const app = express();
    app.use('/api/skills', createSkillRouter({ store, logger }));
    const res = await request(app).get('/api/skills');
    expect(res.status).toBe(200);
    expect(authMock.calls).toBe(1);
  });

  it('maps an unavailable store to 503 on every route without leaking details', async () => {
    const broken = createSkillStore({
      sequelize: undefined,
      model: defineSkillModel(seq),
      logger,
    });
    const app = makeApp({
      store: broken,
      resolveSkills: createSkillInputResolver(broken, () => {
        throw new Error('matcher must not run when the store is unavailable');
      }),
    });
    const responses = await Promise.all([
      request(app).get('/api/skills').set('x-test-owner', 'owner-a'),
      request(app).get('/api/skills/x').set('x-test-owner', 'owner-a'),
      request(app).post('/api/skills').set('x-test-owner', 'owner-a').send(createBody('x')),
      request(app)
        .patch('/api/skills/x')
        .set('x-test-owner', 'owner-a')
        .set('If-Match', '"1"')
        .send({ name: 'x' }),
      request(app).delete('/api/skills/x').set('x-test-owner', 'owner-a').set('If-Match', '"1"'),
      request(app).post('/api/skills/match').set('x-test-owner', 'owner-a').send({ text: 'x' }),
    ]);
    for (const res of responses) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        error: {
          code: 'STORE_UNAVAILABLE',
          message: 'Skills are temporarily unavailable. Please retry.',
        },
      });
    }
  });

  it('maps unexpected store failures to a safe 500', async () => {
    const throwing = {
      ...store,
      list: async () => {
        throw new Error(`unexpected ${SECRET}`);
      },
    } as SkillCrudStore;
    const res = await request(makeApp({ store: throwing }))
      .get('/api/skills')
      .set('x-test-owner', 'owner-a');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Skills could not be processed.' },
    });
  });
});

describe('POST /api/skills/match preview', () => {
  it('is explicitly unavailable until the matcher is integrated (no fake matching)', async () => {
    await store.create('owner-a', createBody('preview default'));
    const res = await request(makeApp())
      .post('/api/skills/match')
      .set('x-test-owner', 'owner-a')
      .send({ text: 'Please preview default' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: { code: 'STORE_UNAVAILABLE', message: 'Skill preview is not available yet.' },
    });
    expect(JSON.stringify(res.body)).not.toContain('matches');
  });

  it('returns refs only (never instructions) from the injected resolver over the real store', async () => {
    const created = await store.create('owner-b', {
      name: 'Review',
      keyword: 'code review',
      instructions: SECRET,
    });
    await seq.query(
      `INSERT INTO skills (id, subscription_id, name, keyword, normalized_keyword, instructions, enabled, revision, createdAt, updatedAt)
       VALUES ('broken-row', 'owner-b', ' ', 'x', 'x', 'y', 1, 1, '2026-11-11 00:00:00.000 +00:00', '2026-11-11 00:00:00.000 +00:00')`,
    );
    // Test-only stand-in for the S2 matcher: selects snapshots whose keyword occurs.
    const testMatcher = vi.fn((text: string, snapshots: readonly { keyword: string }[]) => ({
      matches: snapshots.filter((s) => text.toLowerCase().includes(s.keyword)) as never,
      warnings: [],
    }));
    const app = makeApp({ resolveSkills: createSkillInputResolver(store, testMatcher) });
    const res = await request(app)
      .post('/api/skills/match')
      .set('x-test-owner', 'owner-b')
      .send({ text: 'Please code review' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      matches: [{ id: created.id, name: 'Review', keyword: 'code review', revision: 1 }],
      warnings: [
        {
          code: 'INVALID_SKILL',
          skillId: 'broken-row',
          message: 'A saved skill is invalid and was skipped.',
        },
      ],
    });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(testMatcher).toHaveBeenCalledWith('Please code review', expect.any(Array));
  });

  it('validates the strict {text} body and the preview-only size limit', async () => {
    const resolveSkills = vi.fn<ResolveSkillsForInput>(async () => ({ matches: [], warnings: [] }));
    const app = makeApp({ resolveSkills });
    const post = (payload: unknown) =>
      request(app)
        .post('/api/skills/match')
        .set('x-test-owner', 'owner-a')
        .send(payload as object);

    expect((await post({ text: 'a', extra: true })).body.error.fields).toEqual({
      body: expect.any(String),
    });
    expect((await post({ text: 5 })).body.error.fields).toEqual({ text: expect.any(String) });
    expect((await post({})).status).toBe(400);
    expect((await post({ text: 'a\u0000b' })).status).toBe(400);

    const atLimit = await post({ text: '😀'.repeat(100_000) });
    expect(atLimit.status).toBe(200);
    const over = await post({ text: '😀'.repeat(100_000) + 'a' });
    expect(over.status).toBe(413);
    expect(over.body).toEqual({
      error: {
        code: 'INPUT_LIMIT_EXCEEDED',
        message: 'Preview text is too long. Use a shorter sample.',
      },
    });
    const whitespace = await post({ text: '   ' });
    expect(whitespace.status).toBe(200);
    expect(resolveSkills).toHaveBeenCalledTimes(2);
  });

  it('propagates all-or-nothing limit errors with no partial refs', async () => {
    const resolveSkills: ResolveSkillsForInput = async () => {
      throw new SkillError(
        413,
        'ACTIVE_LIMIT_EXCEEDED',
        'Too many skills matched. Use fewer keywords or disable some skills.',
      );
    };
    const res = await request(makeApp({ resolveSkills }))
      .post('/api/skills/match')
      .set('x-test-owner', 'owner-a')
      .send({ text: 'many' });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: {
        code: 'ACTIVE_LIMIT_EXCEEDED',
        message: 'Too many skills matched. Use fewer keywords or disable some skills.',
      },
    });
  });

  it('is routed before parameterized item routes', async () => {
    const resolveSkills = vi.fn<ResolveSkillsForInput>(async () => ({ matches: [], warnings: [] }));
    const res = await request(makeApp({ resolveSkills }))
      .post('/api/skills/match')
      .set('x-test-owner', 'owner-a')
      .send({ text: 'x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matches: [], warnings: [] });
  });
});
