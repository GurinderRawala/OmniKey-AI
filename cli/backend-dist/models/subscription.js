"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Subscription = void 0;
const sequelize_1 = require("sequelize");
const cuid_1 = __importDefault(require("cuid"));
const db_1 = require("../db");
class Subscription extends sequelize_1.Model {
}
exports.Subscription = Subscription;
Subscription.init({
    id: {
        type: sequelize_1.DataTypes.STRING,
        primaryKey: true,
        allowNull: false,
        defaultValue: () => (0, cuid_1.default)(),
    },
    licenseKey: {
        type: sequelize_1.DataTypes.TEXT,
        allowNull: false,
        field: 'license_key',
    },
    email: {
        type: sequelize_1.DataTypes.STRING,
        allowNull: false,
    },
    subscriptionStatus: {
        type: sequelize_1.DataTypes.STRING,
        allowNull: false,
        defaultValue: 'unknown',
        field: 'subscription_status',
    },
    licenseKeyExpiresAt: {
        type: sequelize_1.DataTypes.DATE,
        allowNull: true,
        field: 'license_key_expires_at',
    },
    totalTokensUsed: {
        type: sequelize_1.DataTypes.BIGINT,
        allowNull: false,
        defaultValue: 0,
        field: 'total_tokens_used',
    },
    isSelfHosted: {
        type: sequelize_1.DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        field: 'is_self_hosted',
    },
}, {
    sequelize: db_1.sequelize,
    tableName: 'subscriptions',
    modelName: 'Subscription',
});
