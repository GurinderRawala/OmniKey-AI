import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';

export type SubscriptionStatus = 'active' | 'expired' | 'canceled' | 'unknown';

interface SubscriptionAttributes {
  id: string;
  // Human-readable subscription key provided to the user.
  userKey: string;
  email?: string | null;
  subscriptionStatus: SubscriptionStatus;
  // When the subscription associated with this key expires. Null or undefined means no expiry.
  userKeyExpiresAt?: Date | null;
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
  public userKey!: string;
  public email?: string | null;
  public subscriptionStatus!: SubscriptionStatus;
  public userKeyExpiresAt?: Date | null;
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
    userKey: {
      type: DataTypes.TEXT,
      allowNull: false,
      // Re-use the existing column name so deployments with an existing
      // subscriptions table do not require a manual migration.
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
    userKeyExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'user_key_expires_at',
    },
  },
  {
    sequelize,
    tableName: 'subscriptions',
    modelName: 'Subscription',
  },
);
