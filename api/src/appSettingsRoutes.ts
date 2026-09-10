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
 * Desktop apps collect browser choices natively and run the parameterized CLI
 * in the signed-in user's background shell. This endpoint remains responsible
 * for disabling access and cleaning up the macOS LaunchAgent.
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
 * Tears down a previously-configured browser debug profile: clears the
 * legacy BROWSER_* keys from config.json,
 * and unloads + deletes the macOS LaunchAgent the CLI created. The actual
 * debug profile directory under ~/.omnikey/browser-debug-profiles is kept
 * so re-enabling is fast and the user does not lose any signed-in state.
 */
function disableBrowserAccess(cfg: Record<string, any>): void {
  delete cfg.BROWSER_DEBUG_PORT;
  delete cfg.BROWSER_DEBUG_BROWSER_NAME;
  delete cfg.BROWSER_DEBUG_EXECUTABLE;
  delete cfg.BROWSER_DEBUG_USER_DATA_DIR;
  delete cfg.BROWSER_ACCESS_ENABLED;
  delete cfg.BROWSER_ACCESS_METHOD;
  delete cfg.BROWSER_JAVASCRIPT_EVENT_BROWSERS;
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
      res.json({
        terminalAccess: settings.terminalAccess,
        webSearchEnabled: settings.webSearchEnabled,
        browserAccessEnabled: settings.browserAccessEnabled,
        usageRecordingEnabled: settings.usageRecordingEnabled,
        browserAccessMethod: settings.browserAccessMethod,
        browserDebugBrowserName: settings.browserDebugBrowserName,
        browserDebugPort: settings.browserDebugPort,
        browserJavascriptEventBrowsers: settings.browserJavascriptEventBrowsers,
        runtime: {
          terminalAccess: settings.terminalAccess,
          webSearchEnabled: settings.webSearchEnabled,
          usageRecordingEnabled: settings.usageRecordingEnabled,
          browserAccessEnabled: settings.browserAccessEnabled,
          browserAccessMethod: settings.browserAccessMethod,
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
      res.json({
        terminalAccess: settings.terminalAccess,
        webSearchEnabled: settings.webSearchEnabled,
        browserAccessEnabled: settings.browserAccessEnabled,
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
   * session reading. Enabling requires the platform app's native setup form;
   * disabling clears the saved config and unloads the LaunchAgent.
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
        return res.status(400).json({
          error:
            'Choose the browser access method, browser, and profile in the desktop app or run the parameterized CLI.',
        });
      }

      await updateAgentSettings({
        browserAccessEnabled: false,
        browserAccessMethod: null,
        browserDebugPort: null,
        browserDebugBrowserName: null,
        browserDebugExecutable: null,
        browserDebugUserDataDir: null,
        browserJavascriptEventBrowsers: [],
      });
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
