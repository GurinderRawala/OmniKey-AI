import { Op } from 'sequelize';
import type { Logger } from 'winston';
import { logger } from '../../logger';
import { AgentSession } from '../../models/agentSession';
import { Subscription } from '../../models/subscription';
import { getDefaultTaskTemplateSnapshot } from '../../featureRoutes';
import { estimateHistoryTokens } from '../../ai-client';
import { getAgentPrompt } from '../agentPrompts';
import { getPromptMcpsForSubscription } from '../mcpPromptCache';
import { getAgentSettings } from '../../agentSettingsStore';
import type { SessionState } from '../types';
import { buildTrimmedHistoryForRequest } from './sessionMemory';
import { userHistoryHasProjectContext } from './transcript';

export async function persistSessionToDB(sessionId: string, state: SessionState): Promise<void> {
  try {
    const historyJson = JSON.stringify(state.history);
    const estimatedPromptTokens = estimateHistoryTokens(
      buildTrimmedHistoryForRequest(state, state.activeModel, sessionId),
    );
    await AgentSession.update(
      {
        historyJson,
        turns: state.turns,
        sessionMemory: state.sessionMemory ?? null,
        sessionMemoryHistoryLength: state.sessionMemoryHistoryLength ?? 0,
        sessionMemoryUpdatedAt: state.sessionMemoryUpdatedAt ?? null,
        lastActiveAt: new Date(),
        // Refresh the "context remaining" signal from the request view the next
        // model call will use: full raw history when it fits, compact memory
        // when enabled, and proactive request-local trimming when necessary.
        lastPromptTokens: Math.max(estimatedPromptTokens, state.lastModelPromptTokens ?? 0),
      },
      { where: { id: sessionId } },
    );
  } catch (err) {
    logger.error('Failed to persist agent session to DB', { sessionId, error: err });
  }
}

// Maximum number of sessions stored per subscription. When this limit is
// exceeded the oldest sessions (by lastActiveAt) are pruned automatically.
const SESSION_CAP = 50;

async function enforceSessionCap(subscriptionId: string, log: Logger): Promise<void> {
  try {
    const count = await AgentSession.count({ where: { subscriptionId } });
    if (count <= SESSION_CAP) return;

    const excess = count - SESSION_CAP;
    const oldest = await AgentSession.findAll({
      where: { subscriptionId },
      order: [['last_active_at', 'ASC']],
      limit: excess,
      attributes: ['id'],
    });

    const ids = oldest.map((s) => s.id);
    await AgentSession.destroy({ where: { id: ids } });
    log.info('Pruned oldest agent sessions to enforce cap', {
      subscriptionId,
      pruned: ids.length,
    });
  } catch (err) {
    log.error('Failed to enforce agent session cap', { subscriptionId, error: err });
  }
}

// Fetch the current description + freshness timestamp for an existing group so
// a new session the user explicitly files under that group inherits them
// immediately. groupDescription is denormalised across every session in a group,
// so we read it from the group's most recently active description-bearing row.
async function fetchGroupMeta(
  subscriptionId: string,
  groupName: string,
): Promise<{ groupDescription: string | null; groupDescriptionUpdatedAt: Date | null }> {
  try {
    const row = await AgentSession.findOne({
      where: { subscriptionId, groupName, groupDescription: { [Op.not]: null } },
      order: [['last_active_at', 'DESC']],
      attributes: ['groupDescription', 'groupDescriptionUpdatedAt'],
    });
    return {
      groupDescription: row?.groupDescription ?? null,
      groupDescriptionUpdatedAt: row?.groupDescriptionUpdatedAt ?? null,
    };
  } catch {
    return { groupDescription: null, groupDescriptionUpdatedAt: null };
  }
}

