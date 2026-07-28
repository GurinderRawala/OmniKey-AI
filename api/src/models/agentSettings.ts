import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../db';

export type TerminalAccessMode = 'full' | 'limited';

export interface AgentSettingsAttributes {
  id: string;
  terminalAccess: TerminalAccessMode;
  webSearchEnabled: boolean;
  usageRecordingEnabled: boolean;
  browserAccessEnabled: boolean;
  openaiModel?: string | null;
  anthropicModel?: string | null;
  geminiModel?: string | null;
  nemotronModel?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface AgentSettingsCreationAttributes
  extends Optional<
    AgentSettingsAttributes,
    | 'id'
    | 'terminalAccess'
    | 'webSearchEnabled'
    | 'usageRecordingEnabled'
    | 'browserAccessEnabled'
    | 'openaiModel'
    | 'anthropicModel'
    | 'geminiModel'
    | 'nemotronModel'
    | 'createdAt'
    | 'updatedAt'
  > {}

export class AgentSettings
  extends Model<AgentSettingsAttributes, AgentSettingsCreationAttributes>
  implements AgentSettingsAttributes
{
  public id!: string;
  public terminalAccess!: TerminalAccessMode;
  public webSearchEnabled!: boolean;
  public usageRecordingEnabled!: boolean;
  public browserAccessEnabled!: boolean;
  public openaiModel?: string | null;
  public anthropicModel?: string | null;
  public geminiModel?: string | null;
  public nemotronModel?: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

AgentSettings.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
      defaultValue: 'default',
    },
    terminalAccess: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'full',
      field: 'terminal_access',
    },
    webSearchEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'web_search_enabled',
    },
    usageRecordingEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'usage_recording_enabled',
    },
    browserAccessEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'browser_access_enabled',
    },
    openaiModel: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'openai_model',
    },
    anthropicModel: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'anthropic_model',
    },
    geminiModel: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'gemini_model',
    },
    nemotronModel: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'nemotron_model',
    },
  },
  {
    sequelize,
    tableName: 'agent_settings',
    modelName: 'AgentSettings',
  },
);
