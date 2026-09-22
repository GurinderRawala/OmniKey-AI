import express, { Response } from 'express';
import { Op } from 'sequelize';
import { config } from '../../config';
import { AgentSession } from '../../models/agentSession';
import { authMiddleware, AuthLocals } from '../../authMiddleware';
import { getContextWindowSize } from '../../ai-client';
import {
  getAgentSettings,
  getAgentSettingsVersion,
  selectedAgentModelForProvider,
} from '../../agentSettingsStore';
import { GROUPING_SESSION_PREFIX } from '../sessionGrouping';
import { deleteSessionCheckpoint } from './sessionCheckpoint';
import {
  buildTranscript,
  InvalidTranscriptCursorError,
  latestTranscriptTurn,
  paginateTranscript,
  paginateTranscriptTurns,
  previewTranscript,
  transcriptPageLimit,
} from './transcript';
import {
  readFreshNormalizedTranscript,
  readNormalizedBlockContent,
  readOrBackfillNormalizedTranscript,
} from './transcriptStore';

const CONTEXT_WINDOW_CACHE_TTL_MS = 5_000;
let contextWindowCache: { value: number; expiresAt: number; settingsVersion: number } | null = null;

async function getActiveContextWindowSize(): Promise<number> {
  const now = Date.now();
  const settingsVersion = getAgentSettingsVersion();
  if (
    contextWindowCache &&
    contextWindowCache.expiresAt > now &&
    contextWindowCache.settingsVersion === settingsVersion
  ) {
    return contextWindowCache.value;
  }

  const settings = await getAgentSettings();
  const model = selectedAgentModelForProvider(settings, config.aiProvider);
  const value = getContextWindowSize(config.aiProvider, model);
  contextWindowCache = {
    value,
    expiresAt: now + CONTEXT_WINDOW_CACHE_TTL_MS,
    settingsVersion,
  };
  return value;
}

async function loadNormalizedOrLegacyTranscript(
  sessionId: string,
  subscriptionId: string,
  transcriptRevision?: string | null,
): Promise<{
  messages: Awaited<ReturnType<typeof readOrBackfillNormalizedTranscript>>;
  historyBytes: number;
}> {
  const normalized = await readFreshNormalizedTranscript(sessionId, transcriptRevision);
  if (normalized) return { messages: normalized, historyBytes: 0 };

  const legacy = await AgentSession.findOne({
    where: { id: sessionId, subscriptionId },
    attributes: ['id', 'historyJson', 'transcriptRevision'],
  });
  if (!legacy) return { messages: [], historyBytes: 0 };
  return {
    messages: await readOrBackfillNormalizedTranscript(
      sessionId,
      legacy.historyJson,
      legacy.transcriptRevision,
    ),
    historyBytes: Buffer.byteLength(legacy.historyJson || '[]', 'utf8'),
  };
}

