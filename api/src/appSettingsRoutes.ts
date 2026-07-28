import express from 'express';
import zod from 'zod';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { authMiddleware } from './authMiddleware';
import { logger } from './logger';
import {
  getAgentSettings,
  readBrowserDebugConfig,
  readLocalConfigFile,
  updateAgentSettings,
  writeLocalConfigFile,
} from './agentSettingsStore';

/**
 * Settings endpoint for "Agent Access" controls (terminal access mode, web
 * search toggle, usage recording, authenticated browser session reading).
 * Runtime toggles live in the `agent_settings` DB row so they take effect on
 * the next agent turn without bouncing the daemon.
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
    usageRecordingEnabled: zod.boolean().optional(),
  })
  .strict();

const MACOS_LAUNCH_AGENT_LABEL = 'com.omnikey.browser-debug';
const MACOS_LAUNCH_AGENT_PATH = path.join(
  process.env.HOME || os.homedir(),
  'Library',
  'LaunchAgents',
  `${MACOS_LAUNCH_AGENT_LABEL}.plist`,
);

/**
 * Spawns `omnikey grant-browser-access` inside a new Terminal.app window so
 * the interactive inquirer prompts (browser selection, profile naming, etc.)
 * remain reachable. The macOS app cannot host inquirer directly without
 * reimplementing every prompt, so we delegate to the existing CLI flow —
 * the same one a user would run manually.
 */
function launchGrantBrowserAccessInteractive(): { launched: boolean; error?: string } {
  if (process.platform !== 'darwin') {
    return {
      launched: false,
      error: 'Interactive browser-access setup is only wired for macOS in the Settings UI.',
    };
  }

  const omnikeyCli = path.resolve(__dirname, '../dist/index.js');
  const node = process.execPath;
  if (!fs.existsSync(omnikeyCli)) {
    return { launched: false, error: `omnikey CLI not found at ${omnikeyCli}` };
  }

  // Escape for embedding inside the AppleScript string literal.
  const escapeForAppleScript = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

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
  writeLocalConfigFile(cfg);

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
      const settings = await getAgentSettings();
      const debug = readBrowserDebugConfig();
      res.json({
        terminalAccess: settings.terminalAccess,
        webSearchEnabled: settings.webSearchEnabled,
        browserAccessEnabled: settings.browserAccessEnabled || debug.browserAccessConfigured,
        usageRecordingEnabled: settings.usageRecordingEnabled,
        browserDebugBrowserName: debug.browserDebugBrowserName ?? null,
        browserDebugPort: debug.browserDebugPort ?? null,
        runtime: {
          terminalAccess: settings.terminalAccess,
          webSearchEnabled: settings.webSearchEnabled,
          usageRecordingEnabled: settings.usageRecordingEnabled,
          browserAccessEnabled: settings.browserAccessEnabled || debug.browserAccessConfigured,
        },
        source: 'database',
      });
    } catch (err) {
      reqLogger.error('Error reading app settings.', { error: err });
      res.status(500).json({ error: 'Failed to read app settings.' });
    }
  });

  /**
   * PATCH /api/app-settings — partial update of terminalAccess, webSearchEnabled,
   * or usageRecordingEnabled. Values are persisted in DB and are read by the
   * agent hot path on each turn, so no daemon restart is required.
   */
  router.patch('/', authMiddleware, async (req, res) => {
    const { logger: reqLogger } = res.locals;
    try {
      const parsed = updateSchema.parse(req.body);
      if (
        parsed.terminalAccess === undefined &&
        parsed.webSearchEnabled === undefined &&
        parsed.usageRecordingEnabled === undefined
      ) {
        return res.status(400).json({ error: 'No supported fields supplied.' });
      }

      const patch: {
        terminalAccess?: TerminalAccessMode;
        webSearchEnabled?: boolean;
        usageRecordingEnabled?: boolean;
      } = {};
      if (parsed.terminalAccess !== undefined) {
        patch.terminalAccess = parsed.terminalAccess;
      }
      if (parsed.webSearchEnabled !== undefined) {
        patch.webSearchEnabled = parsed.webSearchEnabled;
      }
      if (parsed.usageRecordingEnabled !== undefined) {
        patch.usageRecordingEnabled = parsed.usageRecordingEnabled;
      }
      const settings = await updateAgentSettings(patch);
      const debug = readBrowserDebugConfig();

      res.json({
        terminalAccess: settings.terminalAccess,
        webSearchEnabled: settings.webSearchEnabled,
        browserAccessEnabled: settings.browserAccessEnabled || debug.browserAccessConfigured,
        usageRecordingEnabled: settings.usageRecordingEnabled,
        restartScheduled: false,
        message: 'Settings updated.',
      });
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
      const cfg = readLocalConfigFile();

      if (enabled) {
        // Mark intent in DB so the GET endpoint reflects "enabling" even
        // before the user finishes the Terminal prompts. The CLI writes the
        // debug profile fields to config.json on completion; the backend reads
        // those dynamically, so no daemon restart is needed.
        await updateAgentSettings({ browserAccessEnabled: true });

        const launch = launchGrantBrowserAccessInteractive();
        if (!launch.launched) {
          await updateAgentSettings({ browserAccessEnabled: false });
          return res.status(500).json({
            error: launch.error || 'Failed to launch the interactive browser-access setup.',
          });
        }

        res.json({
          browserAccessEnabled: true,
          launched: true,
          message:
            'Follow the prompts in the Terminal window to finish setting up authenticated browser access.',
          restartScheduled: false,
        });
        return;
      }

      await updateAgentSettings({ browserAccessEnabled: false });
      disableBrowserAccess(cfg);
      res.json({
        browserAccessEnabled: false,
        launched: false,
        message: 'Authenticated browser access disabled.',
        restartScheduled: false,
      });
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
