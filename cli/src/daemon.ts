import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

/**
 * Start the Omnikey API backend as a daemon on the specified port.
 * @param port The port to run the backend on
 */
export function startDaemon(port: number = 7071) {
  // Only use ~/.omnikey/config.json for environment variables

  // Path to the backend entry point (now from backend-dist)
  const backendPath = path.resolve(__dirname, '../backend-dist/index.js');

  // Read and update environment variables from ~/.omnikey/config.json
  const configDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.omnikey');
  const configPath = path.join(configDir, 'config.json');
  let configVars: Record<string, any> = {};
  if (fs.existsSync(configPath)) {
    try {
      configVars = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      console.error('Failed to parse config.json:', e);
    }
  }
  // Ensure both OMNIKEY_PORT and PORT are set for compatibility
  configVars.OMNIKEY_PORT = port;
  // Write the updated configVars back to config.json
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(configVars, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to write updated config.json:', e);
  }
  // Spawn the backend as a detached child process with env vars from config
  const child = spawn('node', [backendPath], {
    env: { ...process.env, ...configVars, OMNIKEY_PORT: String(port) },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`Omnikey API backend started as a daemon on port ${port}`);
}
