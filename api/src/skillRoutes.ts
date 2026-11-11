/**
 * /api/skills — Skills v1 CRUD and non-executing match preview
 * (docs/skills-contract.md).
 *
 * Mount BEFORE the global express.json(): this router authenticates first,
 * then parses JSON with its own limit and structured error boundary. All
 * errors use `{error:{code,message,fields?}}`; legacy auth middleware errors
 * pass through unchanged. Request bodies, names, keywords and instructions
 * are never logged.
 */
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { BaseError } from 'sequelize';
import {
  SkillError,
  type ResolveSkillsForInput,
  type SkillErrorBody,
  type SkillErrorCode,
  type SkillMatchPreview,
} from './skills/contracts';
import {
  createSkillInputResolver,
  SKILL_ERROR_MESSAGES,
  getDefaultSkillStore,
  safeErrorMeta,
  storeUnavailable,
  type SkillCrudStore,
  type SkillStoreLogger,
} from './skills/skillStore';
import { parseIfMatchRevision, parseSkillPreview, revisionETag } from './skills/validation';
import { matchSkills } from './skills/matcher';

/** Serialized JSON cap; decoded preview text is limited separately. */
export const SKILLS_JSON_BODY_LIMIT_BYTES = 2_500_000;

export const PREVIEW_TOO_LONG_MESSAGE = 'Preview text is too long. Use a shorter sample.';

export interface SkillRouterOptions {
  store?: SkillCrudStore | (() => Promise<SkillCrudStore>);
  resolveSkills?: ResolveSkillsForInput;
  /** Defaults to the shared authMiddleware (loaded lazily). */
  auth?: RequestHandler;
  logger?: SkillStoreLogger;
}

function sendError(
  res: Response,
  status: number,
  code: SkillErrorCode,
  message: string,
  fields?: Record<string, string>,
): void {
  if (res.headersSent) return;
  const body: SkillErrorBody = { error: { code, message, ...(fields ? { fields } : {}) } };
  res.status(status).json(body);
}

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  const e = err as { type?: unknown; status?: unknown };
  return typeof e?.type === 'string' && typeof e?.status === 'number';
}

