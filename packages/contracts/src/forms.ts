import { z } from 'zod';

// Enums mirror the CHECK constraints in migrations 002 (form_fields) and 004 (case_documents).
export const FIELD_TYPE_ENUM = [
  'text',
  'textarea',
  'email',
  'phone',
  'date',
  'number',
  'select',
  'multiselect',
  'checkbox',
  'file',
  'signature',
] as const;

export const SENSITIVITY_ENUM = [
  'public',
  'internal',
  'confidential',
  'sensitive',
  'highly_sensitive',
] as const;

// No caste, community or police classes: they cannot be expressed (Government Documents Policy).
export const DOC_CLASS_ENUM = [
  'identity',
  'address',
  'education',
  'employment',
  'bank',
  'tax',
  'photo',
  'other',
  'unknown',
] as const;

// ASCII snake_case only: blocks unicode look-alikes, "__proto__", "constructor" style keys.
const RESERVED_KEYS = new Set([
  'constructor',
  'prototype',
  'hasownproperty',
  'tostring',
  'valueof',
]);
const keySchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    'Use lowercase letters, digits and underscore, starting with a letter',
  )
  .refine((k) => !RESERVED_KEYS.has(k), 'Reserved name');
const textSchema = z.string().trim().min(1).max(300);

const conditionSchema = z
  .object({
    depends_on: keySchema,
    equals: z.union([z.string().max(300), z.number(), z.boolean()]),
  })
  .strict();

export const formFieldSchema = z
  .object({
    field_key: keySchema,
    label: textSchema,
    field_type: z.enum(FIELD_TYPE_ENUM),
    required: z.boolean().default(false),
    sensitivity: z.enum(SENSITIVITY_ENUM),
    validation: z.record(z.unknown()).default({}),
    conditional: conditionSchema.optional(),
    position: z.number().int().min(0).default(0),
    error_message: z.string().max(300).optional(),
    accessibility_label: z.string().max(300).optional(),
  })
  .strict();

export const docSlotSchema = z
  .object({
    key: keySchema,
    label: textSchema,
    required: z.boolean(),
    allowed_mime_types: z.array(z.string().max(100)).min(1).max(10),
    max_size_bytes: z
      .number()
      .int()
      .positive()
      .max(25 * 1024 * 1024),
    doc_class: z.enum(DOC_CLASS_ENUM),
  })
  .strict();

export const formDefinitionSchema = z
  .object({
    fields: z.array(formFieldSchema).max(100),
    slots: z.array(docSlotSchema).max(20),
  })
  .strict();

export type FormDefinition = z.infer<typeof formDefinitionSchema>;
export type FormValidationError = { field: string; message: string };

const FULL_ID = /(?<!\d)\d{12}(?!\d)/; // 12 digits not part of a longer number
const AADHAAR = /aadh?aa?r|uidai/i;

export function validateFormDefinition(def: unknown): {
  valid: boolean;
  errors: FormValidationError[];
} {
  const parsed = formDefinitionSchema.safeParse(def);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
    };
  }
  const errors: FormValidationError[] = [];
  const keys = new Set<string>();
  const slotKeys = new Set<string>();
  const { fields, slots } = parsed.data;

  for (const f of fields) {
    if (keys.has(f.field_key)) errors.push({ field: f.field_key, message: 'Duplicate field_key' });
    keys.add(f.field_key);
  }
  for (const f of fields) {
    if (f.conditional && !keys.has(f.conditional.depends_on)) {
      errors.push({
        field: f.field_key,
        message: 'Conditional refers to a field that does not exist',
      });
    }
    if (f.conditional?.depends_on === f.field_key) {
      errors.push({ field: f.field_key, message: 'Conditional cannot depend on itself' });
    }
  }
  const texts: [string, string][] = [
    ...fields.flatMap((f): [string, string][] => [
      [f.field_key, f.label],
      [f.field_key, JSON.stringify(f.validation)],
    ]),
    ...slots.map((s): [string, string] => [s.key, s.label]),
  ];
  for (const [where, text] of texts) {
    if (FULL_ID.test(text)) {
      errors.push({
        field: where,
        message: 'Looks like a full ID number - never put one in a form definition',
      });
    }
  }
  for (const s of slots) {
    if (slotKeys.has(s.key)) errors.push({ field: s.key, message: 'Duplicate slot key' });
    slotKeys.add(s.key);
    if (AADHAAR.test(`${s.key} ${s.label}`) && !/mask/i.test(`${s.key} ${s.label}`)) {
      errors.push({ field: s.key, message: 'Aadhaar slots must ask for a masked copy only' });
    }
  }
  return { valid: errors.length === 0, errors };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = canonicalize((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Deterministic JSON: keys sorted at every level; array order is kept (it is meaningful). */
export function toCanonicalJSON(def: unknown): string {
  return JSON.stringify(canonicalize(def));
}

/** Hex SHA-256 of the canonical JSON. Hash the parsed (defaulted) definition, not raw input. */
export async function computeSchemaHash(def: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(toCanonicalJSON(def)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
