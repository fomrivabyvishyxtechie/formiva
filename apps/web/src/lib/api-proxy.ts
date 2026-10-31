// Server-side only. The browser talks to this site; this site talks to the API.
// That keeps the API address out of the browser and needs no CORS (ADR-23).
const TOKEN = /^[0-9a-f]{64}$/;
const MAX_BODY = 256 * 1024;

const problem = (status: number, title: string) =>
  new Response(JSON.stringify({ status, title }), {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });

export async function forwardToApi(
  request: Request,
  token: string,
  suffix: '' | '/draft' | '/submit',
): Promise<Response> {
  // A malformed link never reaches the API.
  if (!TOKEN.test(token)) return problem(404, 'Form link not found.');
  const base = process.env.API_BASE_URL;
  if (!base) return problem(503, 'Service unavailable');

  let body: string | undefined;
  if (request.method !== 'GET') {
    body = await request.text();
    if (body.length > MAX_BODY) return problem(413, 'Request too large');
  }

  // Only these headers are passed on: no cookies, no authorization.
  const headers: Record<string, string> = {
    'x-correlation-id': crypto.randomUUID(),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;

  try {
    const upstream = await fetch(`${base.replace(/\/+$/, '')}/public/v1/forms/${token}${suffix}`, {
      method: request.method,
      headers,
      body,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    const out = new Headers({
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    });
    const retryAfter = upstream.headers.get('retry-after');
    if (retryAfter) out.set('retry-after', retryAfter);
    return new Response(await upstream.text(), { status: upstream.status, headers: out });
  } catch {
    return problem(502, 'Bad gateway');
  }
}
