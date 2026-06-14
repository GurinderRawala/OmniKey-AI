import cuid from 'cuid';
import { Op } from 'sequelize';
import { parseExpression } from 'cron-parser';
import { ScheduledJob } from './models/scheduledJob';
import { Subscription } from './models/subscription';
import { logger } from './logger';
import { runAgentTurn } from './agent/agentServer';
import type { AgentSendFn } from './agent/types';

const FINAL_ANSWER_RE = /<final_answer>/;

// Maximum time a single job may run before it is forcibly cancelled.
const JOB_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_AGENT_ERROR_RECOVERY_ATTEMPTS = 4;

// Single-process guard to avoid running the same job concurrently.
const RUNNING_JOB_IDS = new Set<string>();

export function computeNextRunAt(cronExpression: string | null, runAt: Date | null): Date | null {
  if (cronExpression) {
    try {
      const interval = parseExpression(cronExpression, { currentDate: new Date() });
      return interval.next().toDate();
    } catch {
      return null;
    }
  }
  if (runAt && runAt > new Date()) {
    return runAt;
  }
  return null;
}

export function startScheduledJobExecutor(): void {
  logger.info('Scheduled job executor started.');
  void executeDueJobs();
  setInterval(() => void executeDueJobs(), 60_000);
}

async function executeDueJobs(): Promise<void> {
  try {
    const now = new Date();
    const dueJobs = await ScheduledJob.findAll({
      where: {
        nextRunAt: { [Op.lte]: now },
        isActive: true,
      },
    });

    if (dueJobs.length > 0) {
      logger.info(`Executing ${dueJobs.length} due scheduled job(s).`);
    }

    for (const job of dueJobs) {
      void executeJob(job).catch((err) => {
        logger.error('Scheduled job execution failed.', { jobId: job.id, error: err });
      });
    }
  } catch (err) {
    logger.error('Error polling for due scheduled jobs.', { error: err });
  }
}

function runCronJob(
  job: ScheduledJob,
  subscription: Subscription,
  sessionId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let agentErrorRecoveryAttempts = 0;
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      err ? reject(err) : resolve();
    };

    const timeoutHandle = setTimeout(
      () =>
        settle(new Error(`Cron job ${job.id} timed out after ${JOB_TIMEOUT_MS / 60_000} minutes`)),
      JOB_TIMEOUT_MS,
    );

    const send: AgentSendFn = (msg) => {
      if (settled) return;

      void (async () => {
        const content = msg.content ?? '';

        if (msg.is_error) {
          agentErrorRecoveryAttempts += 1;
          logger.warn('Cron job: agent returned error; attempting recovery.', {
            jobId: job.id,
            attempt: agentErrorRecoveryAttempts,
            content: content.slice(0, 300),
          });

          const shouldFailNow =
            FINAL_ANSWER_RE.test(content) ||
            agentErrorRecoveryAttempts > MAX_AGENT_ERROR_RECOVERY_ATTEMPTS;

          if (shouldFailNow) {
            settle(new Error(`Agent error: ${content.slice(0, 200)}`));
            return;
          }

          runAgentTurn(
            sessionId,
            subscription,
            {
              session_id: sessionId,
              sender: 'user',
              content:
                `Agent turn failed while processing this cron job. ` +
                `Recover from the latest state and either call the shell_script ` +
                `tool or return a <final_answer>.\n\n` +
                `Error details:\n${content}`,
              is_error: true,
            },
            send,
            logger,
            { isCronJob: true },
          ).catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
          return;
        }

        // shell_script now runs as a native tool inside the agent's tool loop
        // (executed server-side for cron jobs — see agentServer.ts). The cron
        // executor no longer parses or runs <shell_script> tags itself; it only
        // observes progress notifications and waits for the final answer.
        if (msg.is_web_call || msg.is_image_rendering || msg.is_mcp_call) {
          logger.debug('Cron job: received progress notification; waiting for next message.', {
            jobId: job.id,
            isWebCall: !!msg.is_web_call,
            isImageRendering: !!msg.is_image_rendering,
            isMcpCall: !!msg.is_mcp_call,
          });
          return;
        }

        if (FINAL_ANSWER_RE.test(content)) {
          logger.info('Cron job: received final answer.', { jobId: job.id });
          settle();
          return;
        }

        if (content.trim()) {
          logger.warn('Cron job: received untagged agent content; treating as final answer.', {
            jobId: job.id,
            content: content.slice(0, 300),
          });
          settle();
          return;
        }

        settle(new Error('Agent returned empty response with no shell script or final answer.'));
      })();
    };

    runAgentTurn(
      sessionId,
      subscription,
      {
        session_id: sessionId,
        sender: 'user',
        content: job.prompt,
        platform: job.platform ?? undefined,
      },
      send,
      logger,
      { isCronJob: true },
    ).catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
  });
}

export async function executeJob(job: ScheduledJob): Promise<void> {
  if (RUNNING_JOB_IDS.has(job.id)) {
    logger.warn('Scheduled job is already running; skipping duplicate execution.', {
      jobId: job.id,
      label: job.label,
    });
    return;
  }

  RUNNING_JOB_IDS.add(job.id);

  logger.info('Executing scheduled job.', { jobId: job.id, label: job.label });

  try {
    const subscription = await Subscription.findByPk(job.subscriptionId);
    if (!subscription) {
      logger.error('Subscription not found for scheduled job; skipping.', {
        jobId: job.id,
        subscriptionId: job.subscriptionId,
      });
      return;
    }

    const sessionId = cuid();

    try {
      await runCronJob(job, subscription, sessionId);
      logger.info('Scheduled job completed.', { jobId: job.id, label: job.label });
    } catch (err) {
      logger.error('Scheduled job failed.', { jobId: job.id, label: job.label, error: err });
      // Fall through — always update lastRunAt so the next poll does not re-run immediately.
    }

    const now = new Date();
    if (job.cronExpression) {
      await job.update({
        lastRunAt: now,
        nextRunAt: computeNextRunAt(job.cronExpression, null),
        lastRunSessionId: sessionId,
      });
    } else {
      await job.update({
        lastRunAt: now,
        isActive: false,
        nextRunAt: null,
        lastRunSessionId: sessionId,
      });
    }
  } finally {
    RUNNING_JOB_IDS.delete(job.id);
  }
}
