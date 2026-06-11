import express from 'express';
import zod from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { authMiddleware } from './authMiddleware';
import { config } from './config';
import { logger } from './logger';

/**
 * Settings endpoint for "Agent Access" controls (terminal access mode, web
 * search toggle, authenticated browser session reading). The persistence
 * model is identical to aiProviderRoutes: ~/.omnikey/config.json is the
 * source of truth, the running daemon reads it via dotenv on startup, and
 * any change that affects already-loaded config triggers a detached
 * `omnikey restart-daemon` so the new values take effect.
 *
 * Browser access is special — enabling it spawns the interactive
 * `omnikey grant-browser-access` command in a new Terminal window so the
 * existing inquirer prompts (browser selection, profile naming, etc.) work
 * unchanged. Disabling it removes the saved BROWSER_DEBUG_* keys and the
 * macOS LaunchAgent that auto-launches the debug profile, mirroring the
 * "Remove" path inside the CLI.
 */

type TerminalAccessMode = 'full' | 'limited';

const updateSchema = zod
  .object({
    terminalAccess: zod.enum(['full', 'limited']).optional(),
    webSearchEnabled: zod.boolean().optional(),
  })
  .strict();

const MACOS_LAUNCH_AGENT_LABEL = 'com.omnikey.browser-debug';
const MACOS_LAUNCH_AGENT_PATH = path.join(
  process.env.HOME || os.homedir(),
  'Library',
  'LaunchAgents',
  `${MACOS_LAUNCH_AGENT_LABEL}.plist`,
);

function getConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.omnikey', 'config.json');
}

function readConfigFile(): Record<string, any> {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    logger.warn('Could not read ~/.omnikey/config.json — treating as empty.', { error: err });
  }
  return {};
}

function writeConfigFile(data: Record<string, any>): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

function readTerminalAccess(cfg: Record<string, any>): TerminalAccessMode {
  return cfg.TERMINAL_ACCESS === 'limited' ? 'limited' : 'full';
}

function readWebSearchEnabled(cfg: Record<string, any>): boolean {
  // Mirrors the getBooleanEnv default in config.ts: undefined → true.
  if (cfg.WEB_SEARCH_ENABLED === undefined || cfg.WEB_SEARCH_ENABLED === null) {
    return true;
  }
  const v = String(cfg.WEB_SEARCH_ENABLED).toLowerCase();
  return v === 'true' || v === '1';
}

function readBrowserAccessEnabled(cfg: Record<string, any>): boolean {
  // A browser-access setup writes BROWSER_DEBUG_EXECUTABLE (alongside the
  // port and user-data dir) — treat the presence of those keys as the truth
  // even if BROWSER_ACCESS_ENABLED is not explicitly set.
  if (cfg.BROWSER_ACCESS_ENABLED !== undefined) {
    const v = String(cfg.BROWSER_ACCESS_ENABLED).toLowerCase();
    if (v === 'false' || v === '0') return false;
  }
  return Boolean(cfg.BROWSER_DEBUG_EXECUTABLE);
}

/**
 * Daemon restart scheduler — copied in spirit from aiProviderRoutes so the
 * three settings endpoints share the same restart contract. Detached spawn
 * keeps the new process alive after the parent (current API server) exits.
 */
function scheduleDaemonRestart(reason: string): void {
  setTimeout(() => {
    const port = config.port;
    const home = process.env.HOME || os.homedir();
    const logFile = path.join(home, '.omnikey', 'restart-daemon.log');
    const omnikeyCli = path.resolve(__dirname, '../dist/index.js');

    logger.info(`Spawning detached \`omnikey restart-daemon --port ${port}\` (${reason})`);

    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const out = fs.openSync(logFile, 'a');
      const child = spawn(
        process.execPath,
        [omnikeyCli, 'restart-daemon', '--port', String(port)],
        { detached: true, stdio: ['ignore', out, out] },
      );
      child.unref();
      fs.closeSync(out);
    } catch (err) {
      logger.error('Failed to spawn restart-daemon process.', { error: err });
    }
  }, 500);
}

