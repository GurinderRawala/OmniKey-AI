import express, { Response } from 'express';
import { Op } from 'sequelize';
import { config } from '../../config';
import { AgentSession } from '../../models/agentSession';
import { authMiddleware, AuthLocals } from '../../authMiddleware';
import { getContextWindowSize } from '../../ai-client';
import { getAgentSettings, selectedAgentModelForProvider } from '../../agentSettingsStore';
import { GROUPING_SESSION_PREFIX } from '../sessionGrouping';
import { buildTranscript, RawHistoryMessage } from './transcript';

async function getActiveContextWindowSize(): Promise<number> {
  const settings = await getAgentSettings();
  const model = selectedAgentModelForProvider(settings, config.aiProvider);
  return getContextWindowSize(config.aiProvider, model);
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
      const session = await AgentSession.findOne({
        where: { id: sessionId, subscriptionId: subscription.id },
        attributes: ['id', 'historyJson'],
      });

      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const raw: RawHistoryMessage[] = JSON.parse(session.historyJson || '[]');
      const messages = buildTranscript(raw);

      res.json({ messages });
    } catch (err) {
      log.error('Failed to fetch agent session messages', { sessionId, error: err });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

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
