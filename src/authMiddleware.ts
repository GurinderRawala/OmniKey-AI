import { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { Logger } from 'winston';
import { logger } from './logger';
import { config } from './config';
import { SubscriptionJwtPayload } from './subscriptionRoutes';

export interface AuthLocals {
  logger: Logger;
  subscription: SubscriptionJwtPayload;
}

export function authMiddleware(req: Request, res: Response<any, AuthLocals>, next: NextFunction) {
  const authHeader = req.headers.authorization;
  logger.defaultMeta = { traceId: randomUUID() };

  if (config.isLocal) {
    res.locals.logger = logger;
    next();
    return;
  }

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

    res.locals.logger = logger;
    res.locals.subscription = decoded;
    next();
  } catch (err) {
    logger.warn('Invalid or expired JWT on feature route.', { error: err });
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}
