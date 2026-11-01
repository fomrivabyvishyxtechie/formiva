import { describe, expect, it } from 'vitest';
import { createClamdScanner } from '../../apps/api/src/scanner/clamd.js';
import { eicar } from '../../apps/api/test/support/scan-fixtures.js';

// Test 2 of docs/runbooks/phase-3-exit-tests.md. Skipped unless CLAMD_PORT is set, so CI and normal runs ignore it.
// Finding (2026-11-01, ClamAV 1.5.4): the test string is flagged when it is the file, but NOT when buried mid-file, so there is no
// "hidden inside a big file" case here. That is how this one test signature behaves, not evidence about real malware signatures.
// It talks to a REAL ClamAV (clamd) over TCP. The anti-virus test string stays in memory: it is never written to disk.
const port = Number(process.env.CLAMD_PORT);
const scanner = createClamdScanner({
  host: process.env.CLAMD_HOST ?? '127.0.0.1',
  port,
  timeoutMs: 60_000,
});

describe.skipIf(!process.env.CLAMD_PORT)('real ClamAV (clamd)', () => {
  it('reports a version and calls ordinary bytes clean', async () => {
    const r = await scanner.scan(Buffer.from('synthetic harmless text, nothing to see'));
    expect(r, JSON.stringify(r)).toMatchObject({ result: 'clean' });
    if (r.result === 'clean') expect(r.version.length).toBeGreaterThan(0);
  });

  it('flags the standard anti-virus test string', async () => {
    const r = await scanner.scan(Buffer.from(eicar()));
    expect(r, JSON.stringify(r)).toMatchObject({ result: 'infected' });
    if (r.result === 'infected') expect(r.signature).toMatch(/eicar/i);
  });

  it('calls a 5 MB clean file clean', async () => {
    const r = await scanner.scan(Buffer.alloc(5 * 1024 * 1024, 0x20));
    expect(r, JSON.stringify(r)).toMatchObject({ result: 'clean' });
  });

  it('reports an error (never "clean") when nothing is listening', async () => {
    const dead = createClamdScanner({ host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    expect((await dead.scan(Buffer.from('x'))).result).toBe('error');
  });
});
