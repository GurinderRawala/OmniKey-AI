import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { Logger } from 'winston';
import { logger } from './logger';
import { config } from './config';
import { SubscriptionJwtPayload } from './subscriptionRoutes';
import { Subscription } from './models/subscription';

const SELF_HOSTED_SUBSCRIPTION_ID = 'self-hosted-local-subscription';

export interface AuthLocals {
  logger: Logger;
  subscription: Subscription;
}

export async function selfHostedSubscription(): Promise<Subscription> {
  try {
    // Reuse any existing self-hosted record (including legacy IDs) first.
    const existing = await Subscription.findOne({ where: { isSelfHosted: true } });
    if (existing) return existing;

    // Use a deterministic primary key so concurrent first-time requests do not
    // create duplicate rows.
    const [subscription, created] = await Subscription.findOrCreate({
      where: { id: SELF_HOSTED_SUBSCRIPTION_ID },
      defaults: {
        id: SELF_HOSTED_SUBSCRIPTION_ID,
        email: 'local-user@omnikey.ai',
        licenseKey: 'self-hosted',
        subscriptionStatus: 'active',
        isSelfHosted: true,
      },
    });

    if (created) {
      logger.info('Created self-hosted subscription record in database.');
    }

    // Ensure deterministic row remains flagged for self-hosted mode.
    if (!subscription.isSelfHosted) {
      subscription.isSelfHosted = true;
      await subscription.save();
    }

    return subscription;
  } catch (err) {
    logger.error('Error ensuring self-hosted subscription record exists.', { error: err });
    throw err;
  }
}

export async function authMiddleware(
  req: Request,
  res: Response<any, AuthLocals>,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  const requestLogger = logger.child({ traceId: randomUUID() });
  res.locals.logger = requestLogger;

  if (config.blockSaas) {
    requestLogger.warn('Blocking SaaS access: rejecting request due to BLOCK_SAAS=true');
    return res.status(403).json({ error: 'SaaS access is blocked.' });
  }

  if (config.isSelfHosted || !config.jwtSecret) {
    requestLogger.info('Self-hosted mode: skipping auth middleware.');
    if (config.isSelfHosted) {
      res.locals.subscription = await selfHostedSubscription();
    }
    return next();
  }

  if (!authHeader) {
    requestLogger.warn('Missing Authorization header on feature route.');
    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    requestLogger.warn('Malformed Authorization header on feature route.');
    return res.status(401).json({ error: 'Invalid authorization header.' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as SubscriptionJwtPayload;

    const subscription = await Subscription.findByPk(decoded.sid);
    if (!subscription) {
      requestLogger.warn('Subscription not found for JWT.', { sid: decoded.sid });
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }

    if (subscription.subscriptionStatus == 'expired') {
      requestLogger.warn('Inactive subscription for JWT.', {
        sid: decoded.sid,
        status: subscription.subscriptionStatus,
      });
      return res.status(403).json({ error: 'Subscription is not active.' });
    }

    const now = new Date();
    if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
      subscription.subscriptionStatus = 'expired';
      await subscription.save();

      requestLogger.info('Subscription key has expired during activation.', {
        subscriptionId: subscription.id,
      });

      return res
        .status(403)
        .json({ error: 'Subscription has expired.', subscriptionStatus: 'expired' });
    }

    res.locals.subscription = subscription;
    next();
  } catch (err) {
    requestLogger.warn('Invalid or expired JWT on feature route.', { error: err });
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
}
