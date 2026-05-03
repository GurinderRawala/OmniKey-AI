#!/usr/bin/env node
import { Command } from 'commander';
import { onboard } from './onboard';

import { startDaemon } from './daemon';
import { killDaemon } from './killDaemon';
import { removeConfigAndDb } from './removeConfig';
import { statusCmd } from './status';
import { showLogs } from './showLogs';
import { showConfig } from './showConfig';
import { setConfig } from './setConfig';
import { grantBrowserAccess, reopenBrowserDebugProfile } from './grantBrowserAccess';
import { scheduleAdd, scheduleList, scheduleRemove, scheduleRunNow } from './scheduleJob';

const program = new Command();

program
  .name('omnikey')
  .description('Omnikey CLI for onboarding and configuration')
  .version('1.0.0');

program
  .command('onboard')
  .description('Onboard and configure your AI provider')
  .action(async () => {
    await onboard();
  });

program
  .command('daemon')
  .description('Start the Omnikey API backend as a daemon on a specified port')
  .option('--port <port>', 'Port to run the backend on', '7071')
  .action(async (options) => {
    const port = Number(options.port) || 7071;
    await startDaemon(port);
  });

program
  .command('kill-daemon')
  .description('Kill the Omnikey API backend daemon running on a specified port')
  .action(() => {
    killDaemon();
  });

program
  .command('remove-config')
  .description('Remove the omnikey config. Pass --db to also remove the SQLite database.')
  .option('--db', 'Also remove the SQLite database')
  .action((options) => {
    removeConfigAndDb(!!options.db);
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
  .option('--errors', 'Show only error logs')
  .action((options) => {
    const lines = Number(options.lines) || 50;
    const errorsOnly = !!options.errors;
    showLogs(lines, errorsOnly);
  });

program
  .command('config')
  .description('Show the current Omnikey configuration (API keys are masked)')
  .action(() => {
    showConfig();
  });

program
  .command('set <key> <value>')
  .description('Set a single configuration key (e.g. omnikey set OMNIKEY_PORT 8080)')
  .action((key: string, value: string) => {
    setConfig(key, value);
  });

program
  .command('restart-daemon')
  .description('Restart the Omnikey API backend daemon')
  .option('--port <port>', 'Port to run the backend on', '7071')
  .action(async (options) => {
    killDaemon();
    const port = Number(options.port) || 7071;
    await startDaemon(port);
  });

program
  .command('grant-browser-access')
  .description(
    'Set up authenticated browser tab access for web fetch. ' +
      'Detects installed browsers, selects a profile, and configures a remote debugging port (CDP). ' +
      'On macOS you can also choose AppleScript mode instead.',
  )
  .action(async () => {
    await grantBrowserAccess();
  });

program
  .command('browser open')
  .description('Reopen the browser with the Omnikey debug profile')
  .action(async () => {
    await reopenBrowserDebugProfile();
  });

const scheduleCmd = program
  .command('schedule')
  .description('Manage scheduled prompt jobs');

scheduleCmd
  .command('add')
  .description('Add a new scheduled job')
  .action(async () => { await scheduleAdd(); });

scheduleCmd
  .command('list')
  .description('List all scheduled jobs')
  .action(async () => { await scheduleList(); });

scheduleCmd
  .command('remove')
  .description('Remove a scheduled job')
  .action(async () => { await scheduleRemove(); });

scheduleCmd
  .command('run-now <id>')
  .description('Immediately run a scheduled job by ID')
  .action(async (id: string) => { await scheduleRunNow(id); });

program.parseAsync(process.argv);