/**
 * Spawns `omnikey grant-browser-access` inside a new Terminal.app window so
 * the interactive inquirer prompts (browser selection, profile naming, etc.)
 * remain reachable. The macOS app cannot host inquirer directly without
 * reimplementing every prompt, so we delegate to the existing CLI flow —
 * the same one a user would run manually.
 */
function launchGrantBrowserAccessInteractive(): { launched: boolean; error?: string } {
  if (process.platform !== 'darwin') {
    return { launched: false, error: 'Interactive browser-access setup is only wired for macOS in the Settings UI.' };
  }

  const omnikeyCli = path.resolve(__dirname, '../dist/index.js');
  const node = process.execPath;
  if (!fs.existsSync(omnikeyCli)) {
    return { launched: false, error: `omnikey CLI not found at ${omnikeyCli}` };
  }

  // Escape for embedding inside the AppleScript string literal.
  const escapeForAppleScript = (s: string): string =>
    s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  const command = `clear; "${escapeForAppleScript(node)}" "${escapeForAppleScript(omnikeyCli)}" grant-browser-access; echo; echo "[Press Enter to close]"; read`;
  const appleScript = `tell application "Terminal"
    activate
    do script "${command.replace(/"/g, '\\"')}"
end tell`;

  try {
    const child = spawn('/usr/bin/osascript', ['-e', appleScript], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { launched: true };
  } catch (err) {
    return {
      launched: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Tears down a previously-configured browser debug profile: clears the
 * BROWSER_DEBUG_* keys from config.json, sets BROWSER_ACCESS_ENABLED=false,
 * and unloads + deletes the macOS LaunchAgent the CLI created. The actual
 * debug profile directory under ~/.omnikey/browser-debug-profiles is kept
 * so re-enabling is fast and the user does not lose any signed-in state.
 */
function disableBrowserAccess(cfg: Record<string, any>): void {
  delete cfg.BROWSER_DEBUG_PORT;
  delete cfg.BROWSER_DEBUG_BROWSER_NAME;
  delete cfg.BROWSER_DEBUG_EXECUTABLE;
  delete cfg.BROWSER_DEBUG_USER_DATA_DIR;
  cfg.BROWSER_ACCESS_ENABLED = false;
  writeConfigFile(cfg);

  if (process.platform !== 'darwin') return;
  if (!fs.existsSync(MACOS_LAUNCH_AGENT_PATH)) return;
  try {
    // Best-effort unload, then delete. Failure here is non-fatal — the user
    // can always remove the plist by hand if launchctl refuses.
    spawn('/bin/launchctl', ['unload', MACOS_LAUNCH_AGENT_PATH], { stdio: 'ignore' });
    fs.unlinkSync(MACOS_LAUNCH_AGENT_PATH);
  } catch (err) {
    logger.warn('Failed to unload/remove macOS browser-debug LaunchAgent.', { error: err });
  }
}

export function appSettingsRouter(): express.Router {
  const router = express.Router();

  /** GET /api/app-settings — current values + runtime snapshot. */
  router.get('/', authMiddleware, async (_req, res) => {
    const { logger: reqLogger } = res.locals;
    try {
      const cfg = readConfigFile();
      res.json({
        terminalAccess: readTerminalAccess(cfg),
        webSearchEnabled: readWebSearchEnabled(cfg),
        browserAccessEnabled: readBrowserAccessEnabled(cfg),
        browserDebugBrowserName: cfg.BROWSER_DEBUG_BROWSER_NAME ?? null,
        browserDebugPort:
          typeof cfg.BROWSER_DEBUG_PORT === 'number'
            ? cfg.BROWSER_DEBUG_PORT
            : Number.isFinite(Number(cfg.BROWSER_DEBUG_PORT))
              ? Number(cfg.BROWSER_DEBUG_PORT)
              : null,
        // Runtime view so the UI can warn if config.json drifted from the
        // values currently loaded into the process.
        runtime: {
          terminalAccess: config.terminalAccess,
          webSearchEnabled: config.webSearchEnabled,
          browserAccessEnabled:
            config.browserAccessEnabled || Boolean(config.browserDebugExecutable),
        },
      });
    } catch (err) {
      reqLogger.error('Error reading app settings.', { error: err });
      res.status(500).json({ error: 'Failed to read app settings.' });
    }
  });

  /**
   * PATCH /api/app-settings — partial update of terminalAccess and/or
   * webSearchEnabled. Always restarts the daemon so the new values land in
   * `config` before the next agent turn.
   */
  router.patch('/', authMiddleware, async (req, res) => {
    const { logger: reqLogger } = res.locals;
    try {
      const parsed = updateSchema.parse(req.body);
      if (
        parsed.terminalAccess === undefined &&
        parsed.webSearchEnabled === undefined
      ) {
        return res.status(400).json({ error: 'No supported fields supplied.' });
      }

      const cfg = readConfigFile();
      const reasons: string[] = [];
      if (parsed.terminalAccess !== undefined) {
        cfg.TERMINAL_ACCESS = parsed.terminalAccess;
        reasons.push(`terminalAccess=${parsed.terminalAccess}`);
      }
      if (parsed.webSearchEnabled !== undefined) {
        cfg.WEB_SEARCH_ENABLED = parsed.webSearchEnabled;
        reasons.push(`webSearchEnabled=${parsed.webSearchEnabled}`);
      }
      writeConfigFile(cfg);

      res.json({
        terminalAccess: readTerminalAccess(cfg),
        webSearchEnabled: readWebSearchEnabled(cfg),
        browserAccessEnabled: readBrowserAccessEnabled(cfg),
        restartScheduled: true,
        message: 'Settings updated. Server will restart shortly to apply the change.',
      });

      scheduleDaemonRestart(`updated app settings (${reasons.join(', ')})`);
    } catch (err: any) {
      reqLogger.error('Error updating app settings.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid settings payload.' });
      }
      res.status(500).json({ error: 'Failed to update app settings.' });
    }
  });

  /**
   * POST /api/app-settings/browser-access — toggle authenticated browser
   * session reading. Enabling spawns the interactive CLI in a new Terminal
   * window (the user finishes the setup there); disabling clears the saved
   * debug profile config and unloads the LaunchAgent.
   *
   * Body: { enabled: boolean }
   */
  router.post('/browser-access', authMiddleware, async (req, res) => {
    const { logger: reqLogger } = res.locals;
    const bodySchema = zod.object({ enabled: zod.boolean() });
    try {
      const { enabled } = bodySchema.parse(req.body);
      const cfg = readConfigFile();

      if (enabled) {
        // Mark intent in config so the GET endpoint reflects "enabling" even
        // before the user finishes the Terminal prompts. The CLI itself will
        // overwrite BROWSER_DEBUG_* on completion.
        cfg.BROWSER_ACCESS_ENABLED = true;
        writeConfigFile(cfg);

        const launch = launchGrantBrowserAccessInteractive();
        if (!launch.launched) {
          // Revert the intent flag so the toggle does not stay on incorrectly.
          cfg.BROWSER_ACCESS_ENABLED = false;
          writeConfigFile(cfg);
          return res.status(500).json({
            error:
              launch.error ||
              'Failed to launch the interactive browser-access setup.',
          });
        }

        res.json({
          browserAccessEnabled: true,
          launched: true,
          message:
            'Follow the prompts in the Terminal window to finish setting up authenticated browser access.',
          restartScheduled: true,
        });
        scheduleDaemonRestart('enabled browser access');
        return;
      }

      disableBrowserAccess(cfg);
      res.json({
        browserAccessEnabled: false,
        launched: false,
        message: 'Authenticated browser access disabled.',
        restartScheduled: true,
      });
      scheduleDaemonRestart('disabled browser access');
    } catch (err: any) {
      reqLogger.error('Error toggling browser access.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid request payload.' });
      }
      res.status(500).json({ error: 'Failed to toggle browser access.' });
    }
  });

  return router;
}
