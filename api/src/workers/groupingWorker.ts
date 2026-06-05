import { bootstrapWorker } from './workerBootstrap';
import { startGroupingCronJob } from '../agent/sessionGrouping';

void bootstrapWorker('groupingWorker', () => {
  startGroupingCronJob();
});
