import { test, expect } from '@playwright/test';

test('production build: the dev demo route does not exist', async ({ request }) => {
  const res = await request.get('/dev/form-demo');
  expect(res.status()).toBe(404);
});

test('production build: security headers are present', async ({ request }) => {
  const res = await request.get('/');
  const h = res.headers();
  expect(res.status()).toBe(200);
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['content-security-policy']).not.toContain('unsafe-eval');
  expect(h['x-powered-by']).toBeUndefined();
});
