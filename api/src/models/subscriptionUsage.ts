import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';
import { Subscription } from './subscription';

interface SubscriptionUsageAttributes {
  id: string;
  subscriptionId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  createdAt?: Date;
  updatedAt?: Date;
}

interface SubscriptionUsageCreationAttributes extends Optional<
  SubscriptionUsageAttributes,
  'id' | 'promptTokens' | 'completionTokens' | 'totalTokens' | 'createdAt' | 'updatedAt'
> {}

export class SubscriptionUsage
  extends Model<SubscriptionUsageAttributes, SubscriptionUsageCreationAttributes>
  implements SubscriptionUsageAttributes
{
  public id!: string;
  public subscriptionId!: string;
  public model!: string;
  public promptTokens!: number;
  public completionTokens!: number;
  public totalTokens!: number;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

SubscriptionUsage.init(
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
    model: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    promptTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'prompt_tokens',
    },
    completionTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'completion_tokens',
    },
    totalTokens: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'total_tokens',
    },
  },
  {
    sequelize,
    tableName: 'subscription_usages',
    modelName: 'SubscriptionUsage',
  },
);

// Optionally set up an association for convenience.
Subscription.hasMany(SubscriptionUsage, {
  foreignKey: 'subscriptionId',
  sourceKey: 'id',
  as: 'usages',
});

SubscriptionUsage.belongsTo(Subscription, {
  foreignKey: 'subscriptionId',
  targetKey: 'id',
  as: 'subscription',
});
