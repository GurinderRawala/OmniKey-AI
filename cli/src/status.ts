import { execSync } from 'child_process';
import { isWindows, getPort } from './utils';

export function statusCmd() {
  const port = getPort();

  try {
    let output: string;
    if (isWindows) {
      output = execSync(`netstat -ano | findstr :${port}`).toString();
    } else {
      output = execSync(`lsof -i :${port}`).toString();
    }
    if (output.trim()) {
      console.log(`Processes using port ${port}:\n${output}`);
    } else {
      console.log(`No process is using port ${port}.`);
    }
  } catch {
    console.log(`No process is using port ${port}.`);
  }
}
