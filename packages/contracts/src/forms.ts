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

// Document types a form slot may ask for. Mirrors the catalog in migration 007 (a test compares them).
// Caste/community certificates and police verification are left out on purpose: a form cannot
// ask for them (Government Documents Policy, ADR-14 as applied by ADR-27).
export const DOC_SUBTYPES = {
  aadhaar: {
    doc_class: 'identity',
    government_issued: true,
    default_sensitivity: 'highly_sensitive',
  },
  pan: { doc_class: 'identity', government_issued: true, default_sensitivity: 'highly_sensitive' },
  passport: {
    doc_class: 'identity',
    government_issued: true,
    default_sensitivity: 'highly_sensitive',
  },
  driving_licence: {
    doc_class: 'identity',
    government_issued: true,
    default_sensitivity: 'highly_sensitive',
  },
  voter_id: {
    doc_class: 'identity',
    government_issued: true,
    default_sensitivity: 'highly_sensitive',
  },
  uan_epf: { doc_class: 'employment', government_issued: true, default_sensitivity: 'sensitive' },
  esic: { doc_class: 'employment', government_issued: true, default_sensitivity: 'sensitive' },
  itr_ack: { doc_class: 'tax', government_issued: true, default_sensitivity: 'sensitive' },
  form16: { doc_class: 'tax', government_issued: false, default_sensitivity: 'sensitive' },
  education_certificate: {
    doc_class: 'education',
    government_issued: false,
    default_sensitivity: 'sensitive',
  },
  address_proof: {
    doc_class: 'address',
    government_issued: false,
    default_sensitivity: 'sensitive',
  },
  bank_cancelled_cheque: {
    doc_class: 'bank',
    government_issued: false,
    default_sensitivity: 'highly_sensitive',
  },
  bank_passbook: {
    doc_class: 'bank',
    government_issued: false,
    default_sensitivity: 'highly_sensitive',
  },
  payslip: { doc_class: 'employment', government_issued: false, default_sensitivity: 'sensitive' },
  experience_letter: {
    doc_class: 'employment',
    government_issued: false,
    default_sensitivity: 'sensitive',
  },
  relieving_letter: {
    doc_class: 'employment',
    government_issued: false,
    default_sensitivity: 'sensitive',
  },
  offer_letter: {
    doc_class: 'employment',
    government_issued: false,
    default_sensitivity: 'sensitive',
  },
  photo: { doc_class: 'photo', government_issued: false, default_sensitivity: 'sensitive' },
  other: { doc_class: 'other', government_issued: false, default_sensitivity: 'sensitive' },
} as const;
export type DocSubtype = keyof typeof DOC_SUBTYPES;
export const DOC_SUBTYPE_KEYS = Object.keys(DOC_SUBTYPES) as [DocSubtype, ...DocSubtype[]];
/** Never sent to AI extraction, whatever the workspace policy says (ADR-14). */
export const NO_AI_SUBTYPES: readonly string[] = [
  'caste_community_certificate',
  'police_verification',
];

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
    doc_subtype: z.enum(DOC_SUBTYPE_KEYS).optional(),
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
    const isAadhaar = s.doc_subtype === 'aadhaar' || AADHAAR.test(`${s.key} ${s.label}`);
    if (isAadhaar && !/mask/i.test(`${s.key} ${s.label}`)) {
      errors.push({ field: s.key, message: 'Aadhaar slots must ask for a masked copy only' });
    }
    if (s.doc_subtype && DOC_SUBTYPES[s.doc_subtype].doc_class !== s.doc_class) {
      errors.push({
        field: s.key,
        message: `Document type ${s.doc_subtype} belongs to class ${DOC_SUBTYPES[s.doc_subtype].doc_class}`,
      });
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

/** Keys of fields that are currently shown. A field whose controlling field is hidden is hidden too.
 *  Shared by the browser and the API so both agree on which required fields apply. */
export function visibleKeys(
  fields: FormDefinition['fields'],
  values: Record<string, unknown>,
): Set<string> {
  const byKey = new Map(fields.map((f) => [f.field_key, f]));
  const memo = new Map<string, boolean>();
  const visit = (key: string, seen: Set<string>): boolean => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const field = byKey.get(key);
    let result = false;
    if (field && !seen.has(key)) {
      const c = field.conditional;
      if (!c) result = true;
      else {
        seen.add(key);
        result =
          visit(c.depends_on, seen) && String(values[c.depends_on] ?? '') === String(c.equals);
      }
    }
    memo.set(key, result);
    return result;
  };
  return new Set(fields.filter((f) => visit(f.field_key, new Set())).map((f) => f.field_key));
}

// ---- Government Documents Policy API (3.5c) ----

export const COLLECT_MODES = ['not_collected', 'optional', 'required'] as const;

/** Body of PUT /v1/document-policies/:doc_subtype. Mirrors the database checks. */
export const documentPolicyBodySchema = z
  .object({
    collect_mode: z.enum(COLLECT_MODES),
    require_masked: z.boolean().default(false),
    store_file: z.boolean().default(true),
    retain_days: z.number().int().positive().max(36500).nullable().default(null),
    purpose: z.string().trim().max(500).default(''),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.collect_mode !== 'not_collected' && v.purpose.length < 10) {
      ctx.addIssue({
        code: 'custom',
        path: ['purpose'],
        message: 'State the purpose for collecting this document (at least 10 characters).',
      });
    }
  });
export type DocumentPolicyBody = z.infer<typeof documentPolicyBodySchema>;

export const documentPolicySchema = z.object({
  doc_subtype: z.enum(DOC_SUBTYPE_KEYS),
  doc_class: z.string(),
  government_issued: z.boolean(),
  collect_mode: z.enum(COLLECT_MODES),
  require_masked: z.boolean(),
  store_file: z.boolean(),
  retain_days: z.number().int().nullable(),
  purpose: z.string(),
  configured: z.boolean(),
});
export const documentPolicyListSchema = z.object({ items: z.array(documentPolicySchema) });
