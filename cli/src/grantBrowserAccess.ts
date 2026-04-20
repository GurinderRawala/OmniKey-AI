import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import net from 'net';
import http from 'http';
import os from 'os';
import { execSync, spawn } from 'child_process';
import { getConfigDir, getConfigPath, readConfig, isWindows } from './utils';

interface BrowserEntry {
  name: string;
  executablePaths: string[];
  userDataDir: string;
}

interface InstalledBrowser extends BrowserEntry {
  executablePath: string;
}

interface ProfileInfo {
  dirName: string;
  displayName: string;
}

const home = os.homedir();

const WINDOWS_BROWSERS: BrowserEntry[] = [
  {
    name: 'Chrome',
    executablePaths: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    userDataDir: path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data'),
  },
  {
    name: 'Edge',
    executablePaths: [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    userDataDir: path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data'),
  },
  {
    name: 'Brave',
    executablePaths: [
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      path.join(
        home,
        'AppData',
        'Local',
        'BraveSoftware',
        'Brave-Browser',
        'Application',
        'brave.exe',
      ),
    ],
    userDataDir: path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data'),
  },
];

const MACOS_BROWSERS: BrowserEntry[] = [
  {
    name: 'Chrome',
    executablePaths: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ],
    userDataDir: path.join(home, 'Library', 'Application Support', 'Google', 'Chrome'),
  },
  {
    name: 'Brave',
    executablePaths: [
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      `${home}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
    ],
    userDataDir: path.join(
      home,
      'Library',
      'Application Support',
      'BraveSoftware',
      'Brave-Browser',
    ),
  },
  {
    name: 'Edge',
    executablePaths: [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      `${home}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
    ],
    userDataDir: path.join(home, 'Library', 'Application Support', 'Microsoft Edge'),
  },
  {
    name: 'Arc',
    executablePaths: [
      '/Applications/Arc.app/Contents/MacOS/Arc',
      `${home}/Applications/Arc.app/Contents/MacOS/Arc`,
    ],
    userDataDir: path.join(home, 'Library', 'Application Support', 'Arc', 'User Data'),
  },
  {
    name: 'Vivaldi',
    executablePaths: [
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      `${home}/Applications/Vivaldi.app/Contents/MacOS/Vivaldi`,
    ],
    userDataDir: path.join(home, 'Library', 'Application Support', 'Vivaldi'),
  },
  {
    name: 'Opera',
    executablePaths: [
      '/Applications/Opera.app/Contents/MacOS/Opera',
      `${home}/Applications/Opera.app/Contents/MacOS/Opera`,
    ],
    userDataDir: path.join(home, 'Library', 'Application Support', 'com.operasoftware.Opera'),
  },
  {
    name: 'Chromium',
    executablePaths: [
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      `${home}/Applications/Chromium.app/Contents/MacOS/Chromium`,
    ],
    userDataDir: path.join(home, 'Library', 'Application Support', 'Chromium'),
  },
];

function resolveExecutable(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function getInstalledBrowsers(catalogue: BrowserEntry[]): InstalledBrowser[] {
  return catalogue
    .map((b) => {
      const executablePath = resolveExecutable(b.executablePaths);
      return executablePath ? { ...b, executablePath } : null;
    })
    .filter((b): b is InstalledBrowser => b !== null);
}

function getProfiles(userDataDir: string): ProfileInfo[] {
  const profiles: ProfileInfo[] = [];
  let profileNames: Record<string, string> = {};

  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8');
    const infoCache = JSON.parse(raw)?.profile?.info_cache ?? {};
    for (const [dirName, info] of Object.entries(infoCache)) {
      profileNames[dirName] = (info as any)?.name ?? dirName;
    }
  } catch {}

  try {
    const entries = fs.readdirSync(userDataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const { name } = entry;
      if (name === 'Default' || /^Profile \d+$/.test(name)) {
        profiles.push({ dirName: name, displayName: profileNames[name] || name });
      }
    }
  } catch {}

  if (profiles.length === 0) {
    profiles.push({ dirName: 'Default', displayName: 'Default' });
  }

  return profiles;
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort = 9222): Promise<number> {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('No available port found in range 9222–9321');
}

