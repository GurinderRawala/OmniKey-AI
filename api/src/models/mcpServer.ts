import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';
import { Subscription } from './subscription';

export type MCPTransport = 'stdio' | 'http' | 'sse';

interface MCPServerAttributes {
  id: string;
  subscriptionId: string;
  name: string;
  description: string | null;
  transport: MCPTransport;
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
  isEnabled: boolean;
  lastConnectedAt: Date | null;
  lastError: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface MCPServerCreationAttributes extends Optional<
  MCPServerAttributes,
  | 'id'
  | 'description'
  | 'transport'
  | 'command'
  | 'args'
  | 'env'
  | 'url'
  | 'headers'
  | 'isEnabled'
  | 'lastConnectedAt'
  | 'lastError'
  | 'createdAt'
  | 'updatedAt'
> {}

export class MCPServer
  extends Model<MCPServerAttributes, MCPServerCreationAttributes>
  implements MCPServerAttributes
{
  public id!: string;
  public subscriptionId!: string;
  public name!: string;
  public description!: string | null;
  public transport!: MCPTransport;
  public command!: string | null;
  public args!: string[];
  public env!: Record<string, string>;
  public url!: string | null;
  public headers!: Record<string, string>;
  public isEnabled!: boolean;
  public lastConnectedAt!: Date | null;
  public lastError!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

MCPServer.init(
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
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    transport: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'stdio',
    },
    command: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    args: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: [],
    },
    env: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    url: {
      type: DataTypes.STRING(1000),
      allowNull: true,
    },
    headers: {
      type: DataTypes.JSON,
      allowNull: false,
      defaultValue: {},
    },
    isEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'is_enabled',
    },
    lastConnectedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'last_connected_at',
    },
    lastError: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: 'last_error',
    },
  },
  {
    sequelize,
    tableName: 'mcp_servers',
    modelName: 'MCPServer',
    indexes: [
      {
        unique: true,
        fields: ['subscription_id', 'name'],
      },
    ],
  },
);

Subscription.hasMany(MCPServer, {
  foreignKey: 'subscriptionId',
  as: 'mcpServers',
});

MCPServer.belongsTo(Subscription, {
  foreignKey: 'subscriptionId',
  as: 'subscription',
});
