#!/usr/bin/env node
import { Command } from 'commander';
import { onboard } from './onboard';

import { startDaemon } from './daemon';
import { killDaemon } from './killDaemon';
import { removeConfigAndDb } from './removeConfig';
import { statusCmd } from './status';
import { showLogs } from './showLogs';

const program = new Command();

program
  .name('omnikey')
  .description('Omnikey CLI for onboarding and configuration')
  .version('1.0.0');

program
  .command('onboard')
  .description('Onboard and configure your OPENAI_API_KEY')
  .option('--open-ai-key <key>', 'Your OpenAI API Key')
  .action(async (options) => {
    await onboard(options.openAiKey || options.openAiKey || options['open-ai-key']);
  });

program
  .command('daemon')
  .description('Start the Omnikey API backend as a daemon on a specified port')
  .option('--port <port>', 'Port to run the backend on', '7071')
  .action((options) => {
    const port = Number(options.port) || 7071;
    startDaemon(port);
  });

program
  .command('kill-daemon')
  .description('Kill the Omnikey API backend daemon running on a specified port')
  .option('--port <port>', 'Port to look for the daemon on', '7071')
  .action((options) => {
    const port = Number(options.port) || 7071;
    killDaemon(port);
  });

program
  .command('remove-config')
  .description(
    'Remove the .omnikey config directory and the SQLite database from your home directory',
  )
  .action(() => {
    removeConfigAndDb();
  });

// Add status command
program
  .command('status')
  .description('Show status of Omnikey daemon (lsof on configured port)')
  .action(statusCmd);

// Add logs command
program
  .command('logs')
  .description('Show logs of the running Omnikey daemon')
  .option('--lines <lines>', 'Number of log lines to show', '50')
  .action((options) => {
    const lines = Number(options.lines) || 50;
    showLogs(lines);
  });

program.parseAsync(process.argv);
