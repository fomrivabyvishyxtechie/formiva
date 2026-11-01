import type { PoolClient } from 'pg';
import {
  DOC_SUBTYPES,
  formDefinitionSchema,
  validateFormDefinition,
  type FormDefinition,
} from '@formiva/contracts';

export type HttpError = Error & { statusCode: number; publicMessage: string; code: string };
export function httpError(statusCode: number, code: string, message: string): HttpError {
  return Object.assign(new Error(message), { statusCode, publicMessage: message, code });
}
// One message for every bad link, so an attacker cannot tell unknown from expired from revoked.
export const notFound = () => httpError(404, 'not_found', 'Form link not found.');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublishedForm {
  id: string;
  versionId: string;
  slug: string;
  name: string;
  noticeVersion: string | null;
  definition: FormDefinition;
}

export async function loadPublishedForm(
  client: PoolClient,
  versionId: string,
): Promise<PublishedForm> {
  const result = await client.query<{
    template_id: string;
    key: string;
    name: string;
    privacy_notice_version: string | null;
    schema_json: unknown;
  }>(
    `SELECT v.template_id, t.key, t.name, v.privacy_notice_version, v.schema_json
       FROM form_template_versions v
       JOIN form_templates t ON t.id = v.template_id AND t.workspace_id = v.workspace_id
      WHERE v.id = $1 AND v.status = 'published'`,
    [versionId],
  );
  const row = result.rows[0];
  if (!row) throw notFound();
  const checked = validateFormDefinition(row.schema_json);
  if (!checked.valid) throw notFound(); // a broken published definition is never shown or accepted
  return {
    id: row.template_id,
    versionId,
    slug: row.key,
    name: row.name,
    noticeVersion: row.privacy_notice_version,
    definition: formDefinitionSchema.parse(row.schema_json), // parsed: defaults applied
  };
}

export async function auditSafe(
  client: PoolClient,
  action: string,
  caseId: string,
  payload: Record<string, unknown>,
  correlationId: string,
) {
  await client.query(`SELECT app.audit($1, 'case', $2, NULL, $3::jsonb, 'system', NULL, $4)`, [
    action,
    caseId,
    JSON.stringify(payload),
    UUID.test(correlationId) ? correlationId : null,
  ]);
}

export interface SlotPolicy {
  collect_mode: 'not_collected' | 'optional' | 'required';
  require_masked: boolean;
  purpose: string;
  retain_days: number | null;
}
type Slot = FormDefinition['slots'][number];

/** The workspace's document policy for each document type the form's slots ask for (row-level security scopes it). */
export async function loadSlotPolicies(
  client: PoolClient,
  form: PublishedForm,
): Promise<Map<string, SlotPolicy>> {
  const keys = [
    ...new Set(form.definition.slots.flatMap((s) => (s.doc_subtype ? [s.doc_subtype] : []))),
  ];
  if (keys.length === 0) return new Map();
  const r = await client.query<SlotPolicy & { doc_subtype: string }>(
    `SELECT doc_subtype, collect_mode, require_masked, purpose, retain_days
       FROM document_type_policies WHERE doc_subtype = ANY($1::text[])`,
    [keys],
  );
  return new Map(r.rows.map((row) => [row.doc_subtype, row]));
}

/**
 * A slot is offered only when the workspace allows its document type. A government-issued type needs
 * an opt-in policy row (fail closed, Government Documents Policy); other types are allowed unless a
 * policy row says not_collected.
 */
export function slotAllowed(slot: Slot, policies: Map<string, SlotPolicy>): boolean {
  if (!slot.doc_subtype) return true;
  const policy = policies.get(slot.doc_subtype);
  if (DOC_SUBTYPES[slot.doc_subtype].government_issued) {
    return policy !== undefined && policy.collect_mode !== 'not_collected';
  }
  return policy === undefined || policy.collect_mode !== 'not_collected';
}
