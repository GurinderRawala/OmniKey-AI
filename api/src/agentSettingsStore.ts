import fs from 'fs';
import os from 'os';
import path from 'path';
import { config, AIProvider, TerminalAccessMode } from './config';
import { AgentSettings } from './models/agentSettings';
import { logger } from './logger';

export const DEFAULT_AGENT_SETTINGS_ID = 'default';

export type AgentModelOption = {
  id: string;
  label: string;
};

export type AgentSettingsSnapshot = {
  id: string;
  terminalAccess: TerminalAccessMode;
  webSearchEnabled: boolean;
  usageRecordingEnabled: boolean;
  browserAccessEnabled: boolean;
  openaiModel: string;
  anthropicModel: string;
  geminiModel: string;
  nemotronModel: string;
};

export type AgentSettingsPatch = Partial<{
  terminalAccess: TerminalAccessMode;
  webSearchEnabled: boolean;
  usageRecordingEnabled: boolean;
  browserAccessEnabled: boolean;
  openaiModel: string;
  anthropicModel: string;
  geminiModel: string;
  nemotronModel: string;
}>;

export type AgentModelField = 'openaiModel' | 'anthropicModel' | 'geminiModel' | 'nemotronModel';

export const AGENT_MODEL_OPTIONS: Record<AIProvider, AgentModelOption[]> = {
  openai: [
    { id: 'gpt-5.6', label: 'GPT 5.6' },
    { id: 'gpt-5.5', label: 'GPT 5.5' },
    { id: 'gpt-5.1', label: 'GPT 5.1' },
    { id: 'gpt-4.1', label: 'GPT 4.1' },
  ],
  anthropic: [
    { id: 'claude-opus-4-5', label: 'Claude Opus 4.5' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7' },
    { id: 'claude-opus-5', label: 'Claude Opus 5.0' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5.0' },
    { id: 'claude-fable-5', label: 'Claude Fable 5.0' },
  ],
  gemini: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  ],
  nemotron: [
    {
      id: 'nvidia/nemotron-3-ultra-550b-a55b',
      label: 'nvidia/nemotron-3-ultra-550b-a55b',
    },
    {
      id: 'nvidia/nemotron-3-super-120b-a12b',
      label: 'nvidia/nemotron-3-super-120b-a12b',
    },
    {
      id: 'nvidia/nemotron-3-nano-30b-a3b',
      label: 'nvidia/nemotron-3-nano-30b-a3b',
    },
  ],
};

const MODEL_FIELD_BY_PROVIDER: Record<AIProvider, AgentModelField> = {
  openai: 'openaiModel',
  anthropic: 'anthropicModel',
  gemini: 'geminiModel',
  nemotron: 'nemotronModel',
};

function defaultModelForProvider(provider: AIProvider): string {
  return AGENT_MODEL_OPTIONS[provider][0].id;
}

function getConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.omnikey', 'config.json');
}

export function readLocalConfigFile(): Record<string, any> {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, any>;
    }
  } catch (err) {
    logger.warn('Could not read ~/.omnikey/config.json while loading agent settings.', {
      error: err,
      configPath,
    });
  }
  return {};
}

