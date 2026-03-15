"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSubscriptionRouter = createSubscriptionRouter;
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const zod_1 = __importDefault(require("zod"));
const crypto_1 = require("crypto");
const subscription_1 = require("./models/subscription");
const config_1 = require("./config");
const authMiddleware_1 = require("./authMiddleware");
function signSubscriptionJwt(logger, subscriptionId, status) {
    const secret = config_1.config.jwtSecret;
    if (!secret) {
        logger.error('JWT secret is not configured. Cannot sign subscription JWT.');
        throw new Error('JWT secret not configured.');
    }
    const expiresIn = config_1.config.jwtExpiresInSeconds; // numeric seconds
    return jsonwebtoken_1.default.sign({
        sid: subscriptionId,
        status,
    }, secret, { expiresIn });
}
function superAdminAuthMiddleware(req, res, next) {
    if (!config_1.config.internalApiKey || config_1.config.isSelfHosted) {
        return res.status(403).json({ error: 'Internal API key not configured on server.' });
    }
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
    }
    const token = authHeader.substring(7); // Remove "Bearer " prefix
    if (config_1.config.internalApiKey && token !== config_1.config.internalApiKey) {
        return res.status(403).json({ error: 'Forbidden: Invalid API key.' });
    }
    next();
}
function createSubscriptionRouter(logger) {
    const router = express_1.default.Router();
    // Admin/backend endpoint to generate a new user subscription key.
    // This is expected to be called after payment or trial creation logic
    // (which will be added separately). The generated key is what the user
    // will enter once into the desktop app.
    router.post('/generate-key', superAdminAuthMiddleware, async (req, res) => {
        logger.defaultMeta = { traceId: (0, crypto_1.randomUUID)() };
        logger.info('Handling subscription key generation request.');
        try {
            const body = zod_1.default.custom().parse(req.body);
            const rawKey = (0, crypto_1.randomBytes)(24).toString('base64url');
            const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
            const subscription = await subscription_1.Subscription.create({
                licenseKey: rawKey,
                email: body.email,
                subscriptionStatus: 'active',
                licenseKeyExpiresAt: expiresAt,
            });
            logger.info('Subscription key generated successfully.', {
                subscriptionId: subscription.id,
            });
            return res.json({
                key: rawKey,
                subscriptionId: subscription.id,
                subscriptionStatus: subscription.subscriptionStatus,
                expiresAt: subscription.licenseKeyExpiresAt?.toISOString() ?? null,
            });
        }
        catch (err) {
            logger.error('Error handling /subscription/generate-key.', { error: err });
            return res.status(500).json({ error: 'Internal server error.' });
        }
    });
    // Endpoint used by the client once the user has entered their key in
    // the app. Validates the key, checks expiry, and issues a JWT if the
    // subscription is still valid.
    router.post('/activate', async (req, res) => {
        logger.defaultMeta = { traceId: (0, crypto_1.randomUUID)() };
        logger.info('Handling subscription activation request using user key.');
        try {
            const body = zod_1.default.custom().parse(req.body);
            const subscription = config_1.config.isSelfHosted
                ? await (0, authMiddleware_1.selfHostedSubscription)()
                : await subscription_1.Subscription.findOne({ where: { licenseKey: body.key } });
            if (!subscription) {
                logger.warn('No subscription found for provided key.');
                return res
                    .status(401)
                    .json({ error: 'Invalid subscription key.', subscriptionStatus: 'unknown' });
            }
            const now = new Date();
            if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
                if (subscription.subscriptionStatus !== 'expired') {
                    subscription.subscriptionStatus = 'expired';
                    await subscription.save();
                }
                logger.info('Subscription key has expired during activation.', {
                    subscriptionId: subscription.id,
                });
                return res
                    .status(403)
                    .json({ error: 'Subscription has expired.', subscriptionStatus: 'expired' });
            }
            // If the key has not expired, treat the subscription as valid and
            // issue a JWT, regardless of past status values. We only block
            // access if the subscription is expired.
            const token = signSubscriptionJwt(logger, subscription.id, 'active');
            logger.info('Subscription key activation successful.', {
                subscriptionId: subscription.id,
            });
            return res.json({
                token,
                subscriptionStatus: 'active',
                expiresAt: subscription.licenseKeyExpiresAt?.toISOString() ?? null,
            });
        }
        catch (err) {
            logger.error('Error handling /subscription/activate.', { error: err });
            return res.status(500).json({ error: 'Internal server error.' });
        }
    });
    return router;
}
