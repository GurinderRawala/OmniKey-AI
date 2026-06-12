import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';
import { Subscription } from './subscription';

export interface AgentSessionAttributes {
  id: string;
  subscriptionId: string;
  title: string;
  platform?: string | null;
  historyJson: string;
  turns: number;
  promptTokensUsed: number;
  completionTokensUsed: number;
  totalTokensUsed: number;
  lastPromptTokens: number;
  groupName?: string | null;
  groupDescription?: string | null;
  groupDescriptionUpdatedAt?: Date | null;
  sessionSummary?: string | null;
  lastActiveAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

interface AgentSessionCreationAttributes extends Optional<
  AgentSessionAttributes,
  | 'id'
  | 'title'
  | 'platform'
  | 'historyJson'
  | 'turns'
  | 'promptTokensUsed'
  | 'completionTokensUsed'
  | 'totalTokensUsed'
  | 'lastPromptTokens'
  | 'groupName'
  | 'groupDescription'
  | 'groupDescriptionUpdatedAt'
  | 'sessionSummary'
  | 'lastActiveAt'
  | 'createdAt'
  | 'updatedAt'
> {}

export class AgentSession
  extends Model<AgentSessionAttributes, AgentSessionCreationAttributes>
  implements AgentSessionAttributes
{
  public id!: string;
  public subscriptionId!: string;
  public title!: string;
  public platform?: string | null;
  public historyJson!: string;
  public turns!: number;
  public promptTokensUsed!: number;
  public completionTokensUsed!: number;
  public totalTokensUsed!: number;
  public lastPromptTokens!: number;
  public groupName?: string | null;
  public groupDescription?: string | null;
  public groupDescriptionUpdatedAt?: Date | null;
  public sessionSummary?: string | null;
  public lastActiveAt!: Date;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

AgentSession.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
      defaultValue: () => cuid(),
    },
    subscriptionId: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'subscription_id',
      references: {
        model: Subscription,
        key: 'id',
      },
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE',
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'New Session',
    },
    platform: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    historyJson: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: '[]',
      field: 'history_json',
    },
    turns: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    promptTokensUsed: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: 'prompt_tokens_used',
    },
    completionTokensUsed: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: 'completion_tokens_used',
    },
    totalTokensUsed: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: 'total_tokens_used',
    },
    lastPromptTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'last_prompt_tokens',
    },
    groupName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'group_name',
    },
    groupDescription: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'group_description',
    },
    groupDescriptionUpdatedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'group_description_updated_at',
    },
    sessionSummary: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'session_summary',
    },
    lastActiveAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'last_active_at',
    },
  },
  {
    sequelize,
    tableName: 'agent_sessions',
    indexes: [{ fields: ['subscription_id'] }],
  },
);
