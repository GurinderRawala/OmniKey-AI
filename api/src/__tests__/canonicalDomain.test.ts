import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalDomainRedirect } from '../canonicalDomain';

function app() {
  const server = express();
  server.use(canonicalDomainRedirect);
  server.use((_req, res) => res.status(200).send('unchanged'));
  return server;
}

afterEach(() => vi.unstubAllEnvs());

describe('canonical website domain', () => {
  it('does not enable redirects before the new HTTPS endpoint is ready', async () => {
    vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'false');
    await request(app()).get('/blog').set('Host', 'omnikeyai.ca').expect(200);
  });

  it.each(['omnikeyai.ca', 'www.omnikeyai.ca', 'www.getomnikey.com'])(
    'redirects website paths and query strings on %s',
    async (host) => {
      vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'true');
      const result = await request(app())
        .get('/blog/example?ref=newsletter&next=%2Fdocs')
        .set('Host', host)
        .expect(301);
      expect(result.headers.location).toBe(
        'https://getomnikey.com/blog/example?ref=newsletter&next=%2Fdocs',
      );
    },
  );

  it.each([
    '/macos/appcast',
    '/macos/download',
    '/windows/update',
    '/windows/download',
    '/install.sh',
    '/install.ps1',
    '/api/agent',
    '/api/subscription',
    '/health',
    '/downloads/stats',
    '/.well-known/acme-challenge/test',
  ])('preserves installed-client endpoint %s', async (url) => {
    vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'true');
    await request(app()).get(url).set('Host', 'omnikeyai.ca').expect(200);
  });

  it.each([
    'getomnikey.com',
    'localhost:7071',
    'omnikeyai-saas-fmytqc3dra-uc.a.run.app',
    'omnikeyai.ca.example.com',
  ])('does not redirect %s', async (host) => {
    vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'true');
    await request(app()).get('/docs').set('Host', host).expect(200);
  });

  it('ignores forwarded host headers on local and direct service requests', async () => {
    vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'true');
    await request(app())
      .get('/docs')
      .set('Host', 'localhost:7071')
      .set('X-Forwarded-Host', 'omnikeyai.ca')
      .expect(200);
  });

  it('preserves POST requests', async () => {
    vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'true');
    await request(app()).post('/docs').set('Host', 'omnikeyai.ca').send({ value: 1 }).expect(200);
  });

  it('redirects HEAD requests', async () => {
    vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'true');
    await request(app())
      .head('/')
      .set('Host', 'omnikeyai.ca')
      .expect(301)
      .expect('Location', 'https://getomnikey.com/');
  });

  it('does not resolve protocol-relative paths as another origin', async () => {
    vi.stubEnv('OMNIKEY_WEBSITE_REDIRECT_ENABLED', 'true');
    await request(app()).get('//evil.example/path').set('Host', 'omnikeyai.ca').expect(200);
  });
});
