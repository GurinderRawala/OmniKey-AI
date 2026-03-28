import jwt from 'jsonwebtoken';
import { config } from '../config';
import { logger } from '../logger';
import { Subscription } from '../models/subscription';
import { selfHostedSubscription } from '../authMiddleware';

interface DecodedJwtPayload {
  sid: string;
}

/**
 * Authenticates a WebSocket connection from a Bearer token in the Authorization header.
 *
 * In self-hosted mode, skips JWT verification and returns the self-hosted subscription directly.
 * Otherwise, verifies the JWT, looks up the subscription by ID, and checks that it is not expired.
 * Marks the subscription as expired and persists the change if the license key has passed its expiry date.
 *
 * @param authHeader - The raw `Authorization` header value (e.g. `"Bearer <token>"`).
 * @param log - Logger instance scoped to the current connection.
 * @returns The authenticated `Subscription`, or `null` if authentication fails for any reason.
 */
export async function authenticateFromAuthHeader(
  authHeader: string | undefined,
  log: typeof logger,
): Promise<Subscription | null> {
  if (config.isSelfHosted) {
    log.info('Self-hosted mode: skipping JWT authentication for agent WebSocket connection.');
    try {
      const subscription = await selfHostedSubscription();
      log.info('Retrieved self-hosted subscription for agent WebSocket connection', {
        subscriptionId: subscription.id,
      });
      return subscription;
    } catch (err) {
      log.error('Failed to retrieve self-hosted subscription for agent WebSocket connection', {
        error: err,
      });
      return null;
    }
  }

  if (!config.jwtSecret) {
    log.error('JWT secret is not configured. Cannot authenticate subscription from auth header.');
    return null;
  }
  if (!authHeader) {
    log.warn('Agent WebSocket connection missing authorization header');
    return null;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme !== 'Bearer' || !token) {
    log.warn('Agent WebSocket connection has malformed authorization header');
    return null;
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as DecodedJwtPayload;
    const subscription = await Subscription.findByPk(decoded.sid);

    if (!subscription) {
      log.warn('Agent WebSocket auth failed: subscription not found', {
        sid: decoded.sid,
      });
      return null;
    }

    if (subscription.subscriptionStatus === 'expired') {
      log.warn('Agent WebSocket auth failed: subscription expired', {
        sid: decoded.sid,
      });
      return null;
    }

    const now = new Date();
    if (subscription.licenseKeyExpiresAt && subscription.licenseKeyExpiresAt <= now) {
      subscription.subscriptionStatus = 'expired';
      await subscription.save();

      log.info('Agent WebSocket auth: subscription key expired during connection', {
        subscriptionId: subscription.id,
      });

      return null;
    }

    log.debug('Agent WebSocket auth succeeded', {
      subscriptionId: subscription.id,
      status: subscription.subscriptionStatus,
    });
    return subscription;
  } catch (err) {
    log.warn('Agent WebSocket auth failed: invalid or expired JWT', { error: err });
    return null;
  }
}

export type AuthContext = {
  ensureAuthenticated: () => Promise<boolean>;
  getSubscription: () => Subscription | null;
};

/**
 * Creates a lazy authentication context for a WebSocket connection.
 *
 * Authentication is deferred until the first call to `ensureAuthenticated`, and the result
 * is cached so subsequent calls resolve immediately without re-verifying the token.
 * Concurrent calls during the first authentication are coalesced into a single in-flight promise.
 *
 * @param authHeader - The raw `Authorization` header value forwarded from the upgrade request.
 * @param log - Logger instance scoped to the current connection.
 * @returns An `AuthContext` with `ensureAuthenticated` and `getSubscription` accessors.
 */
export function createLazyAuthContext(
  authHeader: string | undefined,
  log: typeof logger,
): AuthContext {
  let authenticatedSubscription: Subscription | null = null;
  let authFailed = false;
  let authPromise: Promise<void> | null = null;

  const ensureAuthenticated = async (): Promise<boolean> => {
    if (authenticatedSubscription) {
      return true;
    }
    if (authFailed) {
      return false;
    }

    if (!authPromise) {
      authPromise = (async () => {
        try {
          const sub = await authenticateFromAuthHeader(authHeader, log);
          if (!sub) {
            authFailed = true;
            return;
          }
          authenticatedSubscription = sub;
          log.info('Agent WebSocket authenticated', {
            subscriptionId: authenticatedSubscription.id,
          });
        } catch (err) {
          authFailed = true;
          log.error('Unexpected error during agent WebSocket auth', { error: err });
        }
      })();
    }

    await authPromise;
    return Boolean(authenticatedSubscription);
  };

  const getSubscription = () => authenticatedSubscription;

  return { ensureAuthenticated, getSubscription };
}
