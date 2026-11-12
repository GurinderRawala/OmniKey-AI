import { DataTypes, Model } from 'sequelize';
import { sequelize } from '../db';
import { AgentSession } from './agentSession';

/**
 * Immutable Git snapshot captured immediately before one final answer.
 * Rows are only ever created (never updated); `payload` is a compressed
 * `SessionDiffPayload` JSON string produced by `compressString`.
 */
export interface AgentSessionDiffAttributes {
  id: string;
  sessionId: string;
  subscriptionId: string;
  runId: string;
  scope: string;
  commitOid: string | null;
  fileCount: number;
  repositoryCount: number;
  payload: string;
  createdAt?: Date;
}

export class AgentSessionDiff
  extends Model<AgentSessionDiffAttributes, AgentSessionDiffAttributes>
  implements AgentSessionDiffAttributes
{
  public id!: string;
  public sessionId!: string;
  public subscriptionId!: string;
  public runId!: string;
  public scope!: string;
  public commitOid!: string | null;
  public fileCount!: number;
  public repositoryCount!: number;
  public payload!: string;
  public readonly createdAt!: Date;
}

AgentSessionDiff.init(
  {
    id: { type: DataTypes.STRING(80), primaryKey: true, allowNull: false },
    sessionId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'session_id',
      references: { model: AgentSession, key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    subscriptionId: { type: DataTypes.STRING, allowNull: false, field: 'subscription_id' },
    runId: { type: DataTypes.STRING(80), allowNull: false, field: 'run_id' },
    scope: { type: DataTypes.STRING(16), allowNull: false },
    commitOid: { type: DataTypes.STRING(64), allowNull: true, field: 'commit_oid' },
    fileCount: { type: DataTypes.INTEGER, allowNull: false, field: 'file_count' },
    repositoryCount: { type: DataTypes.INTEGER, allowNull: false, field: 'repository_count' },
    payload: { type: DataTypes.TEXT, allowNull: false },
  },
  {
    sequelize,
    tableName: 'agent_session_diffs',
    updatedAt: false,
    indexes: [{ fields: ['session_id', 'subscription_id'] }],
  },
);

/**
 * Observed agent-run Git commit provenance: HEAD transitions reported for a
 * shell_script that literally invoked `git commit`, accepted only on the
 * outstanding shell reply of the owning connection. One row per agent run
 * (also when nothing was observed) so "the immediately previous run" is exact.
 */
export interface AgentSessionGitRunAttributes {
  id: string;
  sessionId: string;
  subscriptionId: string;
  commitsJson: string;
  /** Candidate directories this run had evidence for (bounded, <= 8). */
  candidatesJson: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export class AgentSessionGitRun
  extends Model<AgentSessionGitRunAttributes, AgentSessionGitRunAttributes>
  implements AgentSessionGitRunAttributes
{
  public id!: string;
  public sessionId!: string;
  public subscriptionId!: string;
  public commitsJson!: string;
  public candidatesJson!: string;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

AgentSessionGitRun.init(
  {
    id: { type: DataTypes.STRING(80), primaryKey: true, allowNull: false },
    sessionId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'session_id',
      references: { model: AgentSession, key: 'id' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    subscriptionId: { type: DataTypes.STRING, allowNull: false, field: 'subscription_id' },
    commitsJson: { type: DataTypes.TEXT, allowNull: false, field: 'commits_json' },
    candidatesJson: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '[]',
      field: 'candidates_json',
    },
  },
  {
    sequelize,
    tableName: 'agent_session_git_runs',
    indexes: [{ fields: ['session_id', 'subscription_id', 'createdAt'] }],
  },
);
