import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';
import { AgentSession } from './agentSession';

export interface AgentTranscriptMessageAttributes {
  id: string;
  sessionId: string;
  sequence: number;
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  blocksJson: string | null;
  previewJson: string;
  sourceRevision: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export class AgentTranscriptMessage
  extends Model<AgentTranscriptMessageAttributes, AgentTranscriptMessageAttributes>
  implements AgentTranscriptMessageAttributes
{
  public id!: string;
  public sessionId!: string;
  public sequence!: number;
  public messageId!: string;
  public role!: 'user' | 'assistant';
  public text!: string;
  public blocksJson!: string | null;
  public previewJson!: string;
  public sourceRevision!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

AgentTranscriptMessage.init(
  {
    id: { type: DataTypes.STRING, primaryKey: true, allowNull: false },
    sessionId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'session_id',
      references: { model: AgentSession, key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    sequence: { type: DataTypes.INTEGER, allowNull: false },
    messageId: { type: DataTypes.STRING, allowNull: false, field: 'message_id' },
    role: { type: DataTypes.STRING, allowNull: false },
    text: { type: DataTypes.TEXT, allowNull: false },
    blocksJson: { type: DataTypes.TEXT, allowNull: true, field: 'blocks_json' },
    previewJson: { type: DataTypes.TEXT, allowNull: false, field: 'preview_json' },
    sourceRevision: {
      type: DataTypes.STRING(64),
      allowNull: true,
      field: 'source_revision',
    },
  },
  {
    sequelize,
    tableName: 'agent_transcript_messages',
    indexes: [
      // The unique session/sequence index is also the pagination lookup
      // index. Do not declare a second non-unique index with the same fields:
      // Sequelize derives both names from the field list, causing SQLite to
      // execute CREATE INDEX twice with the same name during first sync.
      { unique: true, fields: ['session_id', 'sequence'] },
      { unique: true, fields: ['session_id', 'message_id'] },
    ],
  },
);
