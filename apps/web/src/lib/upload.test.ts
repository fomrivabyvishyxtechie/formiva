import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUploads, isPending, STATE_TEXT } from './upload';

const TOKEN = 'a'.repeat(64);
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const file = new File(['synthetic'], 'photo.png', { type: 'image/png' });

afterEach(() => vi.unstubAllGlobals());

describe('createUploads', () => {
  it('asks for a signed address, then sends the file with exactly the signed headers', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return url.endsWith('/upload-requests')
        ? json(201, {
            url: 'https://storage.example.test/x',
            headers: { 'content-type': 'image/png' },
          })
        : new Response('', { status: 200 });
    });
    const result = await createUploads(TOKEN).start('photo', file, false);
    expect(result).toEqual({ ok: true });
    const asked = JSON.parse(String(calls[0]!.init!.body));
    expect(asked).toMatchObject({
      slot_key: 'photo',
      filename: 'photo.png',
      mime_type: 'image/png',
      size_bytes: 9,
    });
    expect(asked.masked_copy_confirmed).toBeUndefined();
    expect(calls[1]!.url).toBe('https://storage.example.test/x');
    expect(calls[1]!.init!.method).toBe('PUT');
    expect(calls[1]!.init!.headers).toEqual({ 'content-type': 'image/png' });
    expect(calls[1]!.init!.body).toBe(file);
  });

  it('sends the masked-copy confirmation only when given', async () => {
    let body = '';
    vi.stubGlobal('fetch', async (_u: string, init?: RequestInit) => {
      body ||= String(init?.body);
      return json(422, { errors: [{ code: 'masked_copy_required' }] });
    });
    const result = await createUploads(TOKEN).start('id', file, true);
    expect(JSON.parse(body).masked_copy_confirmed).toBe(true);
    expect(result).toEqual({ ok: false, message: 'Confirm that this is a masked copy first.' });
  });

  it('gives plain messages for a refused request, a failed upload and no network', async () => {
    vi.stubGlobal('fetch', async () => json(429, {}));
    expect((await createUploads(TOKEN).start('p', file, false)).message).toContain('Too many');
    vi.stubGlobal('fetch', async (u: string) =>
      u.endsWith('/upload-requests')
        ? json(201, { document_id: 'doc-1', url: 'https://s.test/x', headers: {} })
        : new Response('', { status: 403 }),
    );
    // The row exists but the file never arrived: the caller gets the id so it can remove the row.
    const refused = await createUploads(TOKEN).start('p', file, false);
    expect(refused.message).toContain('did not finish');
    expect(refused.documentId).toBe('doc-1');
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect((await createUploads(TOKEN).start('p', file, false)).ok).toBe(false);
  });

  it('lists files, and returns null (not a crash) when the list cannot be read', async () => {
    vi.stubGlobal('fetch', async () =>
      json(200, { documents: [{ document_id: 'd', state: 'ready' }] }),
    );
    expect(await createUploads(TOKEN).list()).toHaveLength(1);
    vi.stubGlobal('fetch', async () => json(500, {}));
    expect(await createUploads(TOKEN).list()).toBeNull();
  });

  it('removes a file; a locked file gets its own message', async () => {
    vi.stubGlobal('fetch', async () => json(200, {}));
    expect(await createUploads(TOKEN).remove('d')).toEqual({ ok: true });
    vi.stubGlobal('fetch', async () => json(409, {}));
    expect((await createUploads(TOKEN).remove('d')).message).toContain('no longer');
  });
});

describe('states', () => {
  it('only uploading and checking count as pending, and no text names an internal reason', () => {
    const doc = (state: 'uploading' | 'checking' | 'ready' | 'not_accepted') =>
      ({ document_id: 'd', slot_key: 's', filename: 'f', size_bytes: 1, state }) as const;
    expect(
      ['uploading', 'checking', 'ready', 'not_accepted'].map((s) => isPending(doc(s as never))),
    ).toEqual([true, true, false, false]);
    expect(Object.values(STATE_TEXT).join(' ')).not.toMatch(/virus|malware|quarantine|scan/i);
  });
});