// Exposes agent session management endpoints that the macOS (and Windows)
// clients can call over plain HTTP before/during a session.
export function createAgentRouter(): express.Router {
  const router = express.Router();

  // Apply auth to every route in this router.
  router.use(authMiddleware);

  // GET /api/agent/sessions
  // Returns the most recent 50 sessions for the authenticated subscription,
  // ordered by last activity descending.
  router.get('/sessions', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    try {
      const [contextWindowSize, sessions] = await Promise.all([
        getActiveContextWindowSize(),
        AgentSession.findAll({
          where: {
            subscriptionId: subscription.id,
            // Hide the internal grouping-cron helper sessions.
            id: { [Op.notLike]: `${GROUPING_SESSION_PREFIX}%` },
          },
          order: [['last_active_at', 'DESC']],
          limit: 50,
          attributes: [
            'id',
            'title',
            'isPinned',
            'platform',
            'turns',
            'totalTokensUsed',
            'promptTokensUsed',
            'completionTokensUsed',
            'lastPromptTokens',
            'groupName',
            'groupDescription',
            'taskInstructionId',
            'taskInstructionHeading',
            'lastActiveAt',
            'createdAt',
            'updatedAt',
          ],
        }),
      ]);

      res.json(
        sessions.map((s) => ({
          id: s.id,
          title: s.title,
          isPinned: s.isPinned,
          platform: s.platform,
          turns: s.turns,
          totalTokensUsed: Number(s.totalTokensUsed),
          promptTokensUsed: Number(s.promptTokensUsed),
          completionTokensUsed: Number(s.completionTokensUsed),
          remainingContextTokens: Math.max(0, contextWindowSize - Number(s.lastPromptTokens)),
          contextBudget: contextWindowSize,
          groupName: s.groupName ?? null,
          groupDescription: s.groupDescription ?? null,
          taskInstructionId: s.taskInstructionId ?? null,
          taskInstructionHeading: s.taskInstructionHeading ?? null,
          lastActiveAt: s.lastActiveAt,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      );
    } catch (err) {
      log.error('Failed to list agent sessions', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/sessions/search?q=...&limit=...
  // Searches persisted user turns server-side so the desktop app does not
  // download one complete transcript per sidebar row. This is the portable
  // phase-one implementation for legacy historyJson sessions; normalized
  // transcript storage can later replace the in-process scan without changing
  // the client contract.
  router.get('/sessions/search', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!query || query.length > 500) {
      res.status(400).json({ error: 'Invalid search query' });
      return;
    }
    const requestedLimit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 30;
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0) {
      res.status(400).json({ error: 'Invalid search limit' });
      return;
    }
    const limit = Math.min(requestedLimit, 50);
    const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);

    try {
      const sessions = await AgentSession.findAll({
        where: {
          subscriptionId: subscription.id,
          id: { [Op.notLike]: `${GROUPING_SESSION_PREFIX}%` },
        },
        order: [['last_active_at', 'DESC']],
        limit: 50,
        attributes: [
          'id',
          'title',
          'groupName',
          'groupDescription',
          'historyJson',
          'transcriptRevision',
        ],
      });

      const results: Array<{ sessionId: string; matchedText: string }> = [];
      for (const session of sessions) {
        const metadata = [session.title, session.groupName, session.groupDescription].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        );
        const metadataHaystack = metadata.join('\n').toLocaleLowerCase();
        let userText = '';
        if (!tokens.every((token) => metadataHaystack.includes(token))) {
          try {
            const normalized = await readFreshNormalizedTranscript(
              session.id,
              session.transcriptRevision,
            );
            const messages = normalized ?? buildTranscript(JSON.parse(session.historyJson || '[]'));
            userText = messages
              .filter((message) => message.role === 'user')
              .map((message) => message.text)
              .join('\n');
          } catch {
            // A malformed legacy history should not make all sidebar search fail.
          }
        }
        const source = [...metadata, userText].filter(Boolean).join('\n');
        const haystack = source.toLocaleLowerCase();
        if (!tokens.every((token) => haystack.includes(token))) continue;

        const matchIndex = tokens.length ? haystack.indexOf(tokens[0]) : 0;
        const snippetStart = Math.max(0, Math.min(source.length, matchIndex) - 60);
        results.push({
          sessionId: session.id,
          matchedText: source.slice(snippetStart, snippetStart + 180).trim(),
        });
        if (results.length >= limit) break;
      }
      res.json({ results });
    } catch (err) {
      log.error('Failed to search agent sessions', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/agent/sessions/:sessionId
  // Updates user-managed sidebar metadata without changing thread identity.
  router.patch('/sessions/:sessionId', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;
    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    const updates: { title?: string; isPinned?: boolean } = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'title')) {
      if (typeof req.body.title !== 'string') {
        res.status(400).json({ error: 'Title must be a string' });
        return;
      }
      const title = req.body.title.trim();
      if (!title || title.length > 255) {
        res.status(400).json({ error: 'Title must be between 1 and 255 characters' });
        return;
      }
      updates.title = title;
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'isPinned')) {
      if (typeof req.body.isPinned !== 'boolean') {
        res.status(400).json({ error: 'isPinned must be a boolean' });
        return;
      }
      updates.isPinned = req.body.isPinned;
    }
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No supported fields provided' });
      return;
    }

    try {
      const session = await AgentSession.findOne({
        where: { id: sessionId, subscriptionId: subscription.id },
      });
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await session.update(updates);
      res.json({ id: session.id, title: session.title, isPinned: session.isPinned });
    } catch (err) {
      log.error('Failed to update agent session', { sessionId, error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /api/agent/sessions/:sessionId
  // Allows the client to explicitly delete a session and its stored history.
  router.delete('/sessions/:sessionId', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    try {
      const deleted = await AgentSession.destroy({
        where: { id: sessionId, subscriptionId: subscription.id },
      });

      if (deleted === 0) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      await deleteSessionCheckpoint(subscription.id, sessionId, log);
      res.status(200).json({ deleted: true });
    } catch (err) {
      log.error('Failed to delete agent session', { sessionId, error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/sessions/:sessionId/context
  // Returns token usage and remaining context budget for a single session.
  router.get('/sessions/:sessionId/context', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    const { sessionId } = req.params;
    // Validate that sessionId is a well-formed non-empty string (no path traversal).
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    try {
      const [contextWindowSize, session] = await Promise.all([
        getActiveContextWindowSize(),
        AgentSession.findOne({
          where: { id: sessionId, subscriptionId: subscription.id },
          attributes: [
            'id',
            'title',
            'turns',
            'totalTokensUsed',
            'promptTokensUsed',
            'completionTokensUsed',
            'lastPromptTokens',
            'lastActiveAt',
          ],
        }),
      ]);

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      res.json({
        id: session.id,
        title: session.title,
        turns: session.turns,
        totalTokensUsed: Number(session.totalTokensUsed),
        promptTokensUsed: Number(session.promptTokensUsed),
        completionTokensUsed: Number(session.completionTokensUsed),
        remainingContextTokens: Math.max(0, contextWindowSize - Number(session.lastPromptTokens)),
        contextBudget: contextWindowSize,
        lastActiveAt: session.lastActiveAt,
      });
    } catch (err) {
      log.error('Failed to fetch agent session context', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/sessions/:sessionId/messages
  // Returns a typed, human-readable transcript of the session history.
  router.get('/sessions/:sessionId/messages', async (req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    const { sessionId } = req.params;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
      res.status(400).json({ error: 'Invalid session ID' });
      return;
    }

    try {
      const isPaginatedRequest = ['view', 'turns', 'before', 'limit'].some(
        (key) => req.query[key] !== undefined,
      );
      const session = await AgentSession.findOne({
        where: { id: sessionId, subscriptionId: subscription.id },
        attributes: isPaginatedRequest
          ? ['id', 'transcriptRevision']
          : ['id', 'transcriptRevision', 'historyJson'],
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const startedAt = performance.now();
      if (!isPaginatedRequest) {
        // Compatibility contract for macOS versions released before cursor
        // pagination and deferred content. Those clients cannot interpret a
        // truncated body or fetch older pages, so an unversioned request must
        // continue to receive the complete, untruncated transcript.
        const raw = JSON.parse(session.historyJson || '[]');
        const legacyResponse = { messages: buildTranscript(raw) };
        log.info?.('Built legacy complete agent transcript', {
          sessionId,
          historyBytes: Buffer.byteLength(session.historyJson || '[]', 'utf8'),
          responseMessages: legacyResponse.messages.length,
          responseBytes: Buffer.byteLength(JSON.stringify(legacyResponse), 'utf8'),
          buildDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
        });
        res.json(legacyResponse);
        return;
      }
      const { messages, historyBytes } = await loadNormalizedOrLegacyTranscript(
        sessionId,
        subscription.id,
        session.transcriptRevision,
      );
      if (req.query.before !== undefined && typeof req.query.before !== 'string') {
        throw new InvalidTranscriptCursorError();
      }
      const before = typeof req.query.before === 'string' ? req.query.before : undefined;
      const view = typeof req.query.view === 'string' ? req.query.view : undefined;
      let page;
      if (view === 'latest-turn') {
        if (before) throw new InvalidTranscriptCursorError();
        page = latestTranscriptTurn(messages, sessionId);
      } else if (view !== undefined) {
        res.status(400).json({ error: 'Invalid transcript view' });
        return;
      } else if (req.query.turns !== undefined) {
        const turns = transcriptPageLimit(req.query.turns);
        if (!before) throw new InvalidTranscriptCursorError();
        page = paginateTranscriptTurns(messages, sessionId, turns, before);
      } else {
        const limit = transcriptPageLimit(req.query.limit);
        page = paginateTranscript(messages, sessionId, limit, before);
      }
      const response = { ...page, messages: previewTranscript(page.messages) };
      const responseBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
      const finalAnswerCharacters = response.messages.reduce((total, message) => {
        const finalAnswers = (message.blocks ?? []).filter((block) => block.kind === 'finalAnswer');
        const finalAnswer = finalAnswers[finalAnswers.length - 1];
        return total + (finalAnswer?.contentLength ?? finalAnswer?.text.length ?? 0);
      }, 0);
      const activityPreviewBytes = response.messages.reduce(
        (total, message) =>
          total +
          (message.blocks ?? [])
            .filter((block) => block.kind !== 'finalAnswer')
            .reduce((sum, block) => sum + Buffer.byteLength(block.text, 'utf8'), 0),
        0,
      );
      log.info?.('Built paged agent transcript', {
        sessionId,
        view: view ?? 'history',
        historyBytes,
        transcriptMessages: messages.length,
        responseMessages: response.messages.length,
        responseBytes,
        finalAnswerCharacters,
        activityPreviewBytes,
        buildDurationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      });
      res.json(response);
    } catch (err) {
      if (err instanceof InvalidTranscriptCursorError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.error('Failed to fetch agent session messages', {
        sessionId,
        error:
          err instanceof Error
            ? { name: err.name, message: err.message, stack: err.stack }
            : String(err),
      });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/agent/sessions/:sessionId/message-blocks/:blockId/content
  // Fetches a complete oversized block only after the user expands or copies
  // it. Ownership is checked on the session query before any history is read.
  router.get(
    '/sessions/:sessionId/message-blocks/:blockId/content',
    async (req, res: Response<any, AuthLocals>) => {
      const { subscription, logger: log } = res.locals;
      const { sessionId, blockId } = req.params;
      if (
        !sessionId ||
        typeof sessionId !== 'string' ||
        sessionId.length > 128 ||
        !blockId ||
        typeof blockId !== 'string' ||
        blockId.length > 128
      ) {
        res.status(400).json({ error: 'Invalid content request' });
        return;
      }
      try {
        const session = await AgentSession.findOne({
          where: { id: sessionId, subscriptionId: subscription.id },
          attributes: ['id', 'transcriptRevision'],
        });
        if (!session) {
          res.status(404).json({ error: 'Session not found' });
          return;
        }
        await loadNormalizedOrLegacyTranscript(
          sessionId,
          subscription.id,
          session.transcriptRevision,
        );
        const text = await readNormalizedBlockContent(sessionId, blockId);
        if (text === null) {
          res.status(404).json({ error: 'Message block not found' });
          return;
        }
        res.json({ text, contentLength: text.length });
      } catch (err) {
        log.error('Failed to fetch agent transcript block', { sessionId, blockId, error: err });
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  // GET /api/agent/groups
  // Returns distinct group names and descriptions for the authenticated
  // subscription. The client uses this to populate the project-path dropdown
  // and to filter the sidebar session list by project.
  router.get('/groups', async (_req, res: Response<any, AuthLocals>) => {
    const { subscription, logger: log } = res.locals;

    try {
      const rows = await AgentSession.findAll({
        where: {
          subscriptionId: subscription.id,
          groupName: { [Op.not]: null },
        },
        attributes: ['groupName', 'groupDescription'],
        group: ['group_name'],
        order: [['groupName', 'ASC']],
      });

      const groups = rows
        .filter((r) => r.groupName)
        .map((r) => ({
          groupName: r.groupName!,
          groupDescription: r.groupDescription ?? null,
        }));

      res.json({ groups });
    } catch (err) {
      log.error('Failed to fetch session groups', { error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
