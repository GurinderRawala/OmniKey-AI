import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';

/**
 * Onboard the user by configuring their OPENAI_API_KEY and generating a .env for self-hosted use.
 * @param openAiKey Optional key provided via CLI
 */
export async function onboard(openAiKey?: string) {
  let apiKey = openAiKey;
  const homeDir = process.env.HOME || process.env.USERPROFILE || '.';
  const configDir = path.join(homeDir, '.omnikey');
  const sqlitePath = path.join(configDir, 'omnikey-selfhosted.sqlite');

  if (!apiKey) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'apiKey',
        message: 'Enter your OPENAI_API_KEY:',
        validate: (input: string) => input.trim() !== '' || 'API key cannot be empty',
      },
    ]);
    apiKey = answers.apiKey;
  }

  // Save all environment variables to ~/.omnikey/config.json
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  const configVars = {
    OPENAI_API_KEY: apiKey,
    IS_SELF_HOSTED: true,
    SQLITE_PATH: sqlitePath,
  };
  fs.writeFileSync(configPath, JSON.stringify(configVars, null, 2));
  console.log(
    `Environment variables saved to ${configPath}. You can edit this file to update your configuration.`,
  );
}
