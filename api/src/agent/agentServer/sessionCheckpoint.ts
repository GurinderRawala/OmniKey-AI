import { createHash, randomUUID } from 'crypto';
import { constants, promises as fs } from 'fs';
import path from 'path';
import type { Logger } from 'winston';
import { getLocalConfigPath } from '../../localConfigFile';
import type { SessionState } from '../types';
import { protectEmptyCheckpoint } from './checkpointPermissions';

const HEADER = '# OmniKey session checkpoint\n\n';
const MAX_FILE_BYTES = 32_768;
const MAX_MEMORY_CHARS = 8_000;

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export function sessionCheckpointPath(subscriptionId: string, sessionId: string): string {
  // IDs are untrusted input. Hash each component instead of allowing paths or
  // names shared by different accounts. The file lives on the daemon host.
  return path.join(
    path.dirname(getLocalConfigPath()),
    'session-context',
    digest(subscriptionId),
    `${digest(sessionId)}.md`,
  );
}

function historyDigest(state: SessionState, through: number): string {
  // The system prompt is refreshed from current settings on every run. Do not
  // invalidate an otherwise matching checkpoint solely because it changed.
  return digest(
    JSON.stringify(
      state.history
        .slice(0, through)
        .map((message) => (message.role === 'system' ? { role: 'system' } : message)),
    ),
  );
}

async function verifyDirectories(file: string, create: boolean): Promise<void> {
  const parent = path.dirname(file);
  const root = path.dirname(parent);
  for (const directory of [root, parent]) {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe checkpoint directory');
  }
}

export async function saveSessionCheckpoint(
  sessionId: string,
  state: SessionState,
  log: Logger,
): Promise<void> {
  // Grouping helpers are transient and deliberately deleted after their run.
  if (sessionId.startsWith('grouping-') || !state.subscription.id || !state.sessionMemory?.trim())
    return;
  const through = state.sessionMemoryHistoryLength ?? 0;
  if (through <= 0 || through > state.history.length) return;
  const file = sessionCheckpointPath(state.subscription.id, sessionId);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await verifyDirectories(file, true);
    const memory = state.sessionMemory.trim().slice(0, MAX_MEMORY_CHARS);
    const metadata = {
      version: 1,
      sessionId,
      subscriptionId: state.subscription.id,
      through,
      updatedAt: (state.sessionMemoryUpdatedAt ?? new Date()).toISOString(),
      historyDigest: historyDigest(state, through),
      memoryDigest: digest(memory),
    };
    const markdown = `${HEADER}<!-- ${JSON.stringify(metadata)} -->\n\n${memory}\n`;
    if (Buffer.byteLength(markdown, 'utf8') > MAX_FILE_BYTES)
      throw new Error('Checkpoint exceeds file size limit');
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await protectEmptyCheckpoint(temporary);
      await handle.writeFile(markdown, 'utf8');
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } catch (error) {
    log.warn('Unable to save session Markdown checkpoint; continuing with database memory', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

export async function restoreSessionCheckpoint(
  sessionId: string,
  state: SessionState,
  log: Logger,
): Promise<void> {
  if (state.sessionCheckpointLoaded) return;
  state.sessionCheckpointLoaded = true;
  // Database memory is authoritative; Markdown is the recovery copy, not a
  // second transcript to append to every prompt.
  if (state.sessionMemory?.trim() || !state.subscription.id || sessionId.startsWith('grouping-'))
    return;
  const file = sessionCheckpointPath(state.subscription.id, sessionId);
  try {
    await verifyDirectories(file, false);
    if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Unsafe checkpoint symlink');
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
        throw new Error('Invalid checkpoint file size/type');
      // A bounded read also protects against a file growing after stat().
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) throw new Error('Checkpoint exceeds file size limit');
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
    if (!text.startsWith(HEADER)) throw new Error('Invalid checkpoint header');
    const [line, ...body] = text.slice(HEADER.length).split('\n');
    if (!line.startsWith('<!-- ') || !line.endsWith(' -->'))
      throw new Error('Invalid checkpoint metadata');
    const metadata = JSON.parse(line.slice(5, -4));
    const memory = body.join('\n').trim();
    if (
      metadata.version !== 1 ||
      metadata.sessionId !== sessionId ||
      metadata.subscriptionId !== state.subscription.id ||
      !Number.isSafeInteger(metadata.through) ||
      metadata.through <= 0 ||
      metadata.through > state.history.length ||
      !memory ||
      memory.length > MAX_MEMORY_CHARS ||
      !Number.isFinite(Date.parse(metadata.updatedAt)) ||
      metadata.historyDigest !== historyDigest(state, metadata.through) ||
      metadata.memoryDigest !== digest(memory)
    ) {
      throw new Error('Checkpoint does not match the persisted session history');
    }
    state.sessionMemory = memory;
    state.sessionMemoryHistoryLength = metadata.through;
    state.sessionMemoryUpdatedAt = new Date(metadata.updatedAt);
    log.info('Recovered session context from Markdown checkpoint', {
      sessionId,
      compactedThrough: metadata.through,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(
        'Ignoring unavailable or mismatched session checkpoint; continuing with stored history',
        {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

export async function deleteSessionCheckpoint(
  subscriptionId: string,
  sessionId: string,
  log: Logger,
): Promise<void> {
  const file = sessionCheckpointPath(subscriptionId, sessionId);
  try {
    await verifyDirectories(file, false);
    await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn('Unable to remove session checkpoint', { sessionId });
  }
}
