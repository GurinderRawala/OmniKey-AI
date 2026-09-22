import { Transaction } from 'sequelize';
import { sequelize } from '../../db';
import { AgentSession } from '../../models/agentSession';
import { AgentTranscriptMessage } from '../../models/agentTranscriptMessage';
import {
  buildTranscript,
  completedTranscriptSnapshot,
  completedTranscriptRevision,
  findTranscriptBlockContent,
  hasLegacyDeferredContentIds,
  previewTranscript,
  type RawHistoryMessage,
  type TranscriptBlock,
  type TranscriptMessage,
} from './transcript';

function rowId(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

// Sequelize renders SQLite bulk inserts as one SQL statement with values
// inlined. Multi-megabyte transcripts can exceed the driver's practical
// statement handling limit and return an undefined result instead of a useful
// SQLite error. Keep each statement bounded while retaining one transaction.
const NORMALIZED_TRANSCRIPT_INSERT_BATCH_BYTES = 256 * 1024;

function normalizedTranscriptInsertBatches<T>(rows: T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 2; // JSON array brackets approximate generated SQL framing.

  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8');
    const separatorBytes = batch.length > 0 ? 1 : 0;
    if (
      batch.length > 0 &&
      batchBytes + separatorBytes + rowBytes > NORMALIZED_TRANSCRIPT_INSERT_BATCH_BYTES
    ) {
      batches.push(batch);
      batch = [];
      batchBytes = 2;
    }
    batch.push(row);
    batchBytes += (batch.length > 1 ? 1 : 0) + rowBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export async function replaceNormalizedTranscript(
  sessionId: string,
  raw: RawHistoryMessage[],
  sourceRevision?: string,
): Promise<TranscriptMessage[]> {
  const messages = completedTranscriptSnapshot(buildTranscript(raw));
  const revision = sourceRevision ?? completedTranscriptRevision(messages);
  const previews = previewTranscript(messages);
  if (!revision) return previews;
  const rows = messages.map((message, sequence) => ({
    id: rowId(sessionId, message.id),
    sessionId,
    sequence,
    messageId: message.id,
    role: message.role,
    text: message.text,
    blocksJson: message.blocks ? JSON.stringify(message.blocks) : null,
    previewJson: JSON.stringify(previews[sequence]),
    sourceRevision: revision,
  }));
  await sequelize.transaction(async (transaction: Transaction) => {
    await AgentTranscriptMessage.destroy({ where: { sessionId }, transaction });
    if (sequelize.getDialect() === 'sqlite') {
      // Sequelize's SQLite bulkCreate result parser can return undefined for
      // particular large text payloads, even for a one-row bulk insert. A
      // normal create uses the stable insert path and remains atomic here.
      for (const row of rows) {
        await AgentTranscriptMessage.create(row, { transaction });
      }
    } else {
      for (const batch of normalizedTranscriptInsertBatches(rows)) {
        await AgentTranscriptMessage.bulkCreate(batch, { transaction });
      }
    }
  });
  return previews;
}

async function readNormalizedTranscriptRows(sessionId: string) {
  return AgentTranscriptMessage.findAll({
    where: { sessionId },
    order: [['sequence', 'ASC']],
    attributes: ['previewJson', 'sourceRevision'],
  });
}

export async function readNormalizedTranscript(sessionId: string): Promise<TranscriptMessage[]> {
  const rows = await readNormalizedTranscriptRows(sessionId);
  return rows.map((row) => JSON.parse(row.previewJson) as TranscriptMessage);
}

export async function readFreshNormalizedTranscript(
  sessionId: string,
  sourceRevision?: string | null,
): Promise<TranscriptMessage[] | null> {
  if (!sourceRevision) return null;
  const rows = await readNormalizedTranscriptRows(sessionId);
  if (!rows.length || rows.some((row) => row.sourceRevision !== sourceRevision)) return null;
  const messages = completedTranscriptSnapshot(
    rows.map((row) => JSON.parse(row.previewJson) as TranscriptMessage),
  );
  // Preview rows written before content-addressed IDs used positional block
  // IDs. Force one safe legacy backfill instead of returning previews whose
  // deferred-content request can no longer be verified.
  return !hasLegacyDeferredContentIds(messages) ? messages : null;
}

export async function readOrBackfillNormalizedTranscript(
  sessionId: string,
  historyJson: string,
  sourceRevision?: string | null,
): Promise<TranscriptMessage[]> {
  const fresh = await readFreshNormalizedTranscript(sessionId, sourceRevision);
  if (fresh) return fresh;
  const raw = JSON.parse(historyJson || '[]') as RawHistoryMessage[];
  const messages = completedTranscriptSnapshot(buildTranscript(raw));
  const revision = completedTranscriptRevision(messages);
  if (!revision) return previewTranscript(messages);
  const previews = await replaceNormalizedTranscript(sessionId, raw, revision);
  // If this update fails, rows and session disagree and the next read safely
  // retries the backfill instead of accepting the rows as current.
  await AgentSession.update(
    { transcriptRevision: revision },
    { where: { id: sessionId, transcriptRevision: sourceRevision ?? null } },
  );
  return previews;
}

/*
 * Full block bodies remain in normalized rows but are excluded from normal
 * history queries. They are read only for explicit expand/copy requests.
 */
export async function readNormalizedBlockContent(
  sessionId: string,
  contentId: string,
): Promise<string | null> {
  const rows = await AgentTranscriptMessage.findAll({
    where: { sessionId },
    order: [['sequence', 'ASC']],
    attributes: ['blocksJson'],
  });
  for (const row of rows) {
    if (!row.blocksJson) continue;
    const blocks = JSON.parse(row.blocksJson) as Array<Pick<TranscriptBlock, 'kind' | 'text'>>;
    const text = findTranscriptBlockContent(blocks, contentId);
    if (text !== null) return text;
  }
  return null;
}
