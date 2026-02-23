import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { Logger } from 'winston';
import { encryptToBase64, decryptFromBase64 } from './crypto';
import { Subscription } from './models/subscription';
import { verifyTransactionWithApple } from './appleVerification';
import { config } from './config';

interface PurchaseBody {
  transaction_jws?: string;
  email?: string;
}

export interface SubscriptionJwtPayload {
  sid: string;
  status: string;
}

function signSubscriptionJwt(logger: Logger, subscriptionId: string, status: string): string {
  const secret = config.jwtSecret;
  const expiresIn = config.jwtExpiresInSeconds; // numeric seconds

  return jwt.sign(
    {
      sid: subscriptionId,
      status,
    },
    secret,
    { expiresIn },
  );
}

function extractBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const [scheme, token] = auth.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return token;
}

export function createSubscriptionRouter(logger: Logger): express.Router {
  const router = express.Router();

  router.post('/purchase', async (req: Request, res: Response) => {
    logger.defaultMeta = { traceId: randomUUID() };
    logger.info('Handling subscription purchase request.');

    const body = req.body as PurchaseBody;

    if (!body.transaction_jws || typeof body.transaction_jws !== 'string') {
      logger.warn('Missing or invalid transaction_jws in purchase request.');
      return res.status(400).json({ error: 'transaction_jws is required.' });
    }

    try {
      const status = await verifyTransactionWithApple(logger, body.transaction_jws);

      if (status !== 'active') {
        logger.warn('Subscription is not active after Apple verification.', { status });
        return res
          .status(400)
          .json({ error: 'Subscription is not active.', subscriptionStatus: status });
      }

      const encrypted = encryptToBase64(body.transaction_jws);

      const subscription = await Subscription.create({
        transactionJwsEncrypted: encrypted,
        email: body.email ?? null,
        subscriptionStatus: status,
      });

      const token = signSubscriptionJwt(logger, subscription.id, subscription.subscriptionStatus);

      logger.info('Subscription purchase processed successfully.', {
        subscriptionId: subscription.id,
      });

      return res.json({
        token,
        subscriptionStatus: subscription.subscriptionStatus,
      });
    } catch (err) {
      logger.error('Error handling /subscription/purchase.', { error: err });
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  router.get('/session', async (req: Request, res: Response) => {
    logger.defaultMeta = { traceId: randomUUID() };
    logger.info('Handling subscription session check request.');

    const token = extractBearerToken(req);
    if (!token) {
      logger.warn('Missing bearer token in session request.');
      return res.status(401).json({ subscribed: false, error: 'Missing bearer token.' });
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as SubscriptionJwtPayload;

      const subscription = await Subscription.findByPk(decoded.sid);
      if (!subscription || subscription.subscriptionStatus !== 'active') {
        logger.info('Subscription inactive or not found during session check.', {
          subscriptionId: decoded.sid,
          status: subscription?.subscriptionStatus ?? 'unknown',
        });
        return res.json({
          subscribed: false,
          subscriptionStatus: subscription?.subscriptionStatus ?? 'unknown',
        });
      }

      logger.info('Subscription session is active.', { subscriptionId: subscription.id });
      return res.json({ subscribed: true, subscriptionStatus: subscription.subscriptionStatus });
    } catch (err) {
      logger.warn('Invalid or expired token during session check.', { error: err });
      return res.status(401).json({ subscribed: false, error: 'Invalid or expired token.' });
    }
  });

  router.post('/refresh', async (req: Request, res: Response) => {
    logger.defaultMeta = { traceId: randomUUID() };
    logger.info('Handling subscription refresh request.');

    const token = extractBearerToken(req) ?? (req.body?.token as string | undefined) ?? null;
    if (!token) {
      logger.warn('Missing token in refresh request.');
      return res.status(401).json({ error: 'Missing token.' });
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret, {
        ignoreExpiration: true,
      }) as SubscriptionJwtPayload;

      const subscription = await Subscription.findByPk(decoded.sid);
      if (!subscription) {
        logger.warn('Subscription not found during refresh.', { subscriptionId: decoded.sid });
        return res.status(404).json({ error: 'Subscription not found.' });
      }

      const transactionJws = decryptFromBase64(subscription.transactionJwsEncrypted);

      const status = await verifyTransactionWithApple(logger, transactionJws);
      subscription.subscriptionStatus = status;
      await subscription.save();

      if (status !== 'active') {
        logger.warn('Subscription no longer active during refresh.', {
          subscriptionId: subscription.id,
          status,
        });
        return res
          .status(403)
          .json({ error: 'Subscription no longer active.', subscriptionStatus: status });
      }

      const newToken = signSubscriptionJwt(
        logger,
        subscription.id,
        subscription.subscriptionStatus,
      );

      logger.info('Subscription refreshed successfully.', { subscriptionId: subscription.id });

      return res.json({
        token: newToken,
        subscriptionStatus: subscription.subscriptionStatus,
      });
    } catch (err) {
      logger.error('Error handling /subscription/refresh.', { error: err });
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
