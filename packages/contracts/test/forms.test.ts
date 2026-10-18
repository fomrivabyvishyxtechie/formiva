import { describe, it, expect } from 'vitest';
import { validateFormDefinition, computeSchemaHash, toCanonicalJSON } from '../src/forms.js';

const field = (o: Record<string, unknown> = {}) => ({
  field_key: 'full_name',
  label: 'Full name',
  field_type: 'text',
  sensitivity: 'internal',
  ...o,
});
const slot = (o: Record<string, unknown> = {}) => ({
  key: 'photo',
  label: 'Photo',
  required: true,
  allowed_mime_types: ['image/jpeg'],
  max_size_bytes: 1_000_000,
  doc_class: 'photo',
  ...o,
});
const form = (fields: unknown[] = [field()], slots: unknown[] = []) => ({ fields, slots });
const bad = (def: unknown) => expect(validateFormDefinition(def).valid).toBe(false);

describe('validateFormDefinition', () => {
  it('accepts a correct form', () => {
    expect(validateFormDefinition(form([field()], [slot()])).valid).toBe(true);
  });
  it('rejects duplicate field keys and slot keys', () => {
    bad(form([field(), field({ label: 'B' })]));
    bad(form([field()], [slot(), slot()]));
  });
  it('rejects a 12-digit number in label, validation or slot label', () => {
    bad(form([field({ label: 'Id 123456789012' })]));
    bad(form([field({ validation: { default: '123456789012' } })]));
    bad(form([field()], [slot({ label: '123456789012' })]));
  });
  it('allows long numbers that are not 12 digits', () => {
    expect(validateFormDefinition(form([field({ label: 'Ref 1234567890123' })])).valid).toBe(true);
  });
  it('Aadhaar slot must be a masked copy, for any doc_class', () => {
    bad(form([field()], [slot({ key: 'aadhaar_card', label: 'Aadhaar', doc_class: 'identity' })]));
    bad(form([field()], [slot({ key: 'id_copy', label: 'Aadhar card', doc_class: 'identity' })]));
    expect(
      validateFormDefinition(
        form(
          [field()],
          [slot({ key: 'aadhaar_masked', label: 'Masked Aadhaar', doc_class: 'identity' })],
        ),
      ).valid,
    ).toBe(true);
  });
  it('caste, community and police classes cannot be expressed', () => {
    for (const c of ['caste', 'community', 'police', 'police_verification']) {
      bad(form([field()], [slot({ doc_class: c })]));
    }
  });
  it('rejects bad enums', () => {
    bad(form([field({ field_type: 'rich_text' })]));
    bad(form([field({ sensitivity: 'secret' })]));
  });
  it('rejects unsafe or look-alike keys', () => {
    for (const k of ['__proto__', 'constructor', 'Name', 'nаme', '1abc', 'a b', '']) {
      bad(form([field({ field_key: k })]));
    }
  });
  it('rejects unknown properties (strict)', () => {
    bad(form([field({ extra: 1 })]));
    bad({ ...form(), extra: 1 });
  });
  it('rejects a __proto__ property in the raw JSON', () => {
    bad(JSON.parse('{"fields":[],"slots":[],"__proto__":{"x":1}}'));
  });
  it('conditional must point at an existing other field', () => {
    bad(form([field({ conditional: { depends_on: 'missing', equals: 'x' } })]));
    bad(form([field({ conditional: { depends_on: 'full_name', equals: 'x' } })]));
    expect(
      validateFormDefinition(
        form([
          field(),
          field({ field_key: 'b', conditional: { depends_on: 'full_name', equals: 'x' } }),
        ]),
      ).valid,
    ).toBe(true);
  });
  it('enforces size limits', () => {
    bad(form(Array.from({ length: 101 }, (_, i) => field({ field_key: `f${i}` }))));
    bad(
      form(
        [field()],
        Array.from({ length: 21 }, (_, i) => slot({ key: `s${i}` })),
      ),
    );
    bad(form([field({ label: 'x'.repeat(301) })]));
    bad(form([field()], [slot({ max_size_bytes: 26 * 1024 * 1024 })]));
  });
  it('rejects non-objects', () => {
    for (const v of [null, undefined, 'x', 5, []]) bad(v);
  });
});

describe('canonical JSON and hash', () => {
  it('is stable regardless of key order, at every level', () => {
    const a = { fields: [{ b: 1, a: { y: 1, x: 2 } }], slots: [] };
    const b = { slots: [], fields: [{ a: { x: 2, y: 1 }, b: 1 }] };
    expect(toCanonicalJSON(a)).toBe(toCanonicalJSON(b));
  });
  it('is a 64-char hex SHA-256 (32 bytes) and matches a known vector', async () => {
    const h = await computeSchemaHash({});
    expect(h).toHaveLength(64);
    expect(h).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'); // sha256("{}")
  });
  it('changes when ANY content changes (regression: nested keys were dropped)', async () => {
    const base = await computeSchemaHash(form());
    expect(await computeSchemaHash(form([field({ label: 'Other' })]))).not.toBe(base);
    expect(await computeSchemaHash(form([field({ field_type: 'file' })]))).not.toBe(base);
    expect(await computeSchemaHash(form([field({ sensitivity: 'highly_sensitive' })]))).not.toBe(
      base,
    );
    expect(await computeSchemaHash(form([field({ field_key: 'zzz' })]))).not.toBe(base);
  });
  it('keeps array order meaningful', async () => {
    const a = await computeSchemaHash(form([field(), field({ field_key: 'b' })]));
    const b = await computeSchemaHash(form([field({ field_key: 'b' }), field()]));
    expect(a).not.toBe(b);
  });
});
