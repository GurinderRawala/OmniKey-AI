import axios from 'axios';
import inquirer from 'inquirer';
import readline from 'node:readline';
import { readConfig, getPort } from './utils';

interface ScheduledJobDto {
  id: string;
  label: string;
  prompt: string;
  cronExpression?: string | null;
  runAt?: string | null;
  isActive: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  sessionId?: string | null;
}

async function getJwt(): Promise<string> {
  const config = readConfig();
  const port = getPort();
  const licenseKey = config.OMNIKEY_LICENSE_KEY || '';
  const baseUrl = `http://localhost:${port}`;
  const res = await axios.post(
    `${baseUrl}/api/subscription/activate`,
    { licenseKey },
    {
      timeout: 10_000,
    },
  );
  return (res.data as { token: string }).token;
}

function getBaseUrl(): string {
  const port = getPort();
  return `http://localhost:${port}`;
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const token = await getJwt();
    return { Authorization: `Bearer ${token}` };
  } catch {
    // Self-hosted: try without auth
    return {};
  }
}

async function readMultilinePrompt(): Promise<string> {
  console.log('\nEnter prompt text below.');
  console.log('Type END on a new line when finished.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const lines: string[] = [];

  return new Promise((resolve) => {
    const askLine = () => {
      rl.question('', (line) => {
        if (line.trim() === 'END') {
          rl.close();
          resolve(lines.join('\n').trim());
          return;
        }

        lines.push(line);
        askLine();
      });
    };

    askLine();
  });
}

export async function scheduleAdd(): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: 'input',
      name: 'label',
      message: 'Job label (e.g. "Daily standup summary"):',
      validate: (v: string) => v.trim().length > 0 || 'Label is required',
    },
    {
      type: 'list',
      name: 'scheduleType',
      message: 'Schedule type:',
      choices: [
        { name: 'Recurring (cron expression)', value: 'cron' },
        { name: 'One-time (specific date/time)', value: 'once' },
      ],
    },
  ]);

  const promptText = await readMultilinePrompt();
  if (!promptText) {
    console.error('Prompt is required.');
    return;
  }

  let cronExpression: string | undefined;
  let runAt: string | undefined;

  if (answers.scheduleType === 'cron') {
    const presets = [
      { name: 'Every weekday at 9 AM  (0 9 * * 1-5)', value: '0 9 * * 1-5' },
      { name: 'Every day at midnight  (0 0 * * *)', value: '0 0 * * *' },
      { name: 'Every hour             (0 * * * *)', value: '0 * * * *' },
      { name: 'Every Monday at 8 AM   (0 8 * * 1)', value: '0 8 * * 1' },
      { name: 'Custom cron expression', value: '__custom__' },
    ];

    const { preset } = await inquirer.prompt([
      {
        type: 'list',
        name: 'preset',
        message: 'Choose a schedule preset or enter custom:',
        choices: presets,
      },
    ]);

    if (preset === '__custom__') {
      const { customCron } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customCron',
          message: 'Enter cron expression (5 fields, e.g. "0 9 * * 1-5"):',
          validate: (v: string) =>
            /^(\S+\s){4}\S+$/.test(v.trim()) || 'Invalid cron (must be 5 space-separated fields)',
        },
      ]);
      cronExpression = customCron.trim();
    } else {
      cronExpression = preset;
    }
  } else {
    const { dateStr, timeStr } = await inquirer.prompt([
      {
        type: 'input',
        name: 'dateStr',
        message: 'Date (YYYY-MM-DD):',
        validate: (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) || 'Use YYYY-MM-DD format',
      },
      {
        type: 'input',
        name: 'timeStr',
        message: 'Time (HH:MM, 24-hour local time):',
        validate: (v: string) => /^\d{2}:\d{2}$/.test(v.trim()) || 'Use HH:MM format',
      },
    ]);
    const dt = new Date(`${dateStr.trim()}T${timeStr.trim()}:00`);
    if (isNaN(dt.getTime())) {
      console.error('Invalid date/time combination.');
      return;
    }
    if (dt <= new Date()) {
      console.error('Date/time must be in the future.');
      return;
    }
    runAt = dt.toISOString();
  }

  try {
    const headers = await authHeaders();
    const res = await axios.post<ScheduledJobDto>(
      `${getBaseUrl()}/api/scheduled-jobs`,
      {
        label: answers.label.trim(),
        prompt: promptText,
        cronExpression,
        runAt,
      },
      { headers, timeout: 15_000 },
    );
    const job = res.data;
    console.log('\nJob created successfully:');
    printJobRow(job);
    if (job.nextRunAt) {
      console.log(`  Next run: ${new Date(job.nextRunAt).toLocaleString()}`);
    }
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error creating job: ${msg}`);
  }
}

export async function scheduleList(): Promise<void> {
  try {
    const headers = await authHeaders();
    const res = await axios.get<{ jobs: ScheduledJobDto[] }>(`${getBaseUrl()}/api/scheduled-jobs`, {
      headers,
      timeout: 10_000,
    });
    const { jobs } = res.data;
    if (jobs.length === 0) {
      console.log('No scheduled jobs found.');
      return;
    }
    console.log('\nScheduled Jobs:');
    console.log('─'.repeat(90));
    console.log(
      padRight('ID', 28) +
        padRight('Label', 24) +
        padRight('Schedule', 18) +
        padRight('Next Run', 22) +
        'Status',
    );
    console.log('─'.repeat(90));
    for (const job of jobs) {
      const schedule =
        job.cronExpression ?? (job.runAt ? `Once: ${new Date(job.runAt).toLocaleString()}` : '—');
      const nextRun = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : '—';
      const status = job.isActive ? 'Active' : 'Inactive';
      console.log(
        padRight(job.id.slice(0, 26), 28) +
          padRight(job.label.slice(0, 22), 24) +
          padRight(schedule.slice(0, 16), 18) +
          padRight(nextRun.slice(0, 20), 22) +
          status,
      );
    }
    console.log('─'.repeat(90));
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error fetching jobs: ${msg}`);
  }
}

