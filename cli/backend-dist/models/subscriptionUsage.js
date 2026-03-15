"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionUsage = void 0;
const sequelize_1 = require("sequelize");
const cuid_1 = __importDefault(require("cuid"));
const db_1 = require("../db");
const subscription_1 = require("./subscription");
class SubscriptionUsage extends sequelize_1.Model {
}
exports.SubscriptionUsage = SubscriptionUsage;
SubscriptionUsage.init({
    id: {
        type: sequelize_1.DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
        defaultValue: () => (0, cuid_1.default)(),
    },
    subscriptionId: {
        type: sequelize_1.DataTypes.STRING,
        allowNull: false,
        field: 'subscription_id',
        references: {
            model: subscription_1.Subscription,
            key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
    },
    model: {
        type: sequelize_1.DataTypes.STRING,
        allowNull: false,
    },
    promptTokens: {
        type: sequelize_1.DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'prompt_tokens',
    },
    completionTokens: {
        type: sequelize_1.DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'completion_tokens',
    },
    totalTokens: {
        type: sequelize_1.DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
        field: 'total_tokens',
    },
}, {
    sequelize: db_1.sequelize,
    tableName: 'subscription_usages',
    modelName: 'SubscriptionUsage',
});
// Optionally set up an association for convenience.
subscription_1.Subscription.hasMany(SubscriptionUsage, {
    foreignKey: 'subscriptionId',
    sourceKey: 'id',
    as: 'usages',
});
SubscriptionUsage.belongsTo(subscription_1.Subscription, {
    foreignKey: 'subscriptionId',
    targetKey: 'id',
    as: 'subscription',
});