export function createSkillRouter(options: SkillRouterOptions = {}): express.Router {
  const router = express.Router();
  const resolveSkills: ResolveSkillsForInput =
    options.resolveSkills ??
    (async (owner, text) => createSkillInputResolver(await getStore(), matchSkills)(owner, text));
  let fallbackLogger: SkillStoreLogger | undefined = options.logger;

  const getLogger = async (res: Response): Promise<SkillStoreLogger> => {
    const local = res.locals.logger as SkillStoreLogger | undefined;
    if (local) return local;
    if (!fallbackLogger) fallbackLogger = (await import('./logger')).logger;
    return fallbackLogger;
  };

  const getStore = async (): Promise<SkillCrudStore> => {
    const configured = options.store;
    if (typeof configured === 'function') return configured();
    return configured ?? getDefaultSkillStore();
  };

  const getAuth = async (): Promise<RequestHandler> => {
    if (options.auth) return options.auth;
    return (await import('./authMiddleware')).authMiddleware as unknown as RequestHandler;
  };

  const handle =
    (fn: (req: Request, res: Response, subscriptionId: string) => Promise<void>): RequestHandler =>
    (req, res, next) => {
      fn(req, res, res.locals.subscription.id as string).catch(next);
    };

  // Responses reflect the current database state; never serve them from caches.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // 1. Authenticate before reading any body. Async failures fail closed.
  router.use((req, res, next) => {
    getAuth()
      .then((auth) => auth(req, res, next))
      .catch((err: unknown) => {
        void getLogger(res).then((logger) =>
          logger.warn('Skills authentication failed.', safeErrorMeta(err)),
        );
        if (err instanceof BaseError) {
          const e = storeUnavailable();
          sendError(res, e.status, e.code, e.message);
        } else {
          sendError(res, 500, 'INTERNAL_ERROR', SKILL_ERROR_MESSAGES.INTERNAL_ERROR);
        }
      });
  });

  // 2. Require an owner identity (e.g. hosted mode without JWT secret has none).
  router.use((_req, res, next) => {
    const id = (res.locals.subscription as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'string' || !id) {
      sendError(res, 401, 'UNAUTHENTICATED', SKILL_ERROR_MESSAGES.UNAUTHENTICATED);
      return;
    }
    next();
  });

  // 3. Scoped JSON parser with its own structured error boundary.
  router.use(express.json({ limit: SKILLS_JSON_BODY_LIMIT_BYTES, strict: true }));
  router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!isBodyParserError(err)) return next(err);
    void getLogger(res).then((logger) =>
      logger.warn('Rejected skills request body.', { type: err.type }),
    );
    if (err.type === 'entity.too.large') {
      sendError(res, 413, 'INPUT_LIMIT_EXCEEDED', 'Request body is too large.');
      return;
    }
    sendError(res, 400, 'VALIDATION_ERROR', 'Request body must be valid JSON.', {
      body: 'Request body must be valid JSON.',
    });
  });

  router.get(
    '/',
    handle(async (_req, res, subscriptionId) => {
      const store = await getStore();
      res.json({ skills: await store.list(subscriptionId) });
    }),
  );

  router.post(
    '/',
    handle(async (req, res, subscriptionId) => {
      const store = await getStore();
      const skill = await store.create(subscriptionId, req.body);
      res.status(201).set('ETag', revisionETag(skill.revision)).json({ skill });
    }),
  );

  // Registered before parameterized routes.
  router.post(
    '/match',
    handle(async (req, res, subscriptionId) => {
      const parsed = parseSkillPreview(req.body);
      if (!parsed.ok) {
        if (parsed.tooLarge) {
          sendError(res, 413, 'INPUT_LIMIT_EXCEEDED', PREVIEW_TOO_LONG_MESSAGE);
        } else {
          sendError(
            res,
            400,
            'VALIDATION_ERROR',
            SKILL_ERROR_MESSAGES.VALIDATION_ERROR,
            parsed.fields,
          );
        }
        return;
      }
      const result = await resolveSkills(subscriptionId, parsed.value);
      const preview: SkillMatchPreview = {
        matches: result.matches.map(({ id, name, keyword, revision }) => ({
          id,
          name,
          keyword,
          revision,
        })),
        warnings: result.warnings.map(({ code, skillId, message }) => ({
          code,
          ...(skillId !== undefined ? { skillId } : {}),
          message,
        })),
      };
      res.json(preview);
    }),
  );

  router.get(
    '/:id',
    handle(async (req, res, subscriptionId) => {
      const store = await getStore();
      const skill = await store.get(subscriptionId, req.params.id);
      res.set('ETag', revisionETag(skill.revision)).json({ skill });
    }),
  );

  const requireRevision = (req: Request, res: Response): number | null => {
    const parsed = parseIfMatchRevision(req.headers['if-match']);
    if (parsed.ok) return parsed.revision;
    if (parsed.reason === 'missing') {
      sendError(res, 428, 'REVISION_REQUIRED', SKILL_ERROR_MESSAGES.REVISION_REQUIRED);
    } else {
      sendError(res, 400, 'VALIDATION_ERROR', 'If-Match must be a single quoted revision.');
    }
    return null;
  };

  router.patch(
    '/:id',
    handle(async (req, res, subscriptionId) => {
      const revision = requireRevision(req, res);
      if (revision === null) return;
      const store = await getStore();
      const skill = await store.update(subscriptionId, req.params.id, revision, req.body);
      res.set('ETag', revisionETag(skill.revision)).json({ skill });
    }),
  );

  router.delete(
    '/:id',
    handle(async (req, res, subscriptionId) => {
      const revision = requireRevision(req, res);
      if (revision === null) return;
      const store = await getStore();
      await store.remove(subscriptionId, req.params.id, revision);
      res.status(204).end();
    }),
  );

  router.use((_req, res) => {
    sendError(res, 404, 'NOT_FOUND', 'Not found.');
  });

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof SkillError) {
      sendError(res, err.status, err.code, err.message, err.fields);
      return;
    }
    void getLogger(res).then((logger) =>
      logger.error('Skills request failed.', safeErrorMeta(err)),
    );
    if (err instanceof BaseError) {
      const e = storeUnavailable();
      sendError(res, e.status, e.code, e.message);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', SKILL_ERROR_MESSAGES.INTERNAL_ERROR);
  });

  return router;
}
