import type { FormDefinition } from '@formiva/contracts';

export type Field = FormDefinition['fields'][number];
export type Slot = FormDefinition['slots'][number];
export type Value = string | boolean | string[];
export type Values = Record<string, Value>;
export type FileInfo = { name: string; type: string; size: number };

export { visibleKeys } from '@formiva/contracts';
import { visibleKeys } from '@formiva/contracts';

export function isEmpty(value: Value | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'boolean') return !value;
  return value.length === 0;
}

export function defaultRequiredMessage(field: Field): string {
  const label = field.label.toLowerCase();
  switch (field.field_type) {
    case 'select':
    case 'multiselect':
      return `Choose ${label}`;
    case 'checkbox':
      return `Tick the box: ${field.label}`;
    case 'file':
      return `Attach ${label}`;
    case 'signature':
      return 'Type your full name to sign';
    case 'date':
      return `Enter ${label} as a date`;
    default:
      return `Enter ${label}`;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[\d\s()-]{6,20}$/;

/** Returns a plain-language message, or null when the value is fine. Hidden fields must not be passed in. */
export function fieldError(field: Field, value: Value | undefined): string | null {
  if (isEmpty(value))
    return field.required ? (field.error_message ?? defaultRequiredMessage(field)) : null;
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (field.field_type === 'email' && !EMAIL.test(v))
    return field.error_message ?? 'Enter an email address like name@example.com';
  if (field.field_type === 'phone' && !PHONE.test(v))
    return field.error_message ?? 'Enter a phone number using digits only';
  if (field.field_type === 'number' && !Number.isFinite(Number(v)))
    return field.error_message ?? 'Enter a number';
  return null;
}

/** Problem with a chosen file, or null. */
export function fileProblem(slot: Slot, file: FileInfo): string | null {
  if (!slot.allowed_mime_types.includes(file.type))
    return 'This file type is not allowed. Choose a different file.';
  if (file.size > slot.max_size_bytes) {
    const mb = Math.floor((slot.max_size_bytes / (1024 * 1024)) * 10) / 10;
    return `This file is too large. The limit is ${mb} MB.`;
  }
  return null;
}

export function slotError(slot: Slot, file: FileInfo | undefined): string | null {
  if (!file) return slot.required ? `Attach ${slot.label.toLowerCase()}` : null;
  return fileProblem(slot, file);
}

export function optionsOf(field: Field): string[] {
  // The contract has no options property yet; options are read from validation.options (see evidence file).
  const raw = (field.validation as Record<string, unknown>)['options'];
  return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string') : [];
}

// ---------- browser drafts ----------
export const DRAFT_PREFIX = 'formiva:draft:';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Only low-sensitivity, non-file answers may be kept in the browser. */
export function isDraftable(field: Field): boolean {
  return (
    field.sensitivity !== 'sensitive' &&
    field.sensitivity !== 'highly_sensitive' &&
    field.field_type !== 'file' &&
    field.field_type !== 'signature'
  );
}

export const draftKey = (schemaHash: string) => `${DRAFT_PREFIX}${schemaHash}`;

export function pickDraft(fields: Field[], values: Values): Values {
  const out: Values = {};
  for (const f of fields) {
    const v = values[f.field_key];
    if (isDraftable(f) && v !== undefined) out[f.field_key] = v;
  }
  return out;
}

export function saveDraft(
  store: Store | undefined,
  hash: string,
  fields: Field[],
  values: Values,
): void {
  try {
    const draft = pickDraft(fields, values);
    if (Object.keys(draft).length === 0) store?.removeItem(draftKey(hash));
    else store?.setItem(draftKey(hash), JSON.stringify(draft));
  } catch {
    /* storage blocked or full: the form keeps working without a draft */
  }
}

export function loadDraft(store: Store | undefined, hash: string, fields: Field[]): Values {
  try {
    const raw = store?.getItem(draftKey(hash));
    if (!raw) return {};
    const data: unknown = JSON.parse(raw);
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    const out: Values = {};
    for (const f of fields) {
      if (!isDraftable(f)) continue;
      const v = (data as Record<string, unknown>)[f.field_key];
      if (typeof v === 'string' || typeof v === 'boolean') out[f.field_key] = v;
      else if (Array.isArray(v) && v.every((x) => typeof x === 'string'))
        out[f.field_key] = v as string[];
    }
    return out;
  } catch {
    return {};
  }
}

export function clearDraft(store: Store | undefined, hash: string): void {
  try {
    store?.removeItem(draftKey(hash));
  } catch {
    /* ignore */
  }
}

export function getStore(): Store | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

// ---------- server drafts (Prompt 3.2b) ----------
export type ApiValue = string | number | boolean | string[];

/** What the draft API accepts today: no files, signatures or highly sensitive answers (3.3 and 3.5 add those). */
export function serverSavable(field: Field): boolean {
  return (
    field.sensitivity !== 'highly_sensitive' &&
    field.field_type !== 'file' &&
    field.field_type !== 'signature'
  );
}

/** Visible, savable, non-empty answers in the shape the API expects (numbers as numbers). */
export function toApiValues(fields: Field[], values: Values): Record<string, ApiValue> {
  const shown = visibleKeys(fields, values);
  const out: Record<string, ApiValue> = {};
  for (const f of fields) {
    if (!shown.has(f.field_key) || !serverSavable(f)) continue;
    const v = values[f.field_key];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (f.field_type === 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out[f.field_key] = n;
      continue;
    }
    out[f.field_key] = v;
  }
  return out;
}

/** Saved answers from the API back into form state (numbers become text for the input). */
export function fromApiValues(fields: Field[], raw: Record<string, unknown>): Values {
  const out: Values = {};
  for (const f of fields) {
    if (!serverSavable(f)) continue;
    const v = raw[f.field_key];
    if (typeof v === 'string' || typeof v === 'boolean') out[f.field_key] = v;
    else if (typeof v === 'number') out[f.field_key] = String(v);
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[f.field_key] = v;
  }
  return out;
}
