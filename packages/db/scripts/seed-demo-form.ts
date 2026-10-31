// Creates a SYNTHETIC workspace, published form and respondent link in the local formiva_test database,
// then prints the link. For manual testing only. Usage: pnpm --filter @formiva/db db:seed-demo
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runMigrations } from '../src/migration-runner';

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('Set DATABASE_URL first (local formiva_test database).');
const url = new URL(raw);
if (
  !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  url.port !== '55432' ||
  url.pathname !== '/formiva_test'
) {
  throw new Error('Refusing to seed outside the local formiva_test database');
}
const webBase = process.env.WEB_BASE_URL ?? 'http://localhost:3001';

const definition = {
  fields: [
    {
      field_key: 'full_name',
      label: 'Full name',
      field_type: 'text',
      required: true,
      sensitivity: 'internal',
    },
    {
      field_key: 'email',
      label: 'Email',
      field_type: 'email',
      required: true,
      sensitivity: 'internal',
    },
    {
      field_key: 'joining_date',
      label: 'Joining date',
      field_type: 'date',
      sensitivity: 'internal',
    },
    {
      field_key: 'team',
      label: 'Team',
      field_type: 'select',
      sensitivity: 'internal',
      validation: { options: ['Operations', 'Sales', 'Support'] },
    },
    {
      field_key: 'notes',
      label: 'Private notes',
      field_type: 'textarea',
      sensitivity: 'sensitive',
    },
    {
      field_key: 'bank_account',
      label: 'Bank account (cannot be saved yet)',
      field_type: 'text',
      sensitivity: 'highly_sensitive',
    },
  ],
  slots: [
    {
      key: 'photo',
      label: 'Photo',
      required: false,
      allowed_mime_types: ['image/png', 'image/jpeg'],
      max_size_bytes: 2000000,
      doc_class: 'photo',
    },
    {
      key: 'cv',
      label: 'CV',
      required: false,
      allowed_mime_types: ['application/pdf'],
      max_size_bytes: 5000000,
      doc_class: 'other',
    },
  ],
};

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: raw });
  try {
    await runMigrations(pool);
    const suffix = randomUUID().slice(0, 8);
    const ws = randomUUID();
    const template = randomUUID();
    const version = randomUUID();
    await pool.query(`INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, $3)`, [
      ws,
      `demo-${suffix}`,
      `Synthetic demo ${suffix}`,
    ]);
    await pool.query(
      `INSERT INTO form_templates (id, workspace_id, key, name) VALUES ($1, $2, $3, 'Synthetic onboarding form')`,
      [template, ws, `demo-onboarding-${suffix}`],
    );
    await pool.query(
      `INSERT INTO form_template_versions (id, workspace_id, template_id, version_number, status, schema_json, schema_sha256, privacy_notice_version, published_at)
       VALUES ($1, $2, $3, 1, 'published', $4::jsonb, decode(repeat('ab', 32), 'hex'), 'demo-notice-v1', now())`,
      [version, ws, template, JSON.stringify(definition)],
    );
    const token = randomBytes(32).toString('hex');
    await pool.query(
      `INSERT INTO respondent_tokens (workspace_id, form_version_id, purpose, token_hash, expires_at)
       VALUES ($1, $2, 'public_form', $3, now() + interval '1 day')`,
      [ws, version, createHash('sha256').update(token).digest()],
    );
    console.log(
      `\nOpen this link (valid 24 hours, synthetic data only):\n\n  ${webBase}/f/${token}\n`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
