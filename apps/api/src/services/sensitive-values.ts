import type { PoolClient } from 'pg';
import { encryptValue, maskedPreview, type KeyProvider } from '@formiva/crypto';

/**
 * Stores one highly sensitive value as ciphertext (never plaintext, never in value_json).
 * Only the last four characters are kept for display. The caller runs this inside withTenant.
 * Not wired to any route yet: IDs arrive through documents, and AI-extracted values come later.
 */
export async function storeSensitiveValue(
  client: PoolClient,
  provider: KeyProvider,
  input: {
    workspaceId: string;
    caseId: string;
    fieldKey: string;
    revision: number;
    plaintext: string;
    source: 'ai_extraction' | 'human_correction' | 'system';
  },
): Promise<void> {
  const { ciphertext, keyId } = encryptValue(
    provider,
    {
      workspaceId: input.workspaceId,
      caseId: input.caseId,
      fieldKey: input.fieldKey,
      revision: input.revision,
    },
    input.plaintext,
  );
  await client.query(
    `INSERT INTO case_values (workspace_id, case_id, field_key, revision, sensitivity,
                              value_json, value_ciphertext, key_id, masked_preview, source)
     VALUES ($1, $2, $3, $4, 'highly_sensitive', NULL, $5, $6, $7, $8)`,
    [
      input.workspaceId,
      input.caseId,
      input.fieldKey,
      input.revision,
      ciphertext,
      keyId,
      maskedPreview(input.plaintext),
      input.source,
    ],
  );
}
