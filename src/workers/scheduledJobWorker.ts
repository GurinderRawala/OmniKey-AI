import { ScheduledJob } from '../models/scheduledJob';
import { executeJob, startScheduledJobExecutor } from '../scheduledJobExecutor';
import { logger } from '../logger';
import { bootstrapWorker } from './workerBootstrap';

void bootstrapWorker(
  'scheduledJobWorker',
  () => {
    startScheduledJobExecutor();
  },
  {
    onMessage: async (msg) => {
      if (msg.type !== 'runJob') return;

      const job = await ScheduledJob.findByPk(msg.jobId);
      if (!job) {
        logger.warn('runJob: scheduled job not found in worker.', { jobId: msg.jobId });
        return;
      }

      logger.info('runJob: executing scheduled job inside worker.', {
        jobId: job.id,
        label: job.label,
      });
      // executeJob already guards against concurrent runs of the same jobId
      // (via RUNNING_JOB_IDS) and updates lastRunAt / nextRunAt itself, so we
      // just fire-and-forget here and let errors surface through its own
      // logger.error call.
      await executeJob(job).catch((err) => {
        logger.error('runJob: execution failed.', { jobId: job.id, error: err });
      });
    },
  },
);
