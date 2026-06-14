import { exec } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { promisify } from 'util';
import cuid from 'cuid';

const execAsync = promisify(exec);

// Runs the script in the user's login shell so PATH and profile env-vars are
// present — identical to how the desktop apps open a terminal. Writing to a
// temp file avoids quoting/escaping issues with multi-line scripts.
//
// Used server-side for cron jobs, where there is no desktop client to run the
// shell_script tool call; the agent's tool loop calls this directly.
export async function runScript(script: string): Promise<{ output: string; isError: boolean }> {
  const isWin = process.platform === 'win32';
  const userHome = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
  const userShell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : (process.env.SHELL ?? '/bin/zsh');

  const ext = isWin ? '.bat' : '.sh';
  const tmpFile = path.join(tmpdir(), `cron_${cuid()}${ext}`);

  try {
    if (isWin) {
      await writeFile(tmpFile, `@echo off\r\n${script}`, 'utf8');
    } else {
      await writeFile(tmpFile, script, { encoding: 'utf8', mode: 0o700 });
    }

    // -l = login shell → sources ~/.zprofile / ~/.bash_profile etc.
    const command = isWin ? `"${tmpFile}"` : `"${userShell}" -l "${tmpFile}"`;

    const { stdout, stderr } = await execAsync(command, {
      timeout: 60_000,
      cwd: userHome,
      env: process.env,
    });
    const combined = [stdout, stderr ? `STDERR:\n${stderr}` : ''].filter(Boolean).join('\n').trim();
    return { output: combined || '(no output)', isError: false };
  } catch (err: any) {
    const combined = [err.stdout ?? '', err.stderr ?? ''].filter(Boolean).join('\n').trim();
    return { output: combined || err.message || 'Command failed', isError: true };
  } finally {
    unlink(tmpFile).catch(() => {});
  }
}
