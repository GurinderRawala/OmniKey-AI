import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';

export type SubscriptionStatus = 'active' | 'expired' | 'canceled' | 'unknown';

interface SubscriptionAttributes {
  id: string;
  transactionJwsEncrypted: string;
  email?: string | null;
  subscriptionStatus: SubscriptionStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

interface SubscriptionCreationAttributes extends Optional<
  SubscriptionAttributes,
  'id' | 'subscriptionStatus' | 'email' | 'createdAt' | 'updatedAt'
> {}

export class Subscription
  extends Model<SubscriptionAttributes, SubscriptionCreationAttributes>
  implements SubscriptionAttributes
{
  public id!: string;
  public transactionJwsEncrypted!: string;
  public email?: string | null;
  public subscriptionStatus!: SubscriptionStatus;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Subscription.init(
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true,
      allowNull: false,
      defaultValue: () => cuid(),
    },
    transactionJwsEncrypted: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'transaction_jws',
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    subscriptionStatus: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'unknown',
      field: 'subscription_status',
    },
  },
  {
    sequelize,
    tableName: 'subscriptions',
    modelName: 'Subscription',
  },
);
