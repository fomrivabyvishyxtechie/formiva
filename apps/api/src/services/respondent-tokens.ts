import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@formiva/db';

// Respondent links carry 32 random bytes (64 hex chars). Only the SHA-256 digest is stored,
// the same pattern as ADR-19 invitations. A leaked database therefore cannot rebuild a link.
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function hashRespondentToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function generateRespondentToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashRespondentToken(token) };
}

export interface IssueTokenInput {
  workspaceId: string;
  formVersionId: string;
  purpose: 'public_form' | 'resume';
  ttlSeconds: number;
  caseId?: string;
}

/**
 * Creates a respondent link. The raw token is returned once and never stored.
 * Service function only: no HTTP route issues links in 3.2 (the staff/link-issuing route is a later prompt).
 * The caller must already hold a workspace transaction (withTenant) for input.workspaceId.
 */
export async function issueRespondentToken(
  client: PoolClient,
  input: IssueTokenInput,
): Promise<{ token: string; expiresAt: Date }> {
  if (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive integer');
  }
  const { token, hash } = generateRespondentToken();
  const result = await client.query<{ expires_at: Date }>(
    `INSERT INTO respondent_tokens (workspace_id, form_version_id, case_id, purpose, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     RETURNING expires_at`,
    [
      input.workspaceId,
      input.formVersionId,
      input.caseId ?? null,
      input.purpose,
      hash,
      input.ttlSeconds,
    ],
  );
  return { token, expiresAt: result.rows[0]!.expires_at };
}

export interface ResolvedToken {
  workspaceId: string;
  formVersionId: string;
  caseId: string | null;
  purpose: 'public_form' | 'resume';
}

/** Unknown, malformed, expired and revoked tokens all return null, so callers cannot tell them apart. */
export async function resolveRespondentToken(
  pool: Pool,
  token: string,
): Promise<ResolvedToken | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const hash = hashRespondentToken(token);
  const rows = await withTenant(pool, null, null, async (client) => {
    const result = await client.query<{
      ws_id: string;
      form_version_id: string;
      case_id: string | null;
      purpose: 'public_form' | 'resume';
    }>('SELECT ws_id, form_version_id, case_id, purpose FROM ops.resolve_respondent_token($1)', [
      hash,
    ]);
    return result.rows;
  });
  const row = rows[0];
  return row
    ? {
        workspaceId: row.ws_id,
        formVersionId: row.form_version_id,
        caseId: row.case_id,
        purpose: row.purpose,
      }
    : null;
}
