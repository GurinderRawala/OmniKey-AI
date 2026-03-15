"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.selfHostedSubscription = selfHostedSubscription;
exports.authMiddleware = authMiddleware;
const crypto_1 = require("crypto");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const logger_1 = require("./logger");
const config_1 = require("./config");
const subscription_1 = require("./models/subscription");
async function selfHostedSubscription() {
    try {
        let subscription = await subscription_1.Subscription.findOne({ where: { isSelfHosted: true } });
        if (!subscription) {
            subscription = await subscription_1.Subscription.create({
                email: 'local-user@omnikey.ai',
                licenseKey: 'self-hosted',
                subscriptionStatus: 'active',
                isSelfHosted: true,
            });
            logger_1.logger.info('Created self-hosted subscription record in database.');
        }
        return subscription;
    }
    catch (err) {
        logger_1.logger.error('Error ensuring self-hosted subscription record exists.', { error: err });
        throw err;
    }
}
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    logger_1.logger.defaultMeta = { traceId: (0, crypto_1.randomUUID)() };
    if (config_1.config.isSelfHosted || !config_1.config.jwtSecret) {
        logger_1.logger.info('Self-hosted mode: skipping auth middleware.');
        if (config_1.config.isSelfHosted) {
            res.locals.subscription = await selfHostedSubscription();
            res.locals.logger = logger_1.logger;
        }
        return next();
    }
    if (!authHeader) {
        logger_1.logger.warn('Missing Authorization header on feature route.');
        return res.status(401).json({ error: 'Missing bearer token.' });
    }
    const [scheme, token] = authHeader.split(' ');
    if (scheme !== 'Bearer' || !token) {
        logger_1.logger.warn('Malformed Authorization header on feature route.');
        return res.status(401).json({ error: 'Invalid authorization header.' });
    }
    try {
        const decoded = jsonwebtoken_1.default.verify(token, config_1.config.jwtSecret);
        const subscription = await subscription_1.Subscription.findByPk(decoded.sid);
        if (!subscription) {
            logger_1.logger.warn('Subscription not found for JWT.', { sid: decoded.sid });
            return res.status(403).json({ error: 'Invalid or expired token.' });
        }
        if (subscription.subscriptionStatus == 'expired') {
            logger_1.logger.warn('Inactive subscription for JWT.', {
                sid: decoded.sid,
                status: subscription.subscriptionStatus,
            });
            return res.status(403).json({ error: 'Subscription is not active.' });
        }
        const now = new Date();
        if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
            subscription.subscriptionStatus = 'expired';
            await subscription.save();
            logger_1.logger.info('Subscription key has expired during activation.', {
                subscriptionId: subscription.id,
            });
            return res
                .status(403)
                .json({ error: 'Subscription has expired.', subscriptionStatus: 'expired' });
        }
        res.locals.logger = logger_1.logger;
        res.locals.subscription = subscription;
        next();
    }
    catch (err) {
        logger_1.logger.warn('Invalid or expired JWT on feature route.', { error: err });
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
}
