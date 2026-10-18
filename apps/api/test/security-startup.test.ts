import { expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

it('throws if a route lacks security metadata', async () => {
  const app = await buildApp({ NODE_ENV: 'test' });
  expect(() => {
    app.get('/unsafe-route', async () => ({ ok: true }));
  }).toThrow('lacks security metadata');
  await app.close();
});
