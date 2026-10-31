import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forwardToApi } from './api-proxy';

const TOKEN = 'a'.repeat(64);

describe('forwardToApi', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('API_BASE_URL', 'http://api.test/');
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('answers 404 for a malformed token without calling the API', async () => {
    const res = await forwardToApi(new Request('http://web/x'), 'not-a-token', '');
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503 when API_BASE_URL is not set', async () => {
    vi.stubEnv('API_BASE_URL', '');
    const res = await forwardToApi(new Request('http://web/x'), TOKEN, '');
    expect(res.status).toBe(503);
  });

  it('passes status and body through, forwards only safe headers, never caches', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"ok":true}', {
        status: 429,
        headers: { 'retry-after': '7', 'set-cookie': 'a=b' },
      }),
    );
    const request = new Request('http://web/x', {
      method: 'PUT',
      body: '{"a":1}',
      headers: {
        cookie: 'session=secret',
        authorization: 'Bearer secret',
        'x-forwarded-for': '203.0.113.9',
      },
    });
    const res = await forwardToApi(request, TOKEN, '/draft');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('set-cookie')).toBeNull();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`http://api.test/public/v1/forms/${TOKEN}/draft`);
    const sent = init.headers as Record<string, string>;
    expect(sent['x-forwarded-for']).toBe('203.0.113.9');
    expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain('cookie');
    expect(Object.keys(sent).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('answers 502 when the API is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    const res = await forwardToApi(new Request('http://web/x'), TOKEN, '');
    expect(res.status).toBe(502);
  });

  it('refuses oversized bodies', async () => {
    const res = await forwardToApi(
      new Request('http://web/x', { method: 'PUT', body: 'x'.repeat(300 * 1024) }),
      TOKEN,
      '/draft',
    );
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a submit to the submit path', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    const res = await forwardToApi(
      new Request('http://web/x', { method: 'POST', body: '{"a":1}' }),
      TOKEN,
      '/submit',
    );
    expect(res.status).toBe(202);
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://api.test/public/v1/forms/${TOKEN}/submit`);
  });
});
