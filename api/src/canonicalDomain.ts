import type { RequestHandler } from 'express';

const CANONICAL_ORIGIN = 'https://getomnikey.com';
const LEGACY_HOSTS = new Set(['omnikeyai.ca', 'www.omnikeyai.ca', 'www.getomnikey.com']);

/** Redirect only website reads; installed clients must retain their original endpoints. */
export const canonicalDomainRedirect: RequestHandler = (req, res, next) => {
  if (
    process.env.OMNIKEY_WEBSITE_REDIRECT_ENABLED !== 'true' ||
    !LEGACY_HOSTS.has((req.get('host') ?? '').toLowerCase().split(':')[0]) ||
    !['GET', 'HEAD'].includes(req.method)
  ) {
    next();
    return;
  }

  const pathname = req.path.toLowerCase();
  if (
    /^\/(?:api|macos|windows|downloads|health)(?:\/|$)/.test(pathname) ||
    /^\/install\.(?:sh|ps1)$/.test(pathname) ||
    pathname.startsWith('/.well-known/') ||
    !req.originalUrl.startsWith('/') ||
    req.originalUrl.startsWith('//') ||
    req.originalUrl.includes('\\')
  ) {
    next();
    return;
  }

  // Concatenate onto a fixed origin, never resolve user-supplied URLs as hosts.
  res.redirect(301, `${CANONICAL_ORIGIN}${req.originalUrl}`);
};
