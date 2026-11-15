import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, it } from 'vitest';
import { initLogFiles } from '../utils';

it('preserves crash evidence across repeated daemon starts and creates missing logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnikey-log-test-'));
  try {
    const log = path.join(dir, 'daemon.log');
    const errorLog = path.join(dir, 'daemon-error.log');
    for (const message of ['crash evidence\n', 'restarted\n']) {
      const { out, err } = initLogFiles(log, errorLog);
      try {
        fs.writeSync(out, message);
        fs.writeSync(err, message);
      } finally {
        fs.closeSync(out);
        fs.closeSync(err);
      }
    }
    expect(fs.readFileSync(log, 'utf8')).toBe('crash evidence\nrestarted\n');
    expect(fs.readFileSync(errorLog, 'utf8')).toBe('crash evidence\nrestarted\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
