import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { getConfigDir, getConfigPath } from './utils';

const AI_PROVIDERS = [
  { name: 'OpenAI (gpt-4o-mini / gpt-5.1)', value: 'openai' },
  { name: 'Anthropic — Claude (claude-haiku / claude-sonnet)', value: 'anthropic' },
  { name: 'Google Gemini (gemini-2.5-flash / gemini-2.5-pro)', value: 'gemini' },
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
};

const AI_PROVIDER_KEY_LABEL: Record<string, string> = {
  openai: 'OpenAI API key (from platform.openai.com)',
  anthropic: 'Anthropic API key (from console.anthropic.com)',
  gemini: 'Google Gemini API key (from ai.google.dev)',
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
  fs.mkdirSync(configDir, { recursive: true });
  const configVars = {
    AI_PROVIDER: aiProvider,
    [AI_PROVIDER_KEY_ENV[aiProvider]]: apiKey,
    IS_SELF_HOSTED: true,
    SQLITE_PATH: sqlitePath,
    ...searchConfig,
  };
  fs.writeFileSync(configPath, JSON.stringify(configVars, null, 2));

  const providerLabel = SEARCH_PROVIDERS.find((p) => p.value === provider)?.name ?? provider;
  console.log(`\nWeb search provider: ${providerLabel}`);
  console.log(
    `Environment variables saved to ${configPath}. You can edit this file to update your configuration.`,
  );
}
