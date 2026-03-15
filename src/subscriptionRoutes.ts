import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import zod from 'zod';
import { randomBytes, randomUUID } from 'crypto';
import { Logger } from 'winston';
import { Subscription } from './models/subscription';
import { config } from './config';
import { selfHostedSubscription } from './authMiddleware';

interface GenerateKeyBody {
  email: string;
  // Optional ISO 8601 timestamp for when this key should expire.
  // If omitted or null, the key does not expire.
  expiresAt?: string | null;
}

interface ActivateBody {
  key?: string;
}

export interface SubscriptionJwtPayload {
  sid: string;
  status: string;
}

function signSubscriptionJwt(logger: Logger, subscriptionId: string, status: string): string {
  const secret = config.jwtSecret;
  if (!secret) {
    logger.error('JWT secret is not configured. Cannot sign subscription JWT.');
    throw new Error('JWT secret not configured.');
  }
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

function superAdminAuthMiddleware(req: Request, res: Response, next: express.NextFunction) {
  if (!config.internalApiKey || config.isSelfHosted) {
    return res.status(403).json({ error: 'Internal API key not configured on server.' });
  }
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  const token = authHeader.substring(7); // Remove "Bearer " prefix
  if (config.internalApiKey && token !== config.internalApiKey) {
    return res.status(403).json({ error: 'Forbidden: Invalid API key.' });
  }

  next();
}

export function createSubscriptionRouter(logger: Logger): express.Router {
  const router = express.Router();

  // Admin/backend endpoint to generate a new user subscription key.
  // This is expected to be called after payment or trial creation logic
  // (which will be added separately). The generated key is what the user
  // will enter once into the desktop app.
  router.post('/generate-key', superAdminAuthMiddleware, async (req: Request, res: Response) => {
    logger.defaultMeta = { traceId: randomUUID() };
    logger.info('Handling subscription key generation request.');

    try {
      const body = zod.custom<GenerateKeyBody>().parse(req.body);
      const rawKey = randomBytes(24).toString('base64url');

      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

      const subscription = await Subscription.create({
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
    } catch (err) {
      logger.error('Error handling /subscription/generate-key.', { error: err });
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  // Endpoint used by the client once the user has entered their key in
  // the app. Validates the key, checks expiry, and issues a JWT if the
  // subscription is still valid.
  router.post('/activate', async (req: Request, res: Response) => {
    logger.defaultMeta = { traceId: randomUUID() };
    logger.info('Handling subscription activation request using user key.');

    try {
      const body = zod.custom<ActivateBody>().parse(req.body);
      const subscription = config.isSelfHosted
        ? await selfHostedSubscription()
        : await Subscription.findOne({ where: { licenseKey: body.key } });

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
    } catch (err) {
      logger.error('Error handling /subscription/activate.', { error: err });
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
