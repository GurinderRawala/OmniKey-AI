import express from 'express';
import zod from 'zod';
import { authMiddleware } from './authMiddleware';
import { ScheduledJob } from './models/scheduledJob';
import { computeNextRunAt, executeJob } from './scheduledJobExecutor';

const CRON_REGEX = /^(\S+\s){4}\S+$/;

const jobSchema = zod.object({
  label: zod.string().min(1).max(200),
  prompt: zod.string().min(1),
  cronExpression: zod.string().regex(CRON_REGEX, 'Invalid cron expression (must be 5 fields)').optional(),
  runAt: zod.string().optional(),
  isActive: zod.boolean().optional(),
  sessionId: zod.string().nullable().optional(),
  platform: zod.string().optional(),
});

function formatJob(job: ScheduledJob) {
  return {
    id: job.id,
    label: job.label,
    prompt: job.prompt,
    cronExpression: job.cronExpression,
    runAt: job.runAt,
    isActive: job.isActive,
    lastRunAt: job.lastRunAt,
    nextRunAt: job.nextRunAt,
    sessionId: job.sessionId,
    lastRunSessionId: job.lastRunSessionId,
    platform: job.platform,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function scheduledJobRouter(): express.Router {
  const router = express.Router();

  router.get('/', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    try {
      const jobs = await ScheduledJob.findAll({
        where: { subscriptionId: subscription.id },
        order: [['next_run_at', 'ASC NULLS LAST']],
      });
      res.json({ jobs: jobs.map(formatJob) });
    } catch (err) {
      logger.error('Error retrieving scheduled jobs.', { error: err });
      res.status(500).json({ error: 'Failed to retrieve scheduled jobs.' });
    }
  });

  router.post('/', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    try {
      const parsed = jobSchema.parse(req.body);

      const hasCron = !!parsed.cronExpression;
      const hasRunAt = !!parsed.runAt;

      if (!hasCron && !hasRunAt) {
        return res.status(400).json({ error: 'Either cronExpression or runAt is required.' });
      }
      if (hasCron && hasRunAt) {
        return res.status(400).json({ error: 'Provide either cronExpression or runAt, not both.' });
      }

      let runAt: Date | null = null;
      if (hasRunAt) {
        runAt = new Date(parsed.runAt!);
        if (isNaN(runAt.getTime())) {
          return res.status(400).json({ error: 'Invalid runAt date.' });
        }
        if (runAt <= new Date()) {
          return res.status(400).json({ error: 'runAt must be in the future.' });
        }
      }

      const nextRunAt = computeNextRunAt(parsed.cronExpression ?? null, runAt);

      const job = await ScheduledJob.create({
        subscriptionId: subscription.id,
        label: parsed.label,
        prompt: parsed.prompt,
        cronExpression: parsed.cronExpression ?? null,
        runAt,
        isActive: parsed.isActive ?? true,
        nextRunAt,
        sessionId: parsed.sessionId ?? null,
        platform: parsed.platform ?? null,
      });

      res.status(201).json(formatJob(job));
    } catch (err) {
      logger.error('Error creating scheduled job.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid job data.' });
      }
      res.status(500).json({ error: 'Failed to create scheduled job.' });
    }
  });

  router.put('/:id', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;
    try {
      const parsed = jobSchema.partial().parse(req.body);

      const job = await ScheduledJob.findOne({
        where: { id, subscriptionId: subscription.id },
      });

      if (!job) {
        return res.status(404).json({ error: 'Scheduled job not found.' });
      }

      const cronExpression =
        parsed.cronExpression !== undefined ? parsed.cronExpression ?? null : job.cronExpression;

      let runAt = job.runAt;
      if (parsed.runAt !== undefined) {
        if (parsed.runAt) {
          runAt = new Date(parsed.runAt);
          if (isNaN(runAt.getTime())) {
            return res.status(400).json({ error: 'Invalid runAt date.' });
          }
          if (runAt <= new Date()) {
            return res.status(400).json({ error: 'runAt must be in the future.' });
          }
        } else {
          runAt = null;
        }
      }

      const nextRunAt = computeNextRunAt(cronExpression, runAt);

      await job.update({
        label: parsed.label ?? job.label,
        prompt: parsed.prompt ?? job.prompt,
        cronExpression,
        runAt,
        isActive: parsed.isActive ?? job.isActive,
        nextRunAt,
        sessionId: parsed.sessionId !== undefined ? (parsed.sessionId ?? null) : job.sessionId,
        platform: parsed.platform ?? job.platform,
      });

      res.json(formatJob(job));
    } catch (err) {
      logger.error('Error updating scheduled job.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid job data.' });
      }
      res.status(500).json({ error: 'Failed to update scheduled job.' });
    }
  });

  router.delete('/:id', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;
    try {
      const job = await ScheduledJob.findOne({
        where: { id, subscriptionId: subscription.id },
      });

      if (!job) {
        return res.status(404).json({ error: 'Scheduled job not found.' });
      }

      await job.destroy();
      res.status(204).send();
    } catch (err) {
      logger.error('Error deleting scheduled job.', { error: err });
      res.status(500).json({ error: 'Failed to delete scheduled job.' });
    }
  });

  router.post('/:id/run-now', authMiddleware, async (req, res) => {
    const { logger, subscription } = res.locals;
    const { id } = req.params;
    try {
      const job = await ScheduledJob.findOne({
        where: { id, subscriptionId: subscription.id },
      });

      if (!job) {
        return res.status(404).json({ error: 'Scheduled job not found.' });
      }

      void executeJob(job).catch((err) => {
        logger.error('run-now execution failed.', { jobId: job.id, error: err });
      });

      res.json(formatJob(job));
    } catch (err) {
      logger.error('Error triggering scheduled job.', { error: err });
      res.status(500).json({ error: 'Failed to trigger scheduled job.' });
    }
  });

  return router;
}
