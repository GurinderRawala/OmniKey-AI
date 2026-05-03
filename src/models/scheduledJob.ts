import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';
import { Subscription } from './subscription';

interface ScheduledJobAttributes {
  id: string;
  subscriptionId: string;
  label: string;
  prompt: string;
  cronExpression: string | null;
  runAt: Date | null;
  isActive: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  sessionId: string | null;
  lastRunSessionId: string | null;
  platform: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

interface ScheduledJobCreationAttributes
  extends Optional<
    ScheduledJobAttributes,
    | 'id'
    | 'isActive'
    | 'cronExpression'
    | 'runAt'
    | 'lastRunAt'
    | 'nextRunAt'
    | 'sessionId'
    | 'lastRunSessionId'
    | 'platform'
    | 'createdAt'
    | 'updatedAt'
  > {}

export class ScheduledJob
  extends Model<ScheduledJobAttributes, ScheduledJobCreationAttributes>
  implements ScheduledJobAttributes
{
  public id!: string;
  public subscriptionId!: string;
  public label!: string;
  public prompt!: string;
  public cronExpression!: string | null;
  public runAt!: Date | null;
  public isActive!: boolean;
  public lastRunAt!: Date | null;
  public nextRunAt!: Date | null;
  public sessionId!: string | null;
  public lastRunSessionId!: string | null;
  public platform!: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

ScheduledJob.init(
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
    label: {
      type: DataTypes.STRING(200),
      allowNull: false,
    },
    prompt: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    cronExpression: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'cron_expression',
    },
    runAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'run_at',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'is_active',
    },
    lastRunAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'last_run_at',
    },
    nextRunAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'next_run_at',
    },
    sessionId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'session_id',
    },
    lastRunSessionId: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'last_run_session_id',
    },
    platform: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'scheduled_jobs',
    modelName: 'ScheduledJob',
    indexes: [
      {
        fields: ['subscription_id', 'next_run_at'],
      },
    ],
  },
);

Subscription.hasMany(ScheduledJob, {
  foreignKey: 'subscriptionId',
  as: 'scheduledJobs',
});

ScheduledJob.belongsTo(Subscription, {
  foreignKey: 'subscriptionId',
  as: 'subscription',
});
