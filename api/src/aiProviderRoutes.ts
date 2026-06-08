import express from 'express';
import zod from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { authMiddleware } from './authMiddleware';
import { config } from './config';
import { logger } from './logger';
import { runScript } from './scheduledJobExecutor';

/**
 * Settings endpoint for managing AI provider API keys stored in
 * `~/.omnikey/config.json`. No database persistence — the JSON file is the
 * source of truth and is the same file the daemon reads via `dotenv` on
 * startup. Changing the active provider rewrites `AI_PROVIDER` and exits
 * the process so the supervising launchd / NSSM relaunches the daemon with
 * the new env.
 */

export type AIProviderType = 'openai' | 'anthropic' | 'gemini' | 'nemotron';

const providerEnum = zod.enum(['openai', 'anthropic', 'gemini', 'nemotron']);

const putSchema = zod.object({
  apiKey: zod.string().min(1).max(4096),
  baseUrl: zod
    .string()
    .max(1000)
    .url({ message: 'baseUrl must be a valid URL.' })
    .nullable()
    .optional(),
});

/** Mapping from provider → env var that holds its API key. */
const PROVIDER_ENV_KEY: Record<AIProviderType, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  nemotron: 'NEMOTRON_API_KEY',
};

/** Legacy aliases that should be cleared whenever the canonical env is rewritten. */
const PROVIDER_LEGACY_ALIASES: Partial<Record<AIProviderType, string[]>> = {
  nemotron: ['NVIDIA_API_KEY'],
};

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

/** Mask an API key so a small prefix/suffix is visible (e.g. `sk-…AB12`). */
function maskApiKey(key: string | undefined | null): string {
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 3)}••••••••${key.slice(-4)}`;
}

/** Reads any provider key (canonical or legacy alias) out of the config object. */
function readProviderKey(cfg: Record<string, any>, provider: AIProviderType): string | undefined {
  const canonical = cfg[PROVIDER_ENV_KEY[provider]];
  if (canonical && typeof canonical === 'string' && canonical.length > 0) return canonical;
  for (const alias of PROVIDER_LEGACY_ALIASES[provider] ?? []) {
    const v = cfg[alias];
    if (v && typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function describeProvider(provider: AIProviderType, cfg: Record<string, any>) {
  const key = readProviderKey(cfg, provider);
  return {
    provider,
    isConfigured: Boolean(key),
    apiKeyMasked: maskApiKey(key),
    baseUrl: provider === 'nemotron'
      ? (typeof cfg.NEMOTRON_BASE_URL === 'string' ? cfg.NEMOTRON_BASE_URL : null)
      : null,
  };
}

function readActiveProvider(cfg: Record<string, any>): AIProviderType {
  const raw = cfg.AI_PROVIDER;
  if (raw === 'openai' || raw === 'anthropic' || raw === 'gemini' || raw === 'nemotron') {
    return raw;
  }
  // Fall back to the provider currently bound to the running process (config.ts
  // already auto-detects from the first configured key in env).
  return config.aiProvider;
}

/**
 * Triggers a daemon restart by handing off to the shared `runScript` helper
 * (the same one used by the scheduled-job executor). The script invokes the
 * `omnikey restart-daemon --port <port>` CLI, which tears down the
 * launchd / NSSM persistence agent and brings a fresh daemon back up on the
 * same port — picking up the rewritten config.json values from env on the
 * way up.
 *
 * Important: `omnikey restart-daemon` calls `killDaemon()` first, which kills
 * *this* Node process. To survive that, we wrap the call in `nohup ... &`
 * with stdio redirected to a log file and `disown` so the actual
 * `omnikey restart-daemon` invocation escapes the shell's process tree
 * before this process is terminated. `runScript` is fire-and-forget: we do
 * not await it because we expect to be killed before it returns.
 */
function scheduleDaemonRestart(reason: string): void {
  setTimeout(() => {
    const port = config.port;
    const logFile = path.join(
      process.env.HOME || os.homedir(),
      '.omnikey',
      'restart-daemon.log',
    );
    const script = [
      '#!/usr/bin/env bash',
      'set -u',
      `mkdir -p "$(dirname "${logFile}")"`,
      `echo "[$(date -Iseconds)] restart-daemon triggered: ${reason}" >> "${logFile}"`,
      // Detach the actual restart so it survives this daemon's imminent death.
      `nohup omnikey restart-daemon --port ${port} >> "${logFile}" 2>&1 &`,
      'disown || true',
      'exit 0',
    ].join('\n');

    logger.info(`Running \`omnikey restart-daemon --port ${port}\` via runScript (${reason})`);

    // Fire-and-forget: we expect `omnikey restart-daemon` to kill this process
    // long before runScript's exec promise resolves.
    void runScript(script)
      .then((result) => {
        if (result.isError) {
          logger.error('runScript reported a non-zero exit for restart-daemon.', {
            output: result.output,
          });
        }
      })
      .catch((err) => {
        logger.error('Unexpected runScript failure while restarting daemon.', { error: err });
      });
  }, 500);
}

