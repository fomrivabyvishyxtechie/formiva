import { describe, expect, it } from 'vitest';
import { createClamdScanner } from '../src/scanner/clamd';
import { DOCX_MIME, runContentChecks, sniffType } from '../src/scanner/content-checks';
import {
  eicar,
  makeDocx,
  makeJpeg,
  makePdf,
  makePng,
  makeZip,
  startFakeClamd,
} from './support/scan-fixtures';

const reason = (buf: Buffer, mime: string) =>
  runContentChecks(buf, mime).checks.find((c) => c.result !== 'clean')?.reason;

describe('content checks', () => {
  it('sniffs by bytes, not by name', () => {
    expect(sniffType(makePng())).toBe('png');
    expect(sniffType(makeJpeg())).toBe('jpeg');
    expect(sniffType(makePdf())).toBe('pdf');
    expect(sniffType(makeDocx())).toBe('zip');
    expect(sniffType(Buffer.from('MZ\x90\x00 renamed executable'))).toBe('unknown');
  });

  it('rejects a file whose bytes do not match the declared type', () => {
    expect(reason(Buffer.from('MZ\x90\x00 renamed executable'), 'image/png')).toBe('type_mismatch');
    expect(reason(Buffer.from('just text, not a pdf'), 'application/pdf')).toBe('type_mismatch');
    expect(reason(makePng(), 'application/pdf')).toBe('type_mismatch');
    expect(reason(makeZip([{ name: 'a.txt' }]), 'image/png')).toBe('type_mismatch');
  });

  it('strips PNG metadata and appended data, keeps the picture chunks', () => {
    const input = makePng({ metadata: true, trailing: Buffer.from('HIDDEN-PAYLOAD') });
    const out = runContentChecks(input, 'image/png');
    expect(out.checks.every((c) => c.result === 'clean')).toBe(true);
    expect(out.output.includes('Synthetic Person')).toBe(false);
    expect(out.output.includes('synthetic-gps-data')).toBe(false);
    expect(out.output.includes('HIDDEN-PAYLOAD')).toBe(false);
    expect(sniffType(out.output)).toBe('png');
    expect(out.output.length).toBeLessThan(input.length);
  });

  it('strips JPEG EXIF and comments', () => {
    const out = runContentChecks(makeJpeg({ metadata: true }), 'image/jpeg');
    expect(out.checks.every((c) => c.result === 'clean')).toBe(true);
    expect(out.output.includes('synthetic-gps-data')).toBe(false);
    expect(out.output.includes('synthetic comment')).toBe(false);
    expect(out.output.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
  });

  it('rejects oversized images from the header alone', () => {
    expect(reason(makePng({ width: 30_000, height: 30_000 }), 'image/png')).toBe('pixel_limit');
    expect(reason(makeJpeg({ width: 20_000, height: 20_000 }), 'image/jpeg')).toBe('pixel_limit');
    expect(reason(makePng({ width: 5_000, height: 5_001 }), 'image/png')).toBe('pixel_limit');
  });

  it('rejects truncated and malformed images', () => {
    expect(reason(makePng().subarray(0, 40), 'image/png')).toBe('image_malformed');
    expect(reason(makeJpeg().subarray(0, 30), 'image/jpeg')).toBe('image_malformed');
  });

  it('accepts a plain PDF and counts pages', () => {
    const out = runContentChecks(makePdf({ pages: 3 }), 'application/pdf');
    expect(out.checks.every((c) => c.result === 'clean')).toBe(true);
    expect(out.pageCount).toBe(3);
  });

  it('flags PDF active content, encryption, truncation and page floods', () => {
    expect(reason(makePdf({ js: true }), 'application/pdf')).toBe('pdf_active_content');
    expect(reason(makePdf({ encrypted: true }), 'application/pdf')).toBe('pdf_encrypted');
    expect(reason(makePdf().subarray(0, 60), 'application/pdf')).toBe('pdf_malformed');
    expect(reason(makePdf({ pages: 51 }), 'application/pdf')).toBe('page_limit');
  });

  it('accepts a Word document and rejects hostile ZIP structures', () => {
    expect(runContentChecks(makeDocx(), DOCX_MIME).checks.every((c) => c.result === 'clean')).toBe(
      true,
    );
    expect(reason(makeDocx([{ name: 'word/vbaProject.bin' }]), DOCX_MIME)).toBe('office_macros');
    expect(reason(makeDocx([{ name: 'word/embeddings/oleObject1.bin' }]), DOCX_MIME)).toBe(
      'office_embedded_object',
    );
    expect(reason(makeDocx([{ name: 'payload.exe' }]), DOCX_MIME)).toBe('zip_executable_content');
    expect(reason(makeDocx([{ name: '../../evil.txt' }]), DOCX_MIME)).toBe('zip_unsafe_path');
    expect(
      reason(
        makeDocx([{ name: 'bomb.xml', data: Buffer.from('x'), declaredSize: 50 * 1024 * 1024 }]),
        DOCX_MIME,
      ),
    ).toBe('decompression_ratio');
    expect(
      reason(
        makeDocx([
          { name: 'a.xml', data: Buffer.alloc(1_000_000), declaredSize: 90 * 1024 * 1024 },
          { name: 'b.xml', data: Buffer.alloc(1_000_000), declaredSize: 90 * 1024 * 1024 },
        ]),
        DOCX_MIME,
      ),
    ).toBe('decompression_limit');
    expect(reason(makeDocx([{ name: 'secret.xml', flags: 1 }]), DOCX_MIME)).toBe('zip_encrypted');
    expect(reason(makeZip([{ name: 'readme.txt' }]), DOCX_MIME)).toBe('not_a_word_document');
    const whole = makeDocx();
    expect(reason(whole.subarray(0, whole.length - 10), DOCX_MIME)).toBe('zip_malformed');
  });
});

describe('clamd client (against a fake daemon speaking the INSTREAM protocol)', () => {
  it('reports clean, infected, and error when the daemon is unreachable', async () => {
    const clamd = await startFakeClamd();
    const scanner = createClamdScanner({ host: '127.0.0.1', port: clamd.port, timeoutMs: 2000 });
    expect(await scanner.scan(makePng())).toMatchObject({
      result: 'clean',
      version: expect.stringContaining('ClamAV'),
    });
    expect(await scanner.scan(makePdf({ payload: eicar() }))).toMatchObject({
      result: 'infected',
      signature: 'Eicar-Test-Signature',
    });
    const big = Buffer.concat([Buffer.alloc(200_000, 7), Buffer.from(eicar())]); // several chunks
    expect(await scanner.scan(big)).toMatchObject({ result: 'infected' });
    await clamd.close();
    expect(await scanner.scan(makePng())).toMatchObject({ result: 'error' });
  });
});
