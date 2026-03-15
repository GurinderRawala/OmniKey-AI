"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyTransactionWithApple = verifyTransactionWithApple;
const axios_1 = __importDefault(require("axios"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const config_1 = require("./config");
function buildAppleServerJwt(logger) {
    const issuerId = config_1.config.appleIssuerId;
    const keyId = config_1.config.appleKeyId;
    const rawPrivateKey = config_1.config.applePrivateKey;
    const bundleId = config_1.config.appleBundleId;
    const privateKey = rawPrivateKey?.replace(/\\n/g, '\n');
    if (!issuerId || !keyId || !privateKey || !bundleId) {
        logger.error('Missing Apple App Store Server API credentials.');
        throw new Error('Missing Apple App Store Server API credentials.');
    }
    const now = Math.floor(Date.now() / 1000);
    const token = jsonwebtoken_1.default.sign({
        iss: issuerId,
        iat: now,
        exp: now + 60 * 5,
        aud: 'appstoreconnect-v1',
        bid: bundleId,
    }, privateKey, {
        algorithm: 'ES256',
        header: {
            alg: 'ES256',
            kid: keyId,
            typ: 'JWT',
        },
    });
    logger.debug('Built Apple Server JWT token for App Store verification.');
    return token;
}
async function verifyTransactionWithApple(logger, transactionJws) {
    const baseUrl = config_1.config.appleVerifyUrl;
    // If no Apple verify URL configured, assume active but log a warning.
    if (!baseUrl) {
        logger.warn('APPLE_VERIFY_URL not set; skipping real Apple verification and assuming active.');
        return 'active';
    }
    const token = buildAppleServerJwt(logger);
    try {
        logger.info('Verifying transaction with Apple.', { endpoint: baseUrl });
        // This is a placeholder call; adjust the URL/path and payload to match
        // the specific App Store Server API you are using.
        const resp = await axios_1.default.post(baseUrl, { transactionJws }, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            timeout: 5000,
        });
        // TODO: Parse resp.data to determine actual subscription status.
        // For now, treat any 2xx as active.
        if (resp.status >= 200 && resp.status < 300) {
            logger.info('Apple verification returned success status code.', { statusCode: resp.status });
            return 'active';
        }
        logger.warn('Apple verification returned non-success status code.', { statusCode: resp.status });
        return 'expired';
    }
    catch (err) {
        logger.error('Error verifying transaction with Apple.', { error: err });
        return 'expired';
    }
}