export async function getOrCreateSession(
  sessionId: string,
  subscription: Subscription,
  platform: string | undefined,
  log: Logger,
  isCronJob = false,
  groupName?: string,
): Promise<{
  sessionState: SessionState;
  hasStoredPrompt: boolean;
  contextExists: boolean;
  groupName: string | null;
}> {
  // 1. Try to resume from a persisted DB record.
  try {
    const dbSession = await AgentSession.findOne({
      where: { id: sessionId, subscriptionId: subscription.id },
    });

    if (dbSession) {
      const history = JSON.parse(dbSession.historyJson) as SessionState['history'];
      const entry: SessionState = {
        subscription,
        history,
        turns: dbSession.turns,
        groupName: dbSession.groupName ?? null,
        sessionMemory: dbSession.sessionMemory ?? null,
        sessionMemoryHistoryLength: dbSession.sessionMemoryHistoryLength ?? 0,
        sessionMemoryUpdatedAt: dbSession.sessionMemoryUpdatedAt ?? null,
        groupLocked: dbSession.groupLocked ?? false,
      };
      log.info('Resumed agent session from DB', {
        sessionId,
        subscriptionId: subscription.id,
        turns: entry.turns,
      });
      return {
        sessionState: entry,
        hasStoredPrompt: history
          .filter((h) => h.role === 'user')
          .some(
            (h) => typeof h.content === 'string' && h.content.includes('<stored_instructions>'),
          ),
        contextExists: userHistoryHasProjectContext(history),
        groupName: dbSession.groupName ?? null,
      };
    }
  } catch (err) {
    log.error('Failed to load agent session from DB; creating a fresh one', {
      sessionId,
      error: err,
    });
  }

  // 2. Create a brand-new session and persist it to the DB.
  // Snapshot the currently-default task template alongside the prompt so we
  // can persist its id + heading on the session row. This binds the "locked
  // task instruction" chip in the desktop clients to THIS session for its
  // lifetime, regardless of whether the user later reassigns their default
  // template in a different chat.
  const templateSnapshot = await getDefaultTaskTemplateSnapshot(log, subscription).catch((err) => {
    log.error('Failed to load default task template snapshot for new agent session', {
      error: err,
    });
    return null;
  });
  const prompt = templateSnapshot?.instructions ?? '';

  const installedMcps = await getPromptMcpsForSubscription(subscription.id, log);

  const agentSettings = await getAgentSettings();
  const systemPrompt = getAgentPrompt(
    platform,
    !isCronJob && !!prompt,
    installedMcps,
    agentSettings,
  );

  const entry: SessionState = {
    subscription,
    history: [
      {
        role: 'system',
        content: systemPrompt,
      },
      ...(prompt && !isCronJob
        ? [
            {
              role: 'user' as const,
              content: `<stored_instructions>
# Stored Instructions

"""
${prompt}
"""
</stored_instructions>`,
            },
          ]
        : []),
    ],
    turns: 0,
    // A group name supplied at session start is a deliberate USER choice, so
    // lock it: this session is never (re)classified and the cron never moves
    // it. When no group is supplied the session stays unlocked and is
    // classified once at the end of its first turn.
    groupName: groupName ?? null,
    sessionMemory: null,
    sessionMemoryHistoryLength: 0,
    sessionMemoryUpdatedAt: null,
    groupLocked: Boolean(groupName),
  };

  // When the user filed this session under an existing group, inherit that
  // group's current description + freshness timestamp so the new row is
  // complete immediately.
  const groupMeta = groupName
    ? await fetchGroupMeta(subscription.id, groupName)
    : { groupDescription: null, groupDescriptionUpdatedAt: null };

  // Persist immediately so that GET /sessions picks it up right away.
  try {
    const [dbSession, created] = await AgentSession.findOrCreate({
      where: { id: sessionId, subscriptionId: subscription.id },
      defaults: {
        id: sessionId,
        subscriptionId: subscription.id,
        title: 'New Session',
        platform: platform ?? null,
        historyJson: JSON.stringify(entry.history),
        turns: 0,
        lastActiveAt: new Date(),
        groupName: groupName ?? null,
        groupLocked: Boolean(groupName),
        groupDescription: groupMeta.groupDescription,
        groupDescriptionUpdatedAt: groupMeta.groupDescriptionUpdatedAt,
        sessionMemory: null,
        sessionMemoryHistoryLength: 0,
        sessionMemoryUpdatedAt: null,
        taskInstructionId: templateSnapshot?.id ?? null,
        taskInstructionHeading: templateSnapshot?.heading ?? null,
      },
    });

    if (!created) {
      const history = JSON.parse(dbSession.historyJson || '[]') as SessionState['history'];

      // If the row exists without a group but the caller supplied one, adopt
      // and lock it now, inheriting the group's current description + freshness
      // timestamp.
      const adoptUserGroup = Boolean(groupName) && !dbSession.groupName;
      if (adoptUserGroup) {
        await AgentSession.update(
          {
            groupName: groupName!,
            groupLocked: true,
            groupDescription: groupMeta.groupDescription,
            groupDescriptionUpdatedAt: groupMeta.groupDescriptionUpdatedAt,
          },
          { where: { id: sessionId } },
        );
      }
      const effectiveGroupName = dbSession.groupName ?? (adoptUserGroup ? groupName! : null);
      const effectiveGroupLocked = (dbSession.groupLocked ?? false) ? true : adoptUserGroup;

      const existingEntry: SessionState = {
        subscription,
        history,
        turns: dbSession.turns,
        groupName: effectiveGroupName,
        sessionMemory: dbSession.sessionMemory ?? null,
        sessionMemoryHistoryLength: dbSession.sessionMemoryHistoryLength ?? 0,
        sessionMemoryUpdatedAt: dbSession.sessionMemoryUpdatedAt ?? null,
        groupLocked: effectiveGroupLocked,
      };

      log.info('Reused existing agent session row from DB during create path', {
        sessionId,
        subscriptionId: subscription.id,
        turns: existingEntry.turns,
      });

      return {
        sessionState: existingEntry,
        hasStoredPrompt: history
          .filter((h) => h.role === 'user')
          .some(
            (h) => typeof h.content === 'string' && h.content.includes('<stored_instructions>'),
          ),
        contextExists: userHistoryHasProjectContext(history),
        groupName: effectiveGroupName,
      };
    }

    // Prune oldest sessions after each creation so the cap is always respected.
    void enforceSessionCap(subscription.id, log);
  } catch (err) {
    log.error('Failed to create agent session in DB', { sessionId, error: err });
  }

  log.info('Created new agent session', {
    sessionId,
    subscriptionId: subscription.id,
    hasCustomPrompt: Boolean(prompt),
  });
  return {
    sessionState: entry,
    hasStoredPrompt: !!prompt,
    // Brand-new session: history starts with at most the stored-instructions
    // turn, so no project context exists yet.
    contextExists: false,
    groupName: null,
  };
}
