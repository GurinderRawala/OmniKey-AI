import { exec } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import cuid from 'cuid';
import { Op } from 'sequelize';
import { parseExpression } from 'cron-parser';
import { ScheduledJob } from './models/scheduledJob';
import { Subscription } from './models/subscription';
import { logger } from './logger';
import { runAgentTurn } from './agent/agentServer';
import type { AgentSendFn } from './agent/types';

const execAsync = promisify(exec);

const SHELL_SCRIPT_RE = /<shell_script>([\s\S]*?)<\/shell_script>/;
const FINAL_ANSWER_RE = /<final_answer>/;

// Maximum time a single job may run before it is forcibly cancelled.
const JOB_TIMEOUT_MS = 10 * 60 * 1_000;

// Cron jobs get more turns than interactive sessions so multi-step tasks
// (web research → shell commands → final answer) can complete unattended.
const MAX_CRON_TURNS = 20;

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

// Runs the script in the user's login shell so PATH and profile env-vars are
// present — identical to how the desktop apps open a terminal. Writing to a
// temp file avoids quoting/escaping issues with multi-line scripts.
async function runScript(script: string): Promise<{ output: string; isError: boolean }> {
  const isWin = process.platform === 'win32';
  const userHome = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  const userShell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/zsh');

  const ext = isWin ? '.bat' : '.sh';
  const tmpFile = path.join(tmpdir(), `cron_${cuid()}${ext}`);

  try {
    if (isWin) {
      await writeFile(tmpFile, `@echo off\r\n${script}`, 'utf8');
    } else {
      await writeFile(tmpFile, script, { encoding: 'utf8', mode: 0o700 });
    }

    // -l = login shell → sources ~/.zprofile / ~/.bash_profile etc.
    const command = isWin ? `"${tmpFile}"` : `"${userShell}" -l "${tmpFile}"`;

    const { stdout, stderr } = await execAsync(command, {
      timeout: 60_000,
      cwd: userHome,
      env: process.env,
    });
    const combined = [stdout, stderr ? `STDERR:\n${stderr}` : ''].filter(Boolean).join('\n').trim();
    return { output: combined || '(no output)', isError: false };
  } catch (err: any) {
    const combined = [err.stdout ?? '', err.stderr ?? ''].filter(Boolean).join('\n').trim();
    return { output: combined || err.message || 'Command failed', isError: true };
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}

function runCronJob(
  job: ScheduledJob,
  subscription: Subscription,
  sessionId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
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
          logger.error('Cron job: agent returned error.', {
            jobId: job.id,
            content: content.slice(0, 300),
          });
          settle(new Error(`Agent error: ${content.slice(0, 200)}`));
          return;
        }

        const scriptMatch = SHELL_SCRIPT_RE.exec(content);
        if (scriptMatch) {
          const script = scriptMatch[1].trim();
          logger.info('Cron job: executing shell script.', { jobId: job.id });
          const { output, isError } = await runScript(script);
          logger.info('Cron job: shell script finished.', {
            jobId: job.id,
            isError,
            outputLength: output.length,
          });

          if (settled) return;

          runAgentTurn(
            sessionId,
            subscription,
            {
              session_id: sessionId,
              sender: 'user',
              content: output,
              is_terminal_output: true,
              is_error: isError,
            },
            send,
            logger,
            { maxTurns: MAX_CRON_TURNS },
          ).catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
          return;
        }

        if (FINAL_ANSWER_RE.test(content)) {
          logger.info('Cron job: received final answer.', { jobId: job.id });
          settle();
        }
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
      { maxTurns: MAX_CRON_TURNS, isCronJob: true },
    ).catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
  });
}

export async function executeJob(job: ScheduledJob): Promise<void> {
  logger.info('Executing scheduled job.', { jobId: job.id, label: job.label });

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
}
