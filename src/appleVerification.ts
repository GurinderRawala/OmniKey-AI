import axios from 'axios';
import { Logger } from 'winston';
import { SubscriptionStatus } from './models/subscription';
import { config } from './config';

interface AppleReceiptVerifyResponse {
  status: number;
  // The real response contains many more fields; we only need status for now.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  receipt?: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  latest_receipt_info?: any[];
}

const APPLE_PRODUCTION_VERIFY_RECEIPT_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_SANDBOX_VERIFY_RECEIPT_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

export async function verifyReceiptWithApple(
  logger: Logger,
  base64Receipt: string,
): Promise<SubscriptionStatus> {
  const sharedSecret = config.appleSharedSecret;

  // If no shared secret configured, skip real validation but log a warning.
  if (!sharedSecret || config.isLocal) {
    logger.warn('APPLE_SHARED_SECRET not set; skipping receipt validation and assuming active.');
    return 'active';
  }

  const requestBody = {
    'receipt-data': base64Receipt,
    password: sharedSecret,
    'exclude-old-transactions': true,
  };

  const callEndpoint = async (url: string): Promise<AppleReceiptVerifyResponse> => {
    const resp = await axios.post<AppleReceiptVerifyResponse>(url, requestBody, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    });
    return resp.data;
  };

  try {
    logger.info('Validating App Store receipt with Apple (production endpoint).');
    let result = await callEndpoint(APPLE_PRODUCTION_VERIFY_RECEIPT_URL);

    // Handle sandbox / production mixups according to Apple status codes.
    if (result.status === 21007) {
      logger.info('Receipt is from sandbox environment; retrying against sandbox endpoint.');
      result = await callEndpoint(APPLE_SANDBOX_VERIFY_RECEIPT_URL);
    } else if (result.status === 21008) {
      logger.info('Receipt is from production environment; retrying against production endpoint.');
      result = await callEndpoint(APPLE_PRODUCTION_VERIFY_RECEIPT_URL);
    }

    if (result.status === 0) {
      logger.info('Apple receipt validation succeeded with status 0 (valid receipt).');
      return 'active';
    }

    logger.warn('Apple receipt validation failed with non‑zero status.', {
      status: result.status,
    });
    return 'expired';
  } catch (err) {
    logger.error('Error validating receipt with Apple.', { error: err });
    return 'expired';
  }
}
