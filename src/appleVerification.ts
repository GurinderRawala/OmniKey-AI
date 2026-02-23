import axios from 'axios';
import jwt from 'jsonwebtoken';
import { Logger } from 'winston';
import { SubscriptionStatus } from './models/subscription';
import { config } from './config';

interface AppleVerificationResponse {
  // Shape simplified; adapt to real App Store Server API response as needed
  data?: unknown;
}

function buildAppleServerJwt(logger: Logger): string {
  const issuerId = config.appleIssuerId;
  const keyId = config.appleKeyId;
  const rawPrivateKey = config.applePrivateKey;
  const bundleId = config.appleBundleId;

  const privateKey = rawPrivateKey?.replace(/\\n/g, '\n');

  if (!issuerId || !keyId || !privateKey || !bundleId) {
    logger.error('Missing Apple App Store Server API credentials.');
    throw new Error('Missing Apple App Store Server API credentials.');
  }

  const now = Math.floor(Date.now() / 1000);

  const token = jwt.sign(
    {
      iss: issuerId,
      iat: now,
      exp: now + 60 * 5,
      aud: 'appstoreconnect-v1',
      bid: bundleId,
    },
    privateKey,
    {
      algorithm: 'ES256',
      header: {
        alg: 'ES256',
        kid: keyId,
        typ: 'JWT',
      },
    },
  );

  logger.debug('Built Apple Server JWT token for App Store verification.');
  return token;
}

export async function verifyTransactionWithApple(
  logger: Logger,
  transactionJws: string,
): Promise<SubscriptionStatus> {
  const baseUrl = config.appleVerifyUrl;

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
    const resp = await axios.post<AppleVerificationResponse>(
      baseUrl,
      { transactionJws },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 5000,
      },
    );

    // TODO: Parse resp.data to determine actual subscription status.
    // For now, treat any 2xx as active.
    if (resp.status >= 200 && resp.status < 300) {
      logger.info('Apple verification returned success status code.', { statusCode: resp.status });
      return 'active';
    }

    logger.warn('Apple verification returned non-success status code.', {
      statusCode: resp.status,
    });
    return 'expired';
  } catch (err) {
    logger.error('Error verifying transaction with Apple.', { error: err });
    return 'expired';
  }
}