export async function scheduleRemove(): Promise<void> {
  try {
    const headers = await authHeaders();
    const res = await axios.get<{ jobs: ScheduledJobDto[] }>(`${getBaseUrl()}/api/scheduled-jobs`, {
      headers,
      timeout: 10_000,
    });
    const { jobs } = res.data;
    if (jobs.length === 0) {
      console.log('No scheduled jobs to remove.');
      return;
    }

    const { jobId } = await inquirer.prompt([
      {
        type: 'list',
        name: 'jobId',
        message: 'Select a job to remove:',
        choices: jobs.map((j) => ({
          name: `${j.label}  [${j.cronExpression ?? 'one-time'}]  ${j.isActive ? '✓' : '✗'}`,
          value: j.id,
        })),
      },
    ]);

    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to delete this job?',
        default: false,
      },
    ]);

    if (!confirm) {
      console.log('Aborted.');
      return;
    }

    await axios.delete(`${getBaseUrl()}/api/scheduled-jobs/${jobId}`, {
      headers,
      timeout: 10_000,
    });
    console.log('Job deleted.');
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error removing job: ${msg}`);
  }
}

export async function scheduleRunNow(id: string): Promise<void> {
  try {
    const headers = await authHeaders();
    await axios.post(
      `${getBaseUrl()}/api/scheduled-jobs/${id}/run-now`,
      {},
      {
        headers,
        timeout: 10_000,
      },
    );
    console.log(`Job ${id} triggered.`);
  } catch (err: any) {
    const msg = err.response?.data?.error ?? err.message;
    console.error(`Error triggering job: ${msg}`);
  }
}

function printJobRow(job: ScheduledJobDto): void {
  console.log(`  ID:       ${job.id}`);
  console.log(`  Label:    ${job.label}`);
  console.log(
    `  Schedule: ${job.cronExpression ?? (job.runAt ? `Once at ${new Date(job.runAt).toLocaleString()}` : '—')}`,
  );
  console.log(`  Active:   ${job.isActive}`);
}

function padRight(str: string, width: number): string {
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}
