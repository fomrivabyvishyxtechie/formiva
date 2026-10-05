import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index';

const clerkConfiguration = {
  CLERK_ISSUER: 'https://issuer.synthetic.invalid/',
  CLERK_AUDIENCE: 'formiva-api-synthetic',
  CLERK_JWKS_URL: 'https://issuer.synthetic.invalid/.well-known/jwks.json',
  CLERK_AUTHORIZED_PARTIES: 'https://formiva.synthetic.invalid',
};

describe('Production auth config', () => {
  it('fails to start when Clerk config missing in non-test env', async () => {
    await expect(buildApp({ NODE_ENV: 'production' }, {})).rejects.toThrow(
      /Missing Clerk configuration/,
    );
  });

  it('does not bypass missing Clerk config in tests without explicit testMode', async () => {
    const app = await buildApp({ NODE_ENV: 'test' });
    app.get('/v1/auth-probe', async (request) => ({
      subject: request.authIdentity?.subject,
    }));

    const response = await app.inject({ method: 'GET', url: '/v1/auth-probe' });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('does not enable testMode in production', async () => {
    const app = await buildApp(
      { NODE_ENV: 'production', ...clerkConfiguration },
      { auth: { testMode: true } },
    );
    app.get('/v1/auth-probe', async (request) => ({
      subject: request.authIdentity?.subject,
    }));

    const response = await app.inject({ method: 'GET', url: '/v1/auth-probe' });

    expect(response.statusCode).toBe(401);
    await app.close();
  });
});