function persistDebugPort(port: number): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  fs.mkdirSync(configDir, { recursive: true });
  const cfg = readConfig();
  cfg['BROWSER_DEBUG_PORT'] = port;
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

function persistDebugConfig(params: {
  browserName: string;
  executablePath: string;
  userDataDir: string;
  port: number;
}): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();
  fs.mkdirSync(configDir, { recursive: true });

  const cfg = readConfig();
  cfg['BROWSER_DEBUG_PORT'] = params.port;
  cfg['BROWSER_DEBUG_BROWSER_NAME'] = params.browserName;
  cfg['BROWSER_DEBUG_EXECUTABLE'] = params.executablePath;
  cfg['BROWSER_DEBUG_USER_DATA_DIR'] = params.userDataDir;

  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
}

function hasExistingStartupEntry(): boolean {
  if (isWindows) {
    try {
      const ps =
        `(Get-ItemProperty -Path '${WINDOWS_RUN_KEY}' ` +
        `-Name '${WINDOWS_RUN_VALUE_NAME}' -ErrorAction SilentlyContinue)` +
        `.${WINDOWS_RUN_VALUE_NAME}`;
      const out = execSync(
        `powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      return out.length > 0 && out !== '$null';
    } catch {
      return false;
    }
  }
  return fs.existsSync(MACOS_LAUNCH_AGENT_PATH);
}

function quoteArgWindows(arg: string): string {
  if (!/[ \t"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function quoteArgPosix(arg: string): string {
  if (!/[^\w./:=+-]/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

function launchBrowserDebugProfile(
  executablePath: string,
  launchArgs: string[],
): Promise<string | null> {
  return new Promise((resolve) => {
    let spawnErrorMsg: string | null = null;
    const child = spawn(executablePath, launchArgs, {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      spawnErrorMsg = err.message;
    });
    child.unref();

    setTimeout(() => resolve(spawnErrorMsg), 500);
  });
}

async function setupDebuggingPort(browser: InstalledBrowser): Promise<void> {
  if (hasExistingStartupEntry()) {
    const location = isWindows
      ? `Registry: ${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE_NAME}`
      : MACOS_LAUNCH_AGENT_PATH;

    console.log(`\nA permanent browser debug startup entry already exists:\n  ${location}`);

    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          { name: 'Update browser / debug profile / port settings', value: 'update' },
          { name: 'Remove it (disable permanent startup)', value: 'remove' },
          { name: 'Cancel', value: 'cancel' },
        ],
      },
    ]);

    if (action === 'cancel') return;

    if (action === 'remove') {
      try {
        if (isWindows) {
          removeWindowsStartup();
        } else {
          removeMacOSLaunchAgent();
        }
        console.log('Startup entry removed.');
      } catch (err) {
        console.error('Failed to remove entry:', err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }

  const configDir = getConfigDir();
  const debugRootDir = path.join(configDir, 'browser-debug-profiles');
  fs.mkdirSync(debugRootDir, { recursive: true });

  const safeBrowserName = browser.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  const existingDebugProfiles = fs
    .readdirSync(debugRootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${safeBrowserName}-`))
    .map((entry) => ({
      dirName: entry.name,
      displayName: entry.name.replace(`${safeBrowserName}-`, ''),
      fullPath: path.join(debugRootDir, entry.name),
    }));

  console.log(
    `\nOmnikey will launch ${browser.name} with its own dedicated debug profile.\n` +
      `This is separate from your normal ${browser.name} profile, so you may need to sign in again.\n`,
  );

  let debugUserDataDir: string;
  let debugProfileLabel: string;

  if (existingDebugProfiles.length > 0) {
    const { profileMode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'profileMode',
        message: `Choose an Omnikey debug profile for ${browser.name}:`,
        choices: [
          { name: 'Create a new debug profile', value: 'new' },
          { name: 'Reuse an existing debug profile', value: 'existing' },
        ],
      },
    ]);

    if (profileMode === 'existing') {
      const { existingProfile } = await inquirer.prompt([
        {
          type: 'list',
          name: 'existingProfile',
          message: 'Select an existing Omnikey debug profile:',
          choices: existingDebugProfiles.map((p) => ({
            name: `${p.displayName}  (${p.dirName})`,
            value: p,
          })),
        },
      ]);

      debugUserDataDir = existingProfile.fullPath;
      debugProfileLabel = existingProfile.displayName;
    } else {
      const { profileName } = await inquirer.prompt([
        {
          type: 'input',
          name: 'profileName',
          message: 'Name for the new Omnikey debug profile:',
          default: 'default',
          validate: (input: string) => {
            const trimmed = input.trim();
            if (!trimmed) return 'Enter a profile name.';
            return true;
          },
          filter: (input: string) => input.trim(),
        },
      ]);

      const safeProfileName = profileName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
      debugProfileLabel = profileName;
      debugUserDataDir = path.join(debugRootDir, `${safeBrowserName}-${safeProfileName}`);
      fs.mkdirSync(debugUserDataDir, { recursive: true });
    }
  } else {
    const { profileName } = await inquirer.prompt([
      {
        type: 'input',
        name: 'profileName',
        message: `Name for the Omnikey debug profile for ${browser.name}:`,
        default: 'default',
        validate: (input: string) => {
          const trimmed = input.trim();
          if (!trimmed) return 'Enter a profile name.';
          return true;
        },
        filter: (input: string) => input.trim(),
      },
    ]);

    const safeProfileName = profileName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    debugProfileLabel = profileName;
    debugUserDataDir = path.join(debugRootDir, `${safeBrowserName}-${safeProfileName}`);
    fs.mkdirSync(debugUserDataDir, { recursive: true });
  }

  try {
    fs.writeFileSync(
      path.join(debugUserDataDir, 'omnikey-profile.json'),
      JSON.stringify(
        {
          browser: browser.name,
          profileLabel: debugProfileLabel,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf-8',
    );
  } catch {}

  const port = await findAvailablePort(9222);
  console.log(`\nAvailable debug port: ${port}`);

  persistDebugPort(port);
  persistDebugConfig({
    browserName: browser.name,
    executablePath: browser.executablePath,
    userDataDir: debugUserDataDir,
    port,
  });
  console.log(`Saved browser debug configuration to config.\n`);

  const launchArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${debugUserDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  console.log(
    `Omnikey debug profile:\n  ${debugProfileLabel}\n` + `Profile path:\n  ${debugUserDataDir}\n`,
  );

  console.log(`Close any open ${browser.name} windows, then press Enter.`);
  await inquirer.prompt([{ type: 'input', name: '_', message: 'Press Enter when ready…' }]);

  console.log(`Closing any remaining ${browser.name} processes…`);
  killBrowserProcesses(browser.name);

  if (isWindows) {
    const exe = WINDOWS_EXE_NAMES[browser.name];
    if (exe) await waitUntilProcessDead(exe);
  } else {
    await new Promise((r) => setTimeout(r, 2_000));
  }

  for (const fileName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(debugUserDataDir, fileName);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        console.warn(`Could not remove stale ${fileName} from debug profile.`);
      }
    }
  }

  try {
    if (isWindows) {
      registerWindowsStartup(browser.executablePath, launchArgs);
      console.log(
        `Startup entry saved to Registry (${WINDOWS_RUN_KEY}\\${WINDOWS_RUN_VALUE_NAME}).`,
      );
    } else {
      registerMacOSLaunchAgent(browser.executablePath, launchArgs);
      console.log(`LaunchAgent written to:\n  ${MACOS_LAUNCH_AGENT_PATH}`);
    }
  } catch (err) {
    console.error(
      'Failed to register startup entry:',
      err instanceof Error ? err.message : String(err),
    );
    printLaunchHint(browser.executablePath, launchArgs);
    return;
  }

  console.log(`\nLaunching ${browser.name}…`);
  console.log(
    `  Command: "${browser.executablePath}" ${
      isWindows
        ? launchArgs.map(quoteArgWindows).join(' ')
        : launchArgs.map(quoteArgPosix).join(' ')
    }`,
  );

  const spawnErrorMsg = await launchBrowserDebugProfile(browser.executablePath, launchArgs);
  if (spawnErrorMsg) {
    console.error(`Failed to launch browser: ${spawnErrorMsg}`);
    printLaunchHint(browser.executablePath, launchArgs);
    return;
  }

  console.log(`Waiting for debug port ${port} to become active…`);
  const portUp = await waitForDebugPort(port);

  if (portUp) {
    console.log(
      `\nDebug port ${port} is active.\n` +
        `Verify at: http://localhost:${port}/json\n` +
        `Omnikey can now access tabs opened in the Omnikey-managed ${browser.name} debug profile.\n` +
        `${browser.name} will start automatically on every future login using this debug profile.`,
    );
  } else {
    console.error(
      `\nCould not reach localhost:${port} after 15 s.\n` +
        `Possible causes:\n` +
        `  1. A background ${browser.name} process is still alive — open Task Manager → Details,\n` +
        `     end all "${WINDOWS_EXE_NAMES[browser.name] ?? browser.name.toLowerCase()}" entries, then run this command again.\n` +
        `  2. Security software or policy is blocking the remote-debugging-port flag.\n` +
        `  3. The browser opened, but failed to initialize the Omnikey debug profile.\n\n` +
        `Try launching manually:\n` +
        (isWindows
          ? `  & "${browser.executablePath}" ${launchArgs.map(quoteArgWindows).join(' ')}`
          : `  "${browser.executablePath}" ${launchArgs.map(quoteArgPosix).join(' ')}`),
    );
  }
}

