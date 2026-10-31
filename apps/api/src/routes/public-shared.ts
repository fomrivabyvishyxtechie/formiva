import type { PoolClient } from 'pg';
import {
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
