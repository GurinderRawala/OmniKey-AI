import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';

export type SubscriptionStatus = 'active' | 'expired' | 'canceled' | 'unknown';

interface SubscriptionAttributes {
  id: string;
  // Human-readable license key provided to the user.
  licenseKey: string;
  email?: string | null;
  subscriptionStatus: SubscriptionStatus;
  // When the license associated with this key expires. Null or undefined means no expiry.
  licenseKeyExpiresAt?: Date | null;
  // Cumulative count of OpenAI tokens used by this subscription.
  totalTokensUsed?: number;
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
  public licenseKey!: string;
  public email?: string | null;
  public subscriptionStatus!: SubscriptionStatus;
  public licenseKeyExpiresAt?: Date | null;
  public totalTokensUsed?: number;
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
    licenseKey: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'license_key',
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    subscriptionStatus: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'unknown',
      field: 'subscription_status',
    },
    licenseKeyExpiresAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'license_key_expires_at',
    },
    totalTokensUsed: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
      field: 'total_tokens_used',
    },
  },
  {
    sequelize,
    tableName: 'subscriptions',
    modelName: 'Subscription',
  },
);