function printLaunchHint(executablePath: string, launchArgs: string[]): void {
  console.log('\nTo enable browser access, start your browser with:');
  if (isWindows) {
    console.log(`  & "${executablePath}" ${launchArgs.map(quoteArgWindows).join(' ')}`);
  } else {
    const quotedExe = executablePath.includes(' ') ? `"${executablePath}"` : executablePath;
    console.log(`  ${quotedExe} ${launchArgs.map(quoteArgPosix).join(' ')}`);
  }
}

const WINDOWS_EXE_NAMES: Record<string, string> = {
  Chrome: 'chrome.exe',
  Edge: 'msedge.exe',
  Brave: 'brave.exe',
};

function killBrowserProcesses(browserName: string): void {
  if (isWindows) {
    const exe = WINDOWS_EXE_NAMES[browserName];
    if (!exe) return;
    const baseName = exe.replace('.exe', '');
    try {
      execSync(`taskkill /F /IM "${exe}" /T`, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {}
    try {
      execSync(
        `powershell -NoProfile -NonInteractive -Command "Stop-Process -Name '${baseName}' -Force -ErrorAction SilentlyContinue"`,
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {}
  } else {
    const processName = MACOS_PROCESS_NAMES[browserName];
    if (!processName) return;
    try {
      execSync(`pkill -x "${processName}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {}
  }
}

async function waitUntilProcessDead(exe: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exe}" /FO CSV /NH 2>nul`, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (!out.toLowerCase().includes(exe.toLowerCase())) return;
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function waitForDebugPort(port: number, timeoutMs = 15_000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const probe = () => {
      const req = http.get(
        { hostname: '127.0.0.1', port, path: '/json/version', timeout: 1_500 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve(true);
          retry();
        },
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(probe, 600);
    };
    probe();
  });
}

const WINDOWS_RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WINDOWS_RUN_VALUE_NAME = 'OmnikeyBrowserDebug';
const MACOS_LAUNCH_AGENT_LABEL = 'com.omnikey.browser-debug';
const MACOS_LAUNCH_AGENT_PATH = path.join(
  home,
  'Library',
  'LaunchAgents',
  `${MACOS_LAUNCH_AGENT_LABEL}.plist`,
);

function registerWindowsStartup(executablePath: string, launchArgs: string[]): void {
  const cmd = `"${executablePath}" ${launchArgs.map(quoteArgWindows).join(' ')}`;
  const ps =
    `Set-ItemProperty -Path '${WINDOWS_RUN_KEY}' ` +
    `-Name '${WINDOWS_RUN_VALUE_NAME}' ` +
    `-Value '${cmd.replace(/'/g, "''")}'`;

  execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function removeWindowsStartup(): void {
  const ps =
    `Remove-ItemProperty -Path '${WINDOWS_RUN_KEY}' ` +
    `-Name '${WINDOWS_RUN_VALUE_NAME}' -ErrorAction SilentlyContinue`;
  execSync(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function registerMacOSLaunchAgent(executablePath: string, launchArgs: string[]): void {
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"',
    '  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${MACOS_LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${executablePath}</string>`,
    ...launchArgs.map((a) => `    <string>${a}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><false/>',
    `  <key>StandardOutPath</key><string>${path.join(os.tmpdir(), 'omnikey-browser-debug.log')}</string>`,
    `  <key>StandardErrorPath</key><string>${path.join(os.tmpdir(), 'omnikey-browser-debug.err')}</string>`,
    '</dict>',
    '</plist>',
  ].join('\n');

  fs.mkdirSync(path.dirname(MACOS_LAUNCH_AGENT_PATH), { recursive: true });
  fs.writeFileSync(MACOS_LAUNCH_AGENT_PATH, plist, 'utf-8');

  try {
    execSync(`launchctl unload "${MACOS_LAUNCH_AGENT_PATH}" 2>/dev/null`, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {}
  execSync(`launchctl load "${MACOS_LAUNCH_AGENT_PATH}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function removeMacOSLaunchAgent(): void {
  if (!fs.existsSync(MACOS_LAUNCH_AGENT_PATH)) return;
  try {
    execSync(`launchctl unload "${MACOS_LAUNCH_AGENT_PATH}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {}
  fs.unlinkSync(MACOS_LAUNCH_AGENT_PATH);
}

const MACOS_PROCESS_NAMES: Record<string, string> = {
  Chrome: 'Google Chrome',
  Brave: 'Brave Browser',
  Edge: 'Microsoft Edge',
  Arc: 'Arc',
  Vivaldi: 'Vivaldi',
  Opera: 'Opera',
  Chromium: 'Chromium',
  Safari: 'Safari',
};

function isBrowserRunning(browserName: string): boolean {
  const processName = MACOS_PROCESS_NAMES[browserName];
  if (!processName) return false;
  try {
    execSync(`pgrep -xq "${processName}"`, { stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function patchChromiumPreferences(browserName: string, userDataDir: string): [number, number] {
  const profiles = getProfiles(userDataDir);
  let updated = 0;
  let skipped = 0;

  for (const profile of profiles) {
    const prefsPath = path.join(userDataDir, profile.dirName, 'Preferences');
    if (!fs.existsSync(prefsPath)) {
      skipped++;
      continue;
    }
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
      if (prefs?.devtools?.allow_javascript_apple_events === true) {
        console.log(`  ${browserName} › ${profile.displayName}: already enabled`);
        updated++;
        continue;
      }
      if (!prefs.devtools) prefs.devtools = {};
      prefs.devtools.allow_javascript_apple_events = true;
      fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf-8');
      console.log(`  ${browserName} › ${profile.displayName}: enabled`);
      updated++;
    } catch (err) {
      console.warn(
        `  ${browserName} › ${profile.displayName}: failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped++;
    }
  }

  return [updated, skipped];
}

async function setupAppleScript(): Promise<void> {
  const chromiumInstalled = getInstalledBrowsers(MACOS_BROWSERS);
  const safariPresent = fs.existsSync('/Applications/Safari.app');

  type BrowserChoice = { name: string; value: string; userDataDir?: string };
  const choices: BrowserChoice[] = [
    ...chromiumInstalled.map((b) => ({ name: b.name, value: b.name, userDataDir: b.userDataDir })),
    ...(safariPresent ? [{ name: 'Safari', value: 'Safari' }] : []),
  ];

  if (choices.length === 0) {
    console.log('No supported browsers found on this system.');
    return;
  }

  const { selectedNames }: { selectedNames: string[] } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedNames',
      message: 'Select browsers to enable "Allow JavaScript from Apple Events":',
      choices: choices.map((c) => ({ name: c.name, value: c.value })),
      validate: (input: string[]) => input.length > 0 || 'Select at least one browser.',
    },
  ]);

  const runningSelected = selectedNames.filter((n) => n !== 'Safari' && isBrowserRunning(n));
  if (runningSelected.length > 0) {
    console.log(
      `\nWarning: the following browser(s) are currently running and will overwrite` +
        ` their Preferences file when they close, reverting this change:\n` +
        runningSelected.map((n) => `  • ${n}`).join('\n'),
    );
    const { proceed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'proceed',
        message: 'Quit those browsers now and then continue? (Choose No to cancel)',
        default: true,
      },
    ]);
    if (!proceed) {
      console.log('Cancelled. Quit the browser(s) first, then re-run this command.');
      return;
    }
    await inquirer.prompt([
      {
        type: 'input',
        name: '_',
        message: `Close ${runningSelected.join(', ')} completely, then press Enter to continue…`,
      },
    ]);
  }

  console.log('');

  for (const name of selectedNames) {
    if (name === 'Safari') {
      try {
        execSync('defaults write com.apple.Safari AllowJavaScriptFromAppleEvents -bool YES', {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log('  Safari: enabled  (restart Safari to apply)');
      } catch (err) {
        console.error(`  Safari: failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    const entry = chromiumInstalled.find((b) => b.name === name);
    if (!entry) continue;

    const [updated, skipped] = patchChromiumPreferences(name, entry.userDataDir);
    if (skipped > 0) {
      console.log(`  ${name}: ${updated} profile(s) updated, ${skipped} skipped`);
    }
  }

  console.log(
    '\nDone. Restart each browser for the change to take effect.\n' +
      'Omnikey will read content directly from the active tab — no port configuration needed.',
  );
}

export async function grantBrowserAccess(): Promise<void> {
  if (!isWindows) {
    const { method } = await inquirer.prompt([
      {
        type: 'list',
        name: 'method',
        message: 'How should Omnikey access authenticated browser tabs?',
        choices: [
          {
            name: 'Remote Debugging Port  — launch browser with CDP; works on all Chromium browsers (recommended)',
            value: 'debugging-port',
          },
          {
            name: 'AppleScript  — read live tabs without relaunching; requires "Allow JavaScript from Apple Events"',
            value: 'applescript',
          },
        ],
      },
    ]);

    if (method === 'applescript') {
      await setupAppleScript();
      return;
    }
  }

  const catalogue = isWindows ? WINDOWS_BROWSERS : MACOS_BROWSERS;
  const installed = getInstalledBrowsers(catalogue);

  if (installed.length === 0) {
    console.log(
      'No supported Chromium browsers found.\n' +
        'Supported: Chrome, Edge, Brave' +
        (isWindows ? '.' : ', Arc, Vivaldi, Opera, Chromium.'),
    );
    return;
  }

  const { browser }: { browser: InstalledBrowser } = await inquirer.prompt([
    {
      type: 'list',
      name: 'browser',
      message: 'Select the browser to set up:',
      choices: installed.map((b) => ({ name: b.name, value: b })),
    },
  ]);

  await setupDebuggingPort(browser);
}

interface DebugConfig {
  browserName: string;
  executablePath: string;
  userDataDir: string;
  port: number;
}

async function recoverDebugConfig(): Promise<DebugConfig | null> {
  const debugRootDir = path.join(getConfigDir(), 'browser-debug-profiles');
  if (!fs.existsSync(debugRootDir)) return null;

  const profileDirs = fs
    .readdirSync(debugRootDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  if (profileDirs.length === 0) return null;

  const catalogue = isWindows ? WINDOWS_BROWSERS : MACOS_BROWSERS;
  const installed = getInstalledBrowsers(catalogue);

  // Pair each profile directory with its browser by matching the name prefix.
  const candidates: { profileDir: string; browser: InstalledBrowser }[] = [];
  for (const profileDir of profileDirs) {
    const browser = installed.find((b) =>
      profileDir.startsWith(b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-'),
    );
    if (browser) candidates.push({ profileDir, browser });
  }

  if (candidates.length === 0) return null;

  let chosen: { profileDir: string; browser: InstalledBrowser };

  if (candidates.length === 1) {
    chosen = candidates[0];
    console.log(
      `Recovered debug profile: ${chosen.browser.name} › ${chosen.profileDir}`,
    );
  } else {
    const { selection } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selection',
        message: 'Multiple Omnikey debug profiles found — which one should open?',
        choices: candidates.map((c) => ({
          name: `${c.browser.name}  (${c.profileDir})`,
          value: c,
        })),
      },
    ]);
    chosen = selection;
  }

  const cfg = readConfig();
  const port = Number.isFinite(Number(cfg['BROWSER_DEBUG_PORT'])) && Number(cfg['BROWSER_DEBUG_PORT']) > 0
    ? Number(cfg['BROWSER_DEBUG_PORT'])
    : await findAvailablePort(9222);

  return {
    browserName: chosen.browser.name,
    executablePath: chosen.browser.executablePath,
    userDataDir: path.join(debugRootDir, chosen.profileDir),
    port,
  };
}

export async function reopenBrowserDebugProfile(): Promise<void> {
  let cfg = readConfig();

  let executablePath: string = cfg['BROWSER_DEBUG_EXECUTABLE'] || '';
  let userDataDir: string = cfg['BROWSER_DEBUG_USER_DATA_DIR'] || '';
  let port = Number(cfg['BROWSER_DEBUG_PORT']);
  let browserName: string = cfg['BROWSER_DEBUG_BROWSER_NAME'] || '';

  // If the config is incomplete (e.g. created by an older version of grant-browser-access),
  // try to recover by scanning the browser-debug-profiles directory.
  if (!executablePath || !userDataDir) {
    const recovered = await recoverDebugConfig();
    if (!recovered) {
      console.error(
        'No saved browser debug profile found.\n' +
          'Run `omnikey grant-browser-access` first to set one up.',
      );
      return;
    }
    executablePath = recovered.executablePath;
    userDataDir = recovered.userDataDir;
    browserName = browserName || recovered.browserName;
    if (!Number.isFinite(port) || port <= 0) port = recovered.port;
    // Persist the recovered values so future runs skip this step.
    persistDebugConfig({ browserName, executablePath, userDataDir, port });
    cfg = readConfig();
  }

  if (!Number.isFinite(port) || port <= 0) {
    console.error('No valid saved browser debug port found. Run browser setup first.');
    return;
  }

  if (!fs.existsSync(executablePath)) {
    console.error(`Saved browser executable does not exist:\n  ${executablePath}`);
    return;
  }

  fs.mkdirSync(userDataDir, { recursive: true });

  const launchArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // If the debug endpoint is already up, do not kill/relaunch anything.
  const alreadyUp = await waitForDebugPort(port, 1200);
  if (alreadyUp) {
    console.log(
      `Debug port ${port} is already active.\n` +
        `Verify at: http://localhost:${port}/json\n` +
        `Omnikey can already access tabs opened in the saved ${browserName} debug profile.`,
    );
    return;
  }

  console.log(`Closing any running ${browserName} processes…`);
  killBrowserProcesses(browserName);

  if (isWindows) {
    const exe = WINDOWS_EXE_NAMES[browserName];
    if (exe) {
      await waitUntilProcessDead(exe);
    } else {
      await new Promise((r) => setTimeout(r, 1500));
    }
  } else {
    await new Promise((r) => setTimeout(r, 2000));
  }

  for (const fileName of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const p = path.join(userDataDir, fileName);
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        console.warn(`Could not remove stale ${fileName} from debug profile.`);
      }
    }
  }

  console.log(`Reopening ${browserName} with Omnikey debug profile…`);
  console.log(
    `  Command: "${executablePath}" ${
      isWindows
        ? launchArgs.map(quoteArgWindows).join(' ')
        : launchArgs.map(quoteArgPosix).join(' ')
    }`,
  );

  const spawnErrorMsg = await launchBrowserDebugProfile(executablePath, launchArgs);
  if (spawnErrorMsg) {
    console.error(`Failed to launch browser: ${spawnErrorMsg}`);
    printLaunchHint(executablePath, launchArgs);
    return;
  }

  console.log(`Waiting for debug port ${port} to become active…`);
  const portUp = await waitForDebugPort(port);

  if (portUp) {
    console.log(
      `\nDebug port ${port} is active.\n` +
        `Verify at: http://localhost:${port}/json\n` +
        `Omnikey can now access tabs opened in the saved ${browserName} debug profile.`,
    );
  } else {
    console.error(
      `\nCould not reach localhost:${port} after relaunch.\n` +
        `Manual launch:\n` +
        (isWindows
          ? `  & "${executablePath}" ${launchArgs.map(quoteArgWindows).join(' ')}`
          : `  "${executablePath}" ${launchArgs.map(quoteArgPosix).join(' ')}`),
    );
  }
}
