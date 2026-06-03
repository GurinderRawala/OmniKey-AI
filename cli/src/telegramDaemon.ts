import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, execFileSync, spawnSync } from 'child_process';
import inquirer from 'inquirer';
import { isWindows, getHomeDir, getConfigDir, initLogFiles } from './utils';
import { ensureTelegramConfig } from './telegramClient';

const LABEL = `com.${os.userInfo().username}.telegram`;
const PLIST_NAME = `${LABEL}.plist`;
const WINDOWS_SERVICE_NAME = 'OmnikeyTelegram';

// At runtime __dirname is cli/dist/. The bundled telegram app is copied into
// cli/telegram-client-dist/ by the build:telegram-client script, so one level
// up from dist/ lands at the package root, then into the bundle directory.
// This matches resolveBundleRoot() in telegramClient.ts and works correctly
// both in the monorepo and after `npm install -g omnikey-cli`.
const TELEGRAM_BOT_ROOT = path.resolve(__dirname, '..', 'telegram-client-dist');
const ENTRY_POINT = path.join(TELEGRAM_BOT_ROOT, 'dist', 'index.js');

const HOME = getHomeDir();

// macOS — launchd LaunchAgent paths
const LAUNCH_AGENTS_DIR = path.join(HOME, 'Library', 'LaunchAgents');
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, PLIST_NAME);
const MAC_LOG_DIR = path.join(HOME, 'Library', 'Logs', 'telegram');
const MAC_STDOUT_LOG = path.join(MAC_LOG_DIR, 'out.log');
const MAC_STDERR_LOG = path.join(MAC_LOG_DIR, 'err.log');

// Windows — store logs alongside the rest of the CLI config
const WIN_CONFIG_DIR = path.join(getConfigDir(), 'telegram');
const WIN_LOG_PATH = path.join(WIN_CONFIG_DIR, 'daemon.log');
const WIN_ERROR_LOG_PATH = path.join(WIN_CONFIG_DIR, 'daemon-error.log');

const FORWARD_ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'PORT', 'LOG_LEVEL'];

// ─── Shared helpers ───────────────────────────────────────────────────────────

