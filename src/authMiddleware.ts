import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { Logger } from 'winston';
import { logger } from './logger';
import { config } from './config';
import { SubscriptionJwtPayload } from './subscriptionRoutes';
import { Subscription } from './models/subscription';

export interface AuthLocals {
  logger: Logger;
  subscription: Subscription;
}

export async function authMiddleware(
  req: Request,
  res: Response<any, AuthLocals>,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  logger.defaultMeta = { traceId: randomUUID() };

  if (!authHeader) {
    logger.warn('Missing Authorization header on feature route.');
    return res.status(401).json({ error: 'Missing bearer token.' });
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    logger.warn('Malformed Authorization header on feature route.');
    return res.status(401).json({ error: 'Invalid authorization header.' });
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as SubscriptionJwtPayload;

    const subscription = await Subscription.findByPk(decoded.sid);
    if (!subscription) {
      logger.warn('Subscription not found for JWT.', { sid: decoded.sid });
      return res.status(403).json({ error: 'Invalid or expired token.' });
    }

    if (subscription.subscriptionStatus == 'expired') {
      logger.warn('Inactive subscription for JWT.', {
        sid: decoded.sid,
        status: subscription.subscriptionStatus,
      });
      return res.status(403).json({ error: 'Subscription is not active.' });
    }

    const now = new Date();
    if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
      subscription.subscriptionStatus = 'expired';
      await subscription.save();

      logger.info('Subscription key has expired during activation.', {
        subscriptionId: subscription.id,
      });

      return res
        .status(403)
        .json({ error: 'Subscription has expired.', subscriptionStatus: 'expired' });
    }

    res.locals.logger = logger;
    res.locals.subscription = subscription;
    next();
  } catch (err) {
    logger.warn('Invalid or expired JWT on feature route.', { error: err });
    return res.status(403).json({ error: 'Invalid or expired token.' });
  }
}
