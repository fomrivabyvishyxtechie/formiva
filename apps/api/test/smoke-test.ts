// Starts the real Fastify app on a random local port with synthetic config and checks two public behaviours.
// Run: pnpm --filter @formiva/api run smoke   (needs DATABASE_URL for the local formiva_test database)
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { buildApp } from '../src/index.js';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const app = await buildApp(
    {
      ...process.env,
      CLERK_SECRET_KEY: 'sk_test_synthetic',
      CLERK_ISSUER: 'https://test.issuer.invalid',
      CLERK_AUDIENCE: 'test-audience',
      CLERK_JWKS_URL: 'https://test.jwks.invalid/.well-known/jwks.json',
      CLERK_AUTHORIZED_PARTIES: 'test-party',
      NODE_ENV: 'development',
    },
    { pool },
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const health = await fetch(`${base}/healthz`);
    if (health.status !== 200) throw new Error(`/healthz expected 200, got ${health.status}`);
    const cases = await fetch(`${base}/v1/cases`);
    if (cases.status !== 401)
      throw new Error(`/v1/cases without token expected 401, got ${cases.status}`);
    console.log('Smoke test passed: /healthz 200, /v1/cases without token 401');
  } finally {
    await app.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
