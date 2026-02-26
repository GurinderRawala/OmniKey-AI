import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'crypto';
import { Logger } from 'winston';
import { Subscription } from './models/subscription';
import { config } from './config';

interface GenerateKeyBody {
  email?: string;
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

  // Admin/backend endpoint to generate a new user subscription key.
  // This is expected to be called after payment or trial creation logic
  // (which will be added separately). The generated key is what the user
  // will enter once into the desktop app.
  router.post('/generate-key', async (req: Request, res: Response) => {
    logger.defaultMeta = { traceId: randomUUID() };
    logger.info('Handling subscription key generation request.');

    const body = req.body as GenerateKeyBody;

    try {
      const rawKey = randomBytes(24).toString('base64url');

      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;

      const subscription = await Subscription.create({
        licenseKey: rawKey,
        email: body.email ?? null,
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

    const body = req.body as ActivateBody;

    if (!body.key || typeof body.key !== 'string') {
      logger.warn('Missing or invalid "key" in activation request body.');
      return res.status(400).json({ error: 'A valid "key" must be provided.' });
    }

    try {
      const subscription = await Subscription.findOne({ where: { licenseKey: body.key } });

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
      if (!subscription) {
        logger.info('Subscription not found during session check.', {
          subscriptionId: decoded.sid,
        });
        return res.json({ subscribed: false, subscriptionStatus: 'unknown' });
      }

      const now = new Date();
      if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
        if (subscription.subscriptionStatus !== 'expired') {
          subscription.subscriptionStatus = 'expired';
          await subscription.save();
        }

        logger.info('Subscription expired during session check.', {
          subscriptionId: subscription.id,
        });

        return res.json({ subscribed: false, subscriptionStatus: 'expired' });
      }

      logger.info('Subscription session is active.', { subscriptionId: subscription.id });
      return res.json({ subscribed: true, subscriptionStatus: 'active' });
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

      const now = new Date();
      if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
        if (subscription.subscriptionStatus !== 'expired') {
          subscription.subscriptionStatus = 'expired';
          await subscription.save();
        }

        logger.warn('Subscription has expired during refresh.', {
          subscriptionId: subscription.id,
        });

        return res
          .status(403)
          .json({ error: 'Subscription has expired.', subscriptionStatus: 'expired' });
      }

      const newToken = signSubscriptionJwt(logger, subscription.id, 'active');

      logger.info('Subscription refreshed successfully.', { subscriptionId: subscription.id });

      return res.json({
        token: newToken,
        subscriptionStatus: 'active',
        expiresAt: subscription.licenseKeyExpiresAt?.toISOString() ?? null,
      });
    } catch (err) {
      logger.error('Error handling /subscription/refresh.', { error: err });
      return res.status(500).json({ error: 'Internal server error.' });
    }
  });

  return router;
}
