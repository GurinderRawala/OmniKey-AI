import inquirer from 'inquirer';
import path from 'path';
import { getConfigDir, getConfigPath, writeConfig } from './utils';

const AI_PROVIDERS = [
  { name: 'OpenAI (gpt-4o-mini / gpt-5.5)', value: 'openai' },
  { name: 'Anthropic — Claude (claude-haiku / claude-opus)', value: 'anthropic' },
  { name: 'Google Gemini (gemini-2.5-flash / gemini-2.5-pro)', value: 'gemini' },
  {
    name: 'Open Model — OpenAI-compatible endpoint (NVIDIA NIM, vLLM, LM Studio, local gateways)',
    value: 'nemotron',
  },
];

const SEARCH_PROVIDERS = [
  { name: 'Skip', value: 'skip' },
  { name: 'DuckDuckGo', value: 'duckduckgo' },
  { name: 'Serper', value: 'serper' },
  { name: 'Brave Search', value: 'brave' },
  { name: 'Tavily', value: 'tavily' },
  { name: 'SearXNG', value: 'searxng' },
];

const AI_PROVIDER_KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  nemotron: 'OPEN_MODEL_API_KEY',
};

const AI_PROVIDER_KEY_LABEL: Record<string, string> = {
  openai: 'OpenAI API key (from platform.openai.com)',
  anthropic: 'Anthropic API key (from console.anthropic.com)',
  gemini: 'Google Gemini API key (from ai.google.dev)',
  nemotron: 'Open Model API key (or any non-empty placeholder for a local gateway)',
};

/**
 * Onboard the user by configuring their AI provider API key and generating config for self-hosted use.
 */
export async function onboard() {
  const configDir = getConfigDir();
  const sqlitePath = path.join(configDir, 'omnikey-selfhosted.sqlite');

  // Choose AI provider
  const { aiProvider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'aiProvider',
      message: 'Select your AI provider:',
      choices: AI_PROVIDERS,
      default: 'openai',
    },
  ]);

  const { apiKey } = await inquirer.prompt([
    {
      type: 'input',
      name: 'apiKey',
      message: `Enter your ${AI_PROVIDER_KEY_LABEL[aiProvider]}:`,
      validate: (input: string) => input.trim() !== '' || 'API key cannot be empty',
    },
  ]);

  // Provider-specific extras
  const providerExtras: Record<string, string> = {};

  if (aiProvider === 'nemotron') {
    // The legacy provider id remains `nemotron`, but this path accepts any
    // OpenAI-compatible endpoint. The default keeps the previous NVIDIA NIM
    // onboarding flow working for users who press Enter through the prompt.
    const DEFAULT_OPEN_MODEL_URL = 'https://integrate.api.nvidia.com/v1';
    const { openModelBaseUrl, openModelResponsesApiEnabled } = await inquirer.prompt([
      {
        type: 'input',
        name: 'openModelBaseUrl',
        message: 'Enter the OpenAI-compatible /v1 base URL (press Enter for NVIDIA NIM public gateway):',
        default: DEFAULT_OPEN_MODEL_URL,
        validate: (input: string) => {
          const trimmed = input.trim();
          if (trimmed === '') return 'URL cannot be empty';
          try {
            // eslint-disable-next-line no-new
            new URL(trimmed);
            return true;
          } catch {
            return 'Please enter a valid URL (including the scheme, e.g. https://...)';
          }
        },
      },
      {
        type: 'confirm',
        name: 'openModelResponsesApiEnabled',
        message: 'Use Responses API for this endpoint (/v1/responses)?',
        default: false,
      },
    ]);
    providerExtras['OPEN_MODEL_BASE_URL'] = openModelBaseUrl.trim();
    providerExtras['OPEN_MODEL_RESPONSES_API_ENABLED'] = String(openModelResponsesApiEnabled);
  }

  // Web search provider (optional)
  const { provider } = await inquirer.prompt([
    {
      type: 'list',
      name: 'provider',
      message:
        'Select a web search provider for the AI agent. Supported providers: DuckDuckGo, Serper, Brave Search, Tavily, SearXNG:',
      choices: SEARCH_PROVIDERS,
      default: 'skip',
    },
  ]);

  const searchConfig: Record<string, string> = {};

  if (provider === 'serper') {
    const { key } = await inquirer.prompt([
      {
        type: 'input',
        name: 'key',
        message: 'Enter your Serper API key (from serper.dev):',
        validate: (input: string) => input.trim() !== '' || 'API key cannot be empty',
      },
    ]);
    searchConfig['SERPER_API_KEY'] = key.trim();
  } else if (provider === 'brave') {
    const { key } = await inquirer.prompt([
      {
        type: 'input',
        name: 'key',
        message: 'Enter your Brave Search API key (from brave.com/search/api):',
        validate: (input: string) => input.trim() !== '' || 'API key cannot be empty',
      },
    ]);
    searchConfig['BRAVE_SEARCH_API_KEY'] = key.trim();
  } else if (provider === 'tavily') {
    const { key } = await inquirer.prompt([
      {
        type: 'input',
        name: 'key',
        message: 'Enter your Tavily API key (from tavily.com):',
        validate: (input: string) => input.trim() !== '' || 'API key cannot be empty',
      },
    ]);
    searchConfig['TAVILY_API_KEY'] = key.trim();
  } else if (provider === 'searxng') {
    const { url } = await inquirer.prompt([
      {
        type: 'input',
        name: 'url',
        message: 'Enter your SearXNG instance URL (e.g. http://localhost:8080):',
        validate: (input: string) => input.trim() !== '' || 'URL cannot be empty',
      },
    ]);
    searchConfig['SEARXNG_URL'] = url.trim();
  }
  // skip/duckduckgo: no config needed, DuckDuckGo is used automatically as the free fallback

  // Save all environment variables to ~/.omnikey/config.json
  const configPath = getConfigPath();
  const configVars = {
    AI_PROVIDER: aiProvider,
    [AI_PROVIDER_KEY_ENV[aiProvider]]: apiKey,
    IS_SELF_HOSTED: true,
    SQLITE_PATH: sqlitePath,
    ...providerExtras,
    ...searchConfig,
  };
  writeConfig(configVars);

  const providerLabel = SEARCH_PROVIDERS.find((p) => p.value === provider)?.name ?? provider;
  console.log(`\nWeb search provider: ${providerLabel}`);
  console.log(
    `Environment variables saved to ${configPath}. You can edit this file to update your configuration.`,
  );
}
