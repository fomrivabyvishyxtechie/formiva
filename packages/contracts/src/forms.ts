import { z } from 'zod';

// STRICT ENUMS matching DB constraints
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

// Schemas
export const formFieldSchema = z.object({
  field_key: z.string().min(1),
  label: z.string().min(1),
  field_type: z.enum(FIELD_TYPE_ENUM),
  required: z.boolean().default(false),
  sensitivity: z.enum(SENSITIVITY_ENUM),
  validation: z.record(z.unknown()).default({}),
  conditional: z.record(z.unknown()).optional(),
  position: z.number().int().default(0),
  error_message: z.string().optional(),
  accessibility_label: z.string().optional(),
});

export const docSlotSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean(),
  allowed_mime_types: z.array(z.string()),
  max_size_bytes: z.number().int().positive(),
  doc_class: z.enum(DOC_CLASS_ENUM),
});

export const formDefinitionSchema = z.object({
  fields: z.array(formFieldSchema).max(100),
  slots: z.array(docSlotSchema).max(20),
});

// Validator
export type FormValidationError = { field: string; message: string };

export function validateFormDefinition(def: unknown): {
  valid: boolean;
  errors: FormValidationError[];
} {
  const result = formDefinitionSchema.safeParse(def);
  if (result.success) {
    const errors: FormValidationError[] = [];
    const keys = new Set<string>();

    // Check duplicates and ID-like values
    for (const field of result.data.fields) {
      if (keys.has(field.field_key)) {
        errors.push({ field: field.field_key, message: 'Duplicate field_key' });
      }
      keys.add(field.field_key);

      // ID-like value rejection (e.g. 12-digit Aadhaar)
      if (/\b\d{12}\b/.test(field.field_key) || /\b\d{12}\b/.test(field.label)) {
        errors.push({ field: field.field_key, message: 'ID number detected - use masked copy' });
      }
    }

    // Check slots
    for (const slot of result.data.slots) {
      if (
        slot.doc_class === 'other' &&
        slot.key.toLowerCase().includes('aadhaar') &&
        !slot.key.toLowerCase().includes('mask')
      ) {
        errors.push({
          field: slot.key,
          message: 'Full Aadhaar prohibited - only masked copies allowed',
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }
  return {
    valid: false,
    errors: result.error.errors.map((e) => ({ field: e.path.join('.'), message: e.message })),
  };
}

// Canonical JSON and Hashing
export function toCanonicalJSON(def: unknown): string {
  // Simple deterministic stringify
  return JSON.stringify(def, Object.keys(def as object).sort());
}

export async function computeSchemaHash(def: unknown): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(toCanonicalJSON(def));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