export function aiProviderRouter(): express.Router {
  const router = express.Router();

  /** GET /api/providers — list which providers have a key in config.json. */
  router.get('/', authMiddleware, async (_req, res) => {
    const { logger: reqLogger } = res.locals;
    try {
      const cfg = readConfigFile();
      const providers: AIProviderType[] = ['openai', 'anthropic', 'gemini', 'nemotron'];
      const active = readActiveProvider(cfg);
      res.json({
        providers: providers.map((p) => describeProvider(p, cfg)),
        activeProvider: active,
        // The in-process provider may differ from cfg.AI_PROVIDER if the user
        // changed config.json out of band — surface both so the UI can warn.
        runtimeProvider: config.aiProvider,
      });
    } catch (err) {
      reqLogger.error('Error reading provider config.', { error: err });
      res.status(500).json({ error: 'Failed to read provider config.' });
    }
  });

  /** PUT /api/providers/:provider — store/update API key for that provider. */
  router.put('/:provider', authMiddleware, async (req, res) => {
    const { logger: reqLogger } = res.locals;
    const providerParam = providerEnum.safeParse(req.params.provider);
    if (!providerParam.success) {
      return res.status(400).json({ error: 'Unknown provider.' });
    }
    const provider = providerParam.data;

    try {
      const parsed = putSchema.parse(req.body);
      const cfg = readConfigFile();

      // Always clear legacy aliases so the canonical env wins on next boot.
      for (const alias of PROVIDER_LEGACY_ALIASES[provider] ?? []) {
        delete cfg[alias];
      }
      cfg[PROVIDER_ENV_KEY[provider]] = parsed.apiKey;

      if (provider === 'nemotron') {
        if (parsed.baseUrl) {
          cfg.NEMOTRON_BASE_URL = parsed.baseUrl;
        } else if (parsed.baseUrl === null) {
          delete cfg.NEMOTRON_BASE_URL;
        }
      }

      writeConfigFile(cfg);

      // If the user updated the currently-active provider's key, the running
      // process is now using a stale key — schedule a restart so it picks
      // the new one up. We only restart when AI_PROVIDER is *explicitly*
      // pinned in config.json, because the auto-detected fallback may differ
      // from what the user is configuring and we don't want to bounce the
      // server on first-time key save.
      const explicitActive = typeof cfg.AI_PROVIDER === 'string' ? cfg.AI_PROVIDER : null;
      let restartScheduled = false;
      if (explicitActive === provider) {
        scheduleDaemonRestart(`updated active provider key (${provider})`);
        restartScheduled = true;
      }

      res.json({
        ...describeProvider(provider, cfg),
        restartScheduled,
      });
    } catch (err: any) {
      reqLogger.error('Error storing provider key.', { error: err });
      if (err instanceof zod.ZodError) {
        return res.status(400).json({ error: 'Invalid provider data.' });
      }
      res.status(500).json({ error: 'Failed to store provider key.' });
    }
  });

  /** DELETE /api/providers/:provider — remove the saved key. */
  router.delete('/:provider', authMiddleware, async (req, res) => {
    const { logger: reqLogger } = res.locals;
    const providerParam = providerEnum.safeParse(req.params.provider);
    if (!providerParam.success) {
      return res.status(400).json({ error: 'Unknown provider.' });
    }
    const provider = providerParam.data;

    try {
      const cfg = readConfigFile();
      const active = readActiveProvider(cfg);
      if (active === provider) {
        return res.status(409).json({
          error:
            'Cannot remove the active provider. Activate a different provider first, then remove this one.',
        });
      }

      delete cfg[PROVIDER_ENV_KEY[provider]];
      for (const alias of PROVIDER_LEGACY_ALIASES[provider] ?? []) {
        delete cfg[alias];
      }
      if (provider === 'nemotron') {
        delete cfg.NEMOTRON_BASE_URL;
      }
      writeConfigFile(cfg);

      res.status(204).send();
    } catch (err) {
      reqLogger.error('Error removing provider key.', { error: err });
      res.status(500).json({ error: 'Failed to remove provider key.' });
    }
  });

  /** POST /api/providers/:provider/activate — switch AI_PROVIDER + restart. */
  router.post('/:provider/activate', authMiddleware, async (req, res) => {
    const { logger: reqLogger } = res.locals;
    const providerParam = providerEnum.safeParse(req.params.provider);
    if (!providerParam.success) {
      return res.status(400).json({ error: 'Unknown provider.' });
    }
    const provider = providerParam.data;

    try {
      const cfg = readConfigFile();
      const key = readProviderKey(cfg, provider);
      if (!key) {
        return res.status(400).json({
          error: `No API key saved for provider "${provider}". Save a key first, then activate.`,
        });
      }

      cfg.AI_PROVIDER = provider;
      writeConfigFile(cfg);

      res.json({
        provider,
        activeProvider: provider,
        restartScheduled: true,
        message: 'Provider activated. Server will restart shortly to apply the change.',
      });

      scheduleDaemonRestart(`activated provider ${provider}`);
    } catch (err) {
      reqLogger.error('Error activating provider.', { error: err });
      res.status(500).json({ error: 'Failed to activate provider.' });
    }
  });

  return router;
}
