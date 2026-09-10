import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../db';

export type TerminalAccessMode = 'full' | 'limited';
export type BrowserAccessMethod = 'debug-profile' | 'javascript-events';

export interface AgentSettingsAttributes {
  id: string;
  terminalAccess: TerminalAccessMode;
  webSearchEnabled: boolean;
  usageRecordingEnabled: boolean;
  browserAccessEnabled: boolean;
  browserAccessMethod?: BrowserAccessMethod | null;
  browserDebugPort?: number | null;
  browserDebugBrowserName?: string | null;
  browserDebugExecutable?: string | null;
  browserDebugUserDataDir?: string | null;
  browserJavascriptEventBrowsers?: string[] | null;
  openaiModel?: string | null;
  anthropicModel?: string | null;
  geminiModel?: string | null;
  nemotronModel?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface AgentSettingsCreationAttributes extends Optional<
  AgentSettingsAttributes,
  | 'id'
  | 'terminalAccess'
  | 'webSearchEnabled'
  | 'usageRecordingEnabled'
  | 'browserAccessEnabled'
  | 'browserAccessMethod'
  | 'browserDebugPort'
  | 'browserDebugBrowserName'
  | 'browserDebugExecutable'
  | 'browserDebugUserDataDir'
  | 'browserJavascriptEventBrowsers'
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
  public browserAccessMethod?: BrowserAccessMethod | null;
  public browserDebugPort?: number | null;
  public browserDebugBrowserName?: string | null;
  public browserDebugExecutable?: string | null;
  public browserDebugUserDataDir?: string | null;
  public browserJavascriptEventBrowsers?: string[] | null;
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
    browserAccessMethod: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'browser_access_method',
    },
    browserDebugPort: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: 'browser_debug_port',
    },
    browserDebugBrowserName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'browser_debug_browser_name',
    },
    browserDebugExecutable: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'browser_debug_executable',
    },
    browserDebugUserDataDir: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'browser_debug_user_data_dir',
    },
    browserJavascriptEventBrowsers: {
      type: DataTypes.JSON,
      allowNull: true,
      field: 'browser_javascript_event_browsers',
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
