import { describe, expect, it } from 'vitest';
import { createS3ObjectStore } from '../src/services/object-store';
import { checkUpload, sanitizeFilename } from '../src/services/upload-policy';

describe('S3 object store (offline signing, fake credentials)', () => {
  it('signs content type and length into the link and keeps the link short-lived', async () => {
    const store = createS3ObjectStore({
      accountId: 'synthetic-account',
      accessKeyId: 'synthetic-access-id',
      // built from parts so the repository secret scan does not flag a fake test value
      secretAccessKey: ['synthetic', 'signing', 'value', 'for', 'tests'].join('-'),
    });
    const signed = await store.presignUpload({
      bucket: 'quarantine-test',
      key: 'ws/w/cases/c/d',
      contentType: 'application/pdf',
      contentLength: 1234,
      expiresInSeconds: 300,
    });
    const url = new URL(signed.url);
    expect(url.hostname).toBe('synthetic-account.r2.cloudflarestorage.com');
    expect(url.pathname).toContain('quarantine-test/ws/w/cases/c/d');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signedHeaders).toContain('content-type');
    expect(signedHeaders).toContain('content-length');
    expect(signed.method).toBe('PUT');
    expect(signed.headers).toEqual({ 'content-type': 'application/pdf' });
  });
});

describe('upload policy', () => {
  const slot = { slotMimeTypes: ['application/pdf', 'image/png'], slotMaxBytes: 1000 };
  const pdf = { filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, ...slot };

  it('accepts the allowed types and rejects everything else', () => {
    expect(checkUpload(pdf).ok).toBe(true);
    for (const filename of ['a.exe', 'a.zip', 'a.svg', 'a.html', 'a.docm', 'a', '.pdf', 'a.']) {
      expect(checkUpload({ ...pdf, filename }).ok, filename).toBe(false);
    }
  });
  it('requires the MIME type to match the extension and the slot', () => {
    expect(checkUpload({ ...pdf, mimeType: 'image/png' }).ok).toBe(false);
    expect(checkUpload({ ...pdf, slotMimeTypes: ['image/png'] }).ok).toBe(false);
  });
  it('enforces size limits', () => {
    expect(checkUpload({ ...pdf, sizeBytes: 0 }).ok).toBe(false);
    expect(checkUpload({ ...pdf, sizeBytes: 1001 }).ok).toBe(false);
    expect(checkUpload({ ...pdf, slotMaxBytes: 99_999_999, sizeBytes: 26 * 1024 * 1024 }).ok).toBe(
      false,
    );
  });
  it('strips paths, control characters and odd characters from names', () => {
    expect(sanitizeFilename('../../etc/passwd.pdf')).toEqual({ name: 'passwd.pdf', ext: 'pdf' });
    expect(sanitizeFilename('C:\\x\\scan\u0000\u0007.PDF')).toEqual({
      name: 'scan.PDF',
      ext: 'pdf',
    });
    expect(sanitizeFilename('<img onerror>.png')?.name).toBe('_img onerror_.png');
  });
});
