import { describe, it, expect } from 'vitest';
import { validateFormDefinition, computeSchemaHash } from '../src/forms.js';

describe('Form Definition Validation', () => {
  it('validates a correct form', () => {
    const def = {
      fields: [{ field_key: 'name', label: 'Name', field_type: 'text', sensitivity: 'internal' }],
      slots: [],
    };
    const result = validateFormDefinition(def);
    expect(result.valid).toBe(true);
  });

  it('rejects duplicate field keys', () => {
    const def = {
      fields: [
        { field_key: 'a', label: 'A', field_type: 'text', sensitivity: 'internal' },
        { field_key: 'a', label: 'B', field_type: 'text', sensitivity: 'internal' },
      ],
      slots: [],
    };
    const result = validateFormDefinition(def);
    expect(result.valid).toBe(false);
  });

  it('rejects 12-digit ID values', () => {
    const def = {
      fields: [
        {
          field_key: '123456789012',
          label: 'Aadhaar',
          field_type: 'text',
          sensitivity: 'sensitive',
        },
      ],
      slots: [],
    };
    const result = validateFormDefinition(def);
    expect(result.valid).toBe(false);
  });
});

describe('Hashing', () => {
  it('produces consistent hashes', async () => {
    const def = { fields: [], slots: [] };
    const hash1 = await computeSchemaHash(def);
    const hash2 = await computeSchemaHash(def);
    expect(hash1).toBe(hash2);
  });
});
