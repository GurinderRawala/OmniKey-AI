import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';

/**
 * Onboard the user by configuring their OPENAI_API_KEY and generating a .env for self-hosted use.
 * @param openAiKey Optional key provided via CLI
 */
export async function onboard(openAiKey?: string) {
  let apiKey = openAiKey;
  let sqlitePath = 'omnikey-selfhosted.sqlite';

  if (!apiKey) {
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'apiKey',
        message: 'Enter your OPENAI_API_KEY:',
        validate: (input: string) => input.trim() !== '' || 'API key cannot be empty',
      },
      {
        type: 'input',
        name: 'sqlitePath',
        message: 'SQLite DB file path:',
        default: 'omnikey-selfhosted.sqlite',
      },
    ]);
    apiKey = answers.apiKey;
    sqlitePath = answers.sqlitePath;
  }

  // Save all environment variables to ~/.omnikey/config.json
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.omnikey');
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