export function writeLocalConfigFile(data: Record<string, any>): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readBoolean(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function readTerminalAccess(value: unknown): TerminalAccessMode {
  return value === 'limited' ? 'limited' : 'full';
}

function legacyDefaults(): Omit<AgentSettingsSnapshot, 'id'> {
  const cfg = readLocalConfigFile();
  return {
    terminalAccess: readTerminalAccess(cfg.TERMINAL_ACCESS ?? config.terminalAccess),
    webSearchEnabled: readBoolean(cfg.WEB_SEARCH_ENABLED, config.webSearchEnabled),
    usageRecordingEnabled: readBoolean(
      cfg.USAGE_RECORDING_ENABLED,
      config.usageRecordingEnabled,
    ),
    browserAccessEnabled:
      readBoolean(cfg.BROWSER_ACCESS_ENABLED, config.browserAccessEnabled) ||
      Boolean(cfg.BROWSER_DEBUG_EXECUTABLE ?? config.browserDebugExecutable),
    openaiModel: firstString(cfg.OPENAI_MODEL, config.openaiModel) ?? defaultModelForProvider('openai'),
    anthropicModel: firstString(cfg.ANTHROPIC_MODEL) ?? defaultModelForProvider('anthropic'),
    geminiModel: firstString(cfg.GEMINI_MODEL) ?? defaultModelForProvider('gemini'),
    nemotronModel: firstString(cfg.NEMOTRON_MODEL) ?? defaultModelForProvider('nemotron'),
  };
}

function normalizeModel(provider: AIProvider, value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return defaultModelForProvider(provider);
  return trimmed;
}

function rowToSnapshot(row: AgentSettings): AgentSettingsSnapshot {
  const defaults = legacyDefaults();
  return {
    id: row.id,
    terminalAccess: row.terminalAccess === 'limited' ? 'limited' : 'full',
    webSearchEnabled: Boolean(row.webSearchEnabled),
    usageRecordingEnabled: Boolean(row.usageRecordingEnabled),
    browserAccessEnabled: Boolean(row.browserAccessEnabled),
    openaiModel: normalizeModel('openai', row.openaiModel ?? defaults.openaiModel),
    anthropicModel: normalizeModel('anthropic', row.anthropicModel ?? defaults.anthropicModel),
    geminiModel: normalizeModel('gemini', row.geminiModel ?? defaults.geminiModel),
    nemotronModel: normalizeModel('nemotron', row.nemotronModel ?? defaults.nemotronModel),
  };
}

export async function getAgentSettings(): Promise<AgentSettingsSnapshot> {
  const defaults = legacyDefaults();
  const [row, created] = await AgentSettings.findOrCreate({
    where: { id: DEFAULT_AGENT_SETTINGS_ID },
    defaults: {
      id: DEFAULT_AGENT_SETTINGS_ID,
      terminalAccess: defaults.terminalAccess,
      webSearchEnabled: defaults.webSearchEnabled,
      usageRecordingEnabled: defaults.usageRecordingEnabled,
      browserAccessEnabled: defaults.browserAccessEnabled,
      openaiModel: defaults.openaiModel,
      anthropicModel: defaults.anthropicModel,
      geminiModel: defaults.geminiModel,
      nemotronModel: defaults.nemotronModel,
    },
  });
  if (created) {
    logger.info('Migrated legacy agent settings from config.json/env into agent_settings.', {
      id: DEFAULT_AGENT_SETTINGS_ID,
      terminalAccess: defaults.terminalAccess,
      webSearchEnabled: defaults.webSearchEnabled,
      usageRecordingEnabled: defaults.usageRecordingEnabled,
      browserAccessEnabled: defaults.browserAccessEnabled,
      openaiModel: defaults.openaiModel,
      anthropicModel: defaults.anthropicModel,
      geminiModel: defaults.geminiModel,
      nemotronModel: defaults.nemotronModel,
    });
  }
  return rowToSnapshot(row);
}

export async function updateAgentSettings(
  patch: AgentSettingsPatch,
): Promise<AgentSettingsSnapshot> {
  await getAgentSettings();
  await AgentSettings.update(patch, { where: { id: DEFAULT_AGENT_SETTINGS_ID } });
  const row = await AgentSettings.findByPk(DEFAULT_AGENT_SETTINGS_ID);
  if (!row) throw new Error('Agent settings row was not found after update.');
  return rowToSnapshot(row);
}

export function agentModelOptionsForProvider(provider: AIProvider): AgentModelOption[] {
  return AGENT_MODEL_OPTIONS[provider] ?? [];
}

export function modelFieldForProvider(provider: AIProvider): AgentModelField {
  return MODEL_FIELD_BY_PROVIDER[provider];
}

export function selectedAgentModelForProvider(
  settings: AgentSettingsSnapshot,
  provider: AIProvider,
): string {
  return settings[MODEL_FIELD_BY_PROVIDER[provider]];
}

export function isSupportedAgentModel(provider: AIProvider, model: string): boolean {
  return agentModelOptionsForProvider(provider).some((option) => option.id === model);
}

export function readBrowserDebugConfig(): {
  browserAccessConfigured: boolean;
  browserDebugPort?: number;
  browserDebugBrowserName?: string;
  browserDebugExecutable?: string;
  browserDebugUserDataDir?: string;
} {
  const cfg = readLocalConfigFile();
  const rawPort = cfg.BROWSER_DEBUG_PORT ?? config.browserDebugPort;
  const parsedPort =
    typeof rawPort === 'number'
      ? rawPort
      : Number.isFinite(Number(rawPort))
        ? Number(rawPort)
        : undefined;
  const browserDebugExecutable = firstString(
    cfg.BROWSER_DEBUG_EXECUTABLE,
    config.browserDebugExecutable,
  );
  return {
    browserAccessConfigured: Boolean(browserDebugExecutable),
    browserDebugPort: parsedPort && parsedPort > 0 ? parsedPort : undefined,
    browserDebugBrowserName: firstString(
      cfg.BROWSER_DEBUG_BROWSER_NAME,
      config.browserDebugBrowserName,
    ),
    browserDebugExecutable,
    browserDebugUserDataDir: firstString(
      cfg.BROWSER_DEBUG_USER_DATA_DIR,
      config.browserDebugUserDataDir,
    ),
  };
}