function ensureBuilt(): void {
  if (fs.existsSync(ENTRY_POINT)) return;
  console.error(
    `Bundled telegram entry point not found at ${ENTRY_POINT}.\n` +
      'Reinstall omnikey-cli to restore the bundle: npm install -g omnikey-cli',
  );
  process.exit(1);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── macOS (launchd) ─────────────────────────────────────────────────────────

function buildPlist(): string {
  const envEntries: string[] = [
    `<key>PATH</key><string>${escapeXml(process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin')}</string>`,
    `<key>HOME</key><string>${escapeXml(HOME)}</string>`,
  ];
  for (const key of FORWARD_ENV_KEYS) {
    const value = process.env[key];
    if (value) envEntries.push(`<key>${key}</key><string>${escapeXml(value)}</string>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(process.execPath)}</string>
    <string>${escapeXml(ENTRY_POINT)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(TELEGRAM_BOT_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    ${envEntries.join('\n    ')}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(MAC_STDOUT_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(MAC_STDERR_LOG)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

function unloadIfLoaded(): void {
  if (!fs.existsSync(PLIST_PATH)) return;
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'pipe' });
  } catch {
    /* not loaded — fine */
  }
}

function startMacOS(): void {
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.mkdirSync(MAC_LOG_DIR, { recursive: true });
  for (const f of [MAC_STDOUT_LOG, MAC_STDERR_LOG]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, '');
  }
  fs.writeFileSync(PLIST_PATH, buildPlist(), 'utf-8');
  console.log(`Wrote LaunchAgent: ${PLIST_PATH}`);
  unloadIfLoaded();
  try {
    execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'inherit' });
  } catch (e) {
    console.error('launchctl load failed:', (e as Error).message);
    process.exit(1);
  }
  console.log(`Loaded ${LABEL}. The service will run at login and on reboot.`);
  console.log(`stdout: ${MAC_STDOUT_LOG}`);
  console.log(`stderr: ${MAC_STDERR_LOG}`);
}

function stopMacOS(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`No LaunchAgent at ${PLIST_PATH}. Nothing to stop.`);
    return;
  }
  unloadIfLoaded();
  console.log(`Unloaded ${LABEL}.`);
}

function statusMacOS(): void {
  if (!fs.existsSync(PLIST_PATH)) {
    console.log(`Not installed (${PLIST_PATH} missing).`);
    return;
  }
  console.log(`Plist: ${PLIST_PATH}`);
  try {
    const out = execSync(`launchctl list | grep ${LABEL} || true`).toString();
    if (out.trim()) {
      console.log('launchctl list:');
      console.log(out.trim());
    } else {
      console.log('Not currently loaded by launchd.');
    }
  } catch (e) {
    console.warn('launchctl list failed:', (e as Error).message);
  }
  const port = process.env.PORT || '6666';
  try {
    const lsof = execSync(`lsof -i :${port} -sTCP:LISTEN -t || true`).toString().trim();
    console.log(
      lsof
        ? `Listening on port ${port} (pid ${lsof.split('\n')[0]}).`
        : `Nothing listening on port ${port}.`,
    );
  } catch {
    /* ignore */
  }
}

function logsMacOS(): void {
  if (!fs.existsSync(MAC_STDOUT_LOG) && !fs.existsSync(MAC_STDERR_LOG)) {
    console.log('No log files yet. Start the daemon first.');
    return;
  }
  console.log(`Tailing ${MAC_STDOUT_LOG} and ${MAC_STDERR_LOG}. Ctrl-C to stop.`);
  const child = spawnSync('tail', ['-n', '100', '-F', MAC_STDOUT_LOG, MAC_STDERR_LOG], {
    stdio: 'inherit',
  });
  process.exit(child.status ?? 0);
}

function uninstallMacOS(): void {
  unloadIfLoaded();
  if (fs.existsSync(PLIST_PATH)) {
    fs.rmSync(PLIST_PATH);
    console.log(`Removed ${PLIST_PATH}.`);
  } else {
    console.log(`No plist at ${PLIST_PATH}.`);
  }
}

// ─── Windows (NSSM) ──────────────────────────────────────────────────────────

function resolveNssm(): string | null {
  try {
    return execSync('where nssm', { stdio: 'pipe' }).toString().trim().split('\n')[0].trim();
  } catch {
    return null;
  }
}

async function startWindows(): Promise<void> {
  let nssmPath = resolveNssm();

  if (!nssmPath) {
    const { install } = await inquirer.prompt<{ install: boolean }>([
      {
        type: 'confirm',
        name: 'install',
        message: 'NSSM is required but not found. Install it now via winget?',
        default: true,
      },
    ]);

    if (!install) {
      console.log(
        'Aborted. Install NSSM manually and re-run in an elevated (Administrator) terminal.',
      );
      return;
    }

    console.log('Installing NSSM via winget...');
    try {
      execSync('winget install nssm --accept-package-agreements --accept-source-agreements', {
        stdio: 'inherit',
      });
    } catch (e) {
      console.error('winget install failed:', (e as any)?.message ?? e);
      console.log('Try manually: scoop install nssm  or  choco install nssm');
      return;
    }

    // winget updates the registry PATH; spawn a new cmd session to pick it up.
    try {
      nssmPath = execSync('cmd /c where nssm', { stdio: 'pipe' })
        .toString()
        .trim()
        .split('\n')[0]
        .trim();
    } catch {
      nssmPath = null;
    }

    if (!nssmPath) {
      console.log('NSSM installed successfully.');
      console.log('Please open a new elevated (Administrator) terminal and re-run this command.');
      return;
    }
  }

  fs.mkdirSync(WIN_CONFIG_DIR, { recursive: true });
  initLogFiles(WIN_LOG_PATH, WIN_ERROR_LOG_PATH);

  // Remove any pre-existing service so a fresh install is idempotent.
  try {
    execFileSync(nssmPath, ['stop', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });
  } catch {
    /* not running */
  }
  try {
    execFileSync(nssmPath, ['remove', WINDOWS_SERVICE_NAME, 'confirm'], { stdio: 'pipe' });
  } catch {
    /* didn't exist */
  }

  // NSSM services run as LocalSystem; forward the user home so the bot's
  // dotenv / config resolution works correctly.
  const env: Record<string, string> = { USERPROFILE: HOME, HOME };
  for (const key of FORWARD_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  try {
    execFileSync(nssmPath, ['install', WINDOWS_SERVICE_NAME, process.execPath, ENTRY_POINT], {
      stdio: 'pipe',
    });

    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'AppDirectory', TELEGRAM_BOT_ROOT], {
      stdio: 'pipe',
    });

    const envEntries = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'AppEnvironmentExtra', ...envEntries], {
      stdio: 'pipe',
    });

    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'AppStdout', WIN_LOG_PATH], {
      stdio: 'pipe',
    });
    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'AppStderr', WIN_ERROR_LOG_PATH], {
      stdio: 'pipe',
    });
    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'AppRotateFiles', '1'], { stdio: 'pipe' });
    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'AppExit', 'Default', 'Restart'], {
      stdio: 'pipe',
    });
    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'AppRestartDelay', '3000'], {
      stdio: 'pipe',
    });
    execFileSync(nssmPath, ['set', WINDOWS_SERVICE_NAME, 'Start', 'SERVICE_AUTO_START'], {
      stdio: 'pipe',
    });
    execFileSync(
      nssmPath,
      ['set', WINDOWS_SERVICE_NAME, 'DisplayName', 'Omnikey Telegram'],
      { stdio: 'pipe' },
    );
    execFileSync(
      nssmPath,
      ['set', WINDOWS_SERVICE_NAME, 'Description', 'Omnikey Telegram Daemon'],
      { stdio: 'pipe' },
    );

    execFileSync(nssmPath, ['start', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });

    console.log(`NSSM service installed and started: ${WINDOWS_SERVICE_NAME}`);
    console.log('Telegram bot daemon runs on boot, auto-restarts on crash.');
    console.log(`Logs: ${WIN_LOG_PATH}`);
    console.log(`      ${WIN_ERROR_LOG_PATH}`);
  } catch (e: any) {
    const msg: string = e?.stderr?.toString() || e?.message || String(e);
    if (msg.toLowerCase().includes('access') || msg.toLowerCase().includes('privilege')) {
      console.error('Failed to install NSSM service: administrator privileges are required.');
      console.error('Re-run this command in an elevated (Administrator) terminal.');
    } else {
      console.error('Failed to install NSSM service:', msg);
    }
  }
}

function stopWindows(): void {
  const nssmPath = resolveNssm();
  if (!nssmPath) {
    console.log('NSSM not found. Cannot stop service.');
    return;
  }
  try {
    execFileSync(nssmPath, ['stop', WINDOWS_SERVICE_NAME], { stdio: 'inherit' });
    console.log(`Service ${WINDOWS_SERVICE_NAME} stopped.`);
  } catch {
    console.log(`Service ${WINDOWS_SERVICE_NAME} was not running.`);
  }
}

function statusWindows(): void {
  const nssmPath = resolveNssm();
  if (!nssmPath) {
    console.log('NSSM not found. Service status unknown.');
    return;
  }
  try {
    const out = execSync(`"${nssmPath}" status ${WINDOWS_SERVICE_NAME}`, { stdio: 'pipe' })
      .toString()
      .trim();
    console.log(`Service ${WINDOWS_SERVICE_NAME}: ${out}`);
  } catch {
    console.log(`Service ${WINDOWS_SERVICE_NAME} is not installed.`);
  }
}

function logsWindows(): void {
  for (const [label, file] of [
    ['stdout', WIN_LOG_PATH],
    ['stderr', WIN_ERROR_LOG_PATH],
  ] as const) {
    if (fs.existsSync(file)) {
      console.log(`\n── ${label} (${file}) ──`);
      const lines = fs.readFileSync(file, 'utf-8').split('\n').slice(-100).join('\n');
      console.log(lines || '(empty)');
    }
  }
  if (!fs.existsSync(WIN_LOG_PATH) && !fs.existsSync(WIN_ERROR_LOG_PATH)) {
    console.log('No log files yet. Start the daemon first.');
  }
}

function uninstallWindows(): void {
  const nssmPath = resolveNssm();
  if (!nssmPath) {
    console.log('NSSM not found. Nothing to uninstall.');
    return;
  }
  try {
    execFileSync(nssmPath, ['stop', WINDOWS_SERVICE_NAME], { stdio: 'pipe' });
  } catch {
    /* ok */
  }
  try {
    execFileSync(nssmPath, ['remove', WINDOWS_SERVICE_NAME, 'confirm'], { stdio: 'pipe' });
    console.log(`Service ${WINDOWS_SERVICE_NAME} removed.`);
  } catch {
    console.log(`Service ${WINDOWS_SERVICE_NAME} was not installed.`);
  }
}

// ─── Public API (consumed by cli/src/index.ts) ───────────────────────────────

export async function startTelegramDaemon(): Promise<void> {
  // Prompt for TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID if not already saved,
  // and persist them before handing off to the OS service manager so the
  // daemon process inherits the correct credentials.
  const cfg = await ensureTelegramConfig();
  // Inject resolved credentials into process.env so buildPlist() / Windows
  // env forwarding picks them up (they come from config.json, not the shell).
  for (const [key, value] of Object.entries(cfg)) {
    process.env[key] = value;
  }
  // Ensure PORT has a value so the plist always includes it.
  process.env.PORT = process.env.PORT ?? '6666';
  ensureBuilt();
  if (isWindows) {
    await startWindows();
  } else {
    startMacOS();
  }
}

export function stopTelegramDaemon(): void {
  if (isWindows) {
    stopWindows();
  } else {
    stopMacOS();
  }
}

export async function restartTelegramDaemon(): Promise<void> {
  stopTelegramDaemon();
  await startTelegramDaemon();
}

export function statusTelegramDaemon(): void {
  if (isWindows) {
    statusWindows();
  } else {
    statusMacOS();
  }
}

export function logsTelegramDaemon(): void {
  if (isWindows) {
    logsWindows();
  } else {
    logsMacOS();
  }
}

export function uninstallTelegramDaemon(): void {
  if (isWindows) {
    uninstallWindows();
  } else {
    uninstallMacOS();
  }
}
