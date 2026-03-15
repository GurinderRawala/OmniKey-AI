"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SubscriptionTaskTemplate = void 0;
const sequelize_1 = require("sequelize");
const cuid_1 = __importDefault(require("cuid"));
const db_1 = require("../db");
const subscription_1 = require("./subscription");
class SubscriptionTaskTemplate extends sequelize_1.Model {
}
exports.SubscriptionTaskTemplate = SubscriptionTaskTemplate;
SubscriptionTaskTemplate.init({
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
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
    },
    heading: {
        type: sequelize_1.DataTypes.STRING,
        allowNull: false,
    },
    instructions: {
        type: sequelize_1.DataTypes.TEXT,
        allowNull: false,
    },
    isDefault: {
        type: sequelize_1.DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_default',
    },
}, {
    sequelize: db_1.sequelize,
    tableName: 'subscription_task_templates',
    modelName: 'SubscriptionTaskTemplate',
});
subscription_1.Subscription.hasMany(SubscriptionTaskTemplate, {
    foreignKey: 'subscriptionId',
    as: 'taskTemplates',
});
SubscriptionTaskTemplate.belongsTo(subscription_1.Subscription, {
    foreignKey: 'subscriptionId',
    as: 'subscription',
});
