import { describe, it, expect } from 'vitest';
import { formDefinitionSchema } from '@formiva/contracts';
import { demoForm } from '../fixtures/demo-form';
import {
  DRAFT_PREFIX,
  clearDraft,
  draftKey,
  fieldError,
  fileProblem,
  fromApiValues,
  isDraftable,
  loadDraft,
  pickDraft,
  saveDraft,
  slotError,
  toApiValues,
  visibleKeys,
} from './form-logic';

const def = formDefinitionSchema.parse(demoForm);
const field = (key: string) => def.fields.find((f) => f.field_key === key)!;
const slot = (key: string) => def.slots.find((s) => s.key === key)!;

function memoryStore(failOn?: 'set' | 'get') {
  const m = new Map<string, string>();
  return {
    map: m,
    getItem: (k: string) => {
      if (failOn === 'get') throw new Error('blocked');
      return m.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (failOn === 'set') throw new Error('quota');
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
}

describe('conditional visibility', () => {
  it('hides a conditional field until its controlling value matches', () => {
    expect(visibleKeys(def.fields, {}).has('contract_end_date')).toBe(false);
    expect(visibleKeys(def.fields, { employment_type: 'Full-time' }).has('contract_end_date')).toBe(
      false,
    );
    expect(visibleKeys(def.fields, { employment_type: 'Contract' }).has('contract_end_date')).toBe(
      true,
    );
  });
  it('hides a field whose controlling field is itself hidden', () => {
    const fields = formDefinitionSchema.parse({
      fields: [
        { field_key: 'a', label: 'A', field_type: 'text', sensitivity: 'internal' },
        {
          field_key: 'b',
          label: 'B',
          field_type: 'text',
          sensitivity: 'internal',
          conditional: { depends_on: 'a', equals: 'x' },
        },
        {
          field_key: 'c',
          label: 'C',
          field_type: 'text',
          sensitivity: 'internal',
          conditional: { depends_on: 'b', equals: 'y' },
        },
      ],
      slots: [],
    }).fields;
    expect(visibleKeys(fields, { a: 'no', b: 'y' }).has('c')).toBe(false);
    expect(visibleKeys(fields, { a: 'x', b: 'y' }).has('c')).toBe(true);
  });
});

describe('plain-language errors', () => {
  it('uses the form error_message when present, a short default otherwise', () => {
    expect(fieldError(field('confirm'), false)).toBe('Tick the box to confirm your details');
    expect(fieldError(field('full_name'), '')).toBe('Enter full name');
    expect(fieldError(field('employment_type'), '')).toBe('Choose employment type');
  });
  it('accepts optional empty fields and validates email', () => {
    expect(fieldError(field('notes'), '')).toBeNull();
    expect(fieldError(field('email'), 'not-an-email')).toBe(
      'Enter an email address like name@example.com',
    );
    expect(fieldError(field('email'), 'a@example.com')).toBeNull();
  });
  it('checks files against the slot rules', () => {
    expect(slotError(slot('photo'), undefined)).toBe('Attach passport-size photo');
    expect(slotError(slot('aadhaar_masked'), undefined)).toBeNull();
    expect(fileProblem(slot('photo'), { name: 'a.txt', type: 'text/plain', size: 10 })).toMatch(
      /not allowed/,
    );
    expect(
      fileProblem(slot('photo'), { name: 'a.png', type: 'image/png', size: 5_000_000 }),
    ).toMatch(/too large/);
    expect(fileProblem(slot('photo'), { name: 'a.png', type: 'image/png', size: 10 })).toBeNull();
  });
});

describe('browser drafts', () => {
  const values = { full_name: 'Test Person', bank_reference: 'SECRET-REF', confirm: true };
  it('never keeps sensitive, file or signature fields', () => {
    expect(isDraftable(field('bank_reference'))).toBe(false);
    expect(pickDraft(def.fields, values)).toEqual({ full_name: 'Test Person', confirm: true });
  });
  it('saves under a key built from the schema hash, without sensitive values', () => {
    const s = memoryStore();
    saveDraft(s, 'abc123', def.fields, values);
    expect([...s.map.keys()]).toEqual([`${DRAFT_PREFIX}abc123`]);
    expect(draftKey('abc123')).toBe(`${DRAFT_PREFIX}abc123`);
    expect(s.map.get(draftKey('abc123'))).not.toContain('SECRET-REF');
  });
  it('loads only known, draftable fields and ignores tampered storage', () => {
    const s = memoryStore();
    s.map.set(
      draftKey('h'),
      JSON.stringify({ full_name: 'A', bank_reference: 'X', unknown: 'Y', confirm: 5 }),
    );
    expect(loadDraft(s, 'h', def.fields)).toEqual({ full_name: 'A' });
    s.map.set(draftKey('h'), '{not json');
    expect(loadDraft(s, 'h', def.fields)).toEqual({});
  });
  it('clear removes the draft; an empty draft removes the key', () => {
    const s = memoryStore();
    saveDraft(s, 'h', def.fields, values);
    clearDraft(s, 'h');
    expect(s.map.size).toBe(0);
    saveDraft(s, 'h', def.fields, values);
    saveDraft(s, 'h', def.fields, {});
    expect(s.map.size).toBe(0);
  });
  it('does not crash when storage is blocked or missing', () => {
    expect(() => saveDraft(memoryStore('set'), 'h', def.fields, values)).not.toThrow();
    expect(loadDraft(memoryStore('get'), 'h', def.fields)).toEqual({});
    expect(() => saveDraft(undefined, 'h', def.fields, values)).not.toThrow();
    expect(loadDraft(undefined, 'h', def.fields)).toEqual({});
  });
});

describe('server drafts', () => {
  const fields = formDefinitionSchema.parse({
    fields: [
      { field_key: 'name', label: 'Name', field_type: 'text', sensitivity: 'internal' },
      { field_key: 'age', label: 'Age', field_type: 'number', sensitivity: 'internal' },
      { field_key: 'agree', label: 'Agree', field_type: 'checkbox', sensitivity: 'internal' },
      { field_key: 'note', label: 'Note', field_type: 'textarea', sensitivity: 'sensitive' },
      { field_key: 'bank', label: 'Bank', field_type: 'text', sensitivity: 'highly_sensitive' },
      { field_key: 'sig', label: 'Sign', field_type: 'signature', sensitivity: 'internal' },
      { field_key: 'doc', label: 'Doc', field_type: 'file', sensitivity: 'internal' },
      {
        field_key: 'extra',
        label: 'Extra',
        field_type: 'text',
        sensitivity: 'internal',
        conditional: { depends_on: 'agree', equals: true },
      },
    ],
    slots: [],
  }).fields;

  it('sends only visible, savable, non-empty answers, with numbers as numbers', () => {
    const out = toApiValues(fields, {
      name: 'Test Person',
      age: '41',
      agree: false,
      note: 'kept (sensitive is stored server-side)',
      bank: '000011112222',
      sig: 'Test Person',
      extra: 'hidden by condition',
    });
    expect(out).toEqual({
      name: 'Test Person',
      age: 41,
      agree: false,
      note: 'kept (sensitive is stored server-side)',
    });
  });

  it('skips empty text, empty lists and non-numeric numbers', () => {
    expect(toApiValues(fields, { name: '', age: 'abc' })).toEqual({});
  });

  it('turns saved answers back into form state and ignores unsavable fields', () => {
    expect(fromApiValues(fields, { name: 'A', age: 41, agree: true, bank: 'x', sig: 'y' })).toEqual(
      { name: 'A', age: '41', agree: true },
    );
  });
});
