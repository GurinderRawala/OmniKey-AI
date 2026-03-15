#!/usr/bin/env node
import { Command } from 'commander';
import { onboard } from './onboard';

import { startDaemon } from './daemon';
import { killDaemon } from './killDaemon';

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
  .option('--port <port>', 'Port to run the backend on', '8080')
  .action((options) => {
    const port = Number(options.port) || 8080;
    startDaemon(port);
  });

program
  .command('kill-daemon')
  .description('Kill the Omnikey API backend daemon running on a specified port')
  .option('--port <port>', 'Port to look for the daemon on', '8080')
  .action((options) => {
    const port = Number(options.port) || 8080;
    killDaemon(port);
  });

program.parseAsync(process.argv);
