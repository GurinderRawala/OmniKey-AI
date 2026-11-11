import { DataTypes, Model, Optional, Sequelize } from 'sequelize';
import cuid from 'cuid';
import { sequelize } from '../db';

/**
 * Skills v1 storage (docs/skills-contract.md). `subscriptionId` and
 * `normalizedKeyword` are server-owned and never exposed as mutable DTO fields.
 */
export interface SkillAttributes {
  id: string;
  subscriptionId: string;
  name: string;
  keyword: string;
  normalizedKeyword: string;
  instructions: string;
  enabled: boolean;
  revision: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export type SkillCreationAttributes = Optional<
  SkillAttributes,
  'id' | 'enabled' | 'revision' | 'createdAt' | 'updatedAt'
>;

export const SKILLS_TABLE = 'skills';
export const SKILL_KEYWORD_UNIQUE_INDEX = 'skills_subscription_id_normalized_keyword';

export interface SkillInstance
  extends Model<SkillAttributes, SkillCreationAttributes>, SkillAttributes {}

export type SkillModelStatic = ReturnType<typeof defineSkillModel>;

/**
 * Defines the Skill model on a Sequelize instance. The production model is
 * bound to the shared database below; tests can bind an isolated instance.
 */
export function defineSkillModel(db: Sequelize) {
  class Skill extends Model<SkillAttributes, SkillCreationAttributes> implements SkillAttributes {
    declare id: string;
    declare subscriptionId: string;
    declare name: string;
    declare keyword: string;
    declare normalizedKeyword: string;
    declare instructions: string;
    declare enabled: boolean;
    declare revision: number;
    declare readonly createdAt: Date;
    declare readonly updatedAt: Date;
  }

  Skill.init(
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
        references: { model: 'subscriptions', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
      name: { type: DataTypes.STRING(255), allowNull: false },
      keyword: { type: DataTypes.STRING(255), allowNull: false },
      normalizedKeyword: {
        type: DataTypes.STRING(255),
        allowNull: false,
        field: 'normalized_keyword',
      },
      instructions: { type: DataTypes.TEXT, allowNull: false },
      enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
      revision: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    },
    {
      sequelize: db,
      tableName: SKILLS_TABLE,
      modelName: 'Skill',
      indexes: [
        {
          name: SKILL_KEYWORD_UNIQUE_INDEX,
          unique: true,
          fields: ['subscription_id', 'normalized_keyword'],
        },
      ],
    },
  );

  return Skill;
}

export const Skill = defineSkillModel(sequelize);
