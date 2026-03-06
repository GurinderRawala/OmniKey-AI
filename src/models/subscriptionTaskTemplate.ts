import { DataTypes, Model, Optional } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';
import { Subscription } from './subscription';

interface SubscriptionTaskTemplateAttributes {
  id: string;
  subscriptionId: string;
  heading: string;
  instructions: string;
  isDefault: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

interface SubscriptionTaskTemplateCreationAttributes extends Optional<
  SubscriptionTaskTemplateAttributes,
  'id' | 'isDefault' | 'createdAt' | 'updatedAt'
> {}

export class SubscriptionTaskTemplate
  extends Model<SubscriptionTaskTemplateAttributes, SubscriptionTaskTemplateCreationAttributes>
  implements SubscriptionTaskTemplateAttributes
{
  public id!: string;
  public subscriptionId!: string;
  public heading!: string;
  public instructions!: string;
  public isDefault!: boolean;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

SubscriptionTaskTemplate.init(
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
    heading: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    instructions: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_default',
    },
  },
  {
    sequelize,
    tableName: 'subscription_task_templates',
    modelName: 'SubscriptionTaskTemplate',
  },
);

Subscription.hasMany(SubscriptionTaskTemplate, {
  foreignKey: 'subscriptionId',
  as: 'taskTemplates',
});

SubscriptionTaskTemplate.belongsTo(Subscription, {
  foreignKey: 'subscriptionId',
  as: 'subscription',
});
