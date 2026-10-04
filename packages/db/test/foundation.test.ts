import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Pool } from 'pg';
import { runMigrations } from '../src/migration-runner';
import { withTenant } from '../src/with-tenant';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL must point to the ephemeral PostgreSQL 16 test database');
}

const url = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  url.port !== '55432' ||
  url.pathname !== '/formiva_test' ||
  url.username !== 'formiva_test'
) {
  throw new Error('Refusing to run DB tests outside the designated local formiva_test database');
}

const pool = new Pool({ connectionString: databaseUrl, max: 1 });
const migrationsDirectory = path.resolve(__dirname, '../migrations');
const migrationFiles = fs.readdirSync(migrationsDirectory)
  .filter((filename) => /^\d+_.+\.sql$/.test(filename) && filename !== '009_migration_metadata.sql')
  .sort((left, right) => Number(left.split('_')[0]) - Number(right.split('_')[0]));
const versions = migrationFiles.map((filename) => Number(filename.split('_')[0]));
const migrationChecksums = new Map(
  migrationFiles.map((filename) => [
    Number(filename.split('_')[0]),
    crypto.createHash('sha256').update(fs.readFileSync(path.join(migrationsDirectory, filename))).digest('hex'),
  ]),
);

let fixtureWorkspaceIds: string[] = [];
let fixtureKeys: string[] = [];
let fixturesCreated = false;

async function test(): Promise<void> {
  const connection = await pool.query<{ version: string; current_database: string; rolsuper: boolean }>(
    `SELECT version(), current_database(), role.rolsuper
       FROM pg_roles role
      WHERE role.rolname = current_user`,
  );
  assert.match(connection.rows[0].version, /^PostgreSQL 16\./, 'tests require PostgreSQL 16');
  assert.equal(connection.rows[0].current_database, 'formiva_test');
  assert.equal(connection.rows[0].rolsuper, true, 'test role must be able to create migration roles');
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8], 'migration filenames must be in numbered order');

  const metadataTable = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  const previouslyApplied = metadataTable.rows[0].exists
    ? await pool.query<{ version: number }>('SELECT version FROM schema_migrations')
    : { rows: [] as { version: number }[] };
  const expectedApplyOrder = migrationFiles.filter(
    (filename) => !previouslyApplied.rows.some((row) => Number(row.version) === Number(filename.split('_')[0])),
  );
  const appliedInOrder: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const message = args[0];
    if (typeof message === 'string' && message.startsWith('Applying migration: ')) {
      appliedInOrder.push(message.slice('Applying migration: '.length));
    }
  };
  try {
    await runMigrations(pool);
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(appliedInOrder, expectedApplyOrder, 'migrations should execute in numeric order');

  const recordsAfterApply = await pool.query(
    'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  assert.deepEqual(
    recordsAfterApply.rows.map((row) => Number(row.version)),
    versions,
    'every numbered migration should be recorded',
  );
  for (const record of recordsAfterApply.rows) {
    assert.equal(record.checksum, migrationChecksums.get(Number(record.version)));
  }

  await runMigrations(pool);
  const recordsAfterRerun = await pool.query(
    'SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  assert.deepEqual(recordsAfterRerun.rows, recordsAfterApply.rows, 'rerunning must not alter applied records');

  const originalChecksum = recordsAfterApply.rows[0].checksum as string;
  await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', ['invalid-test-checksum', 1]);
  try {
    await assert.rejects(runMigrations(pool), /Checksum mismatch for migration 001_foundation\.sql/);
    const mismatchRecord = await pool.query('SELECT checksum FROM schema_migrations WHERE version = 1');
    assert.equal(mismatchRecord.rows[0].checksum, 'invalid-test-checksum', 'failed migration transaction must roll back');
  } finally {
    await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [originalChecksum, 1]);
  }

  const suffix = crypto.randomUUID();
  fixtureWorkspaceIds = [crypto.randomUUID(), crypto.randomUUID()];
  fixtureKeys = [`phase21-${suffix}-a`, `phase21-${suffix}-b`];
  const testUserId = crypto.randomUUID();
  await pool.query(
    `INSERT INTO workspaces (id, slug, name)
     VALUES ($1, $3, 'Phase 2.1 synthetic workspace A'),
            ($2, $4, 'Phase 2.1 synthetic workspace B')`,
    [fixtureWorkspaceIds[0], fixtureWorkspaceIds[1], `${suffix}-a`, `${suffix}-b`],
  );
  fixturesCreated = true;
  await pool.query(
    `INSERT INTO form_templates (workspace_id, key, name)
     VALUES ($1, $3, 'Synthetic template A'),
            ($2, $4, 'Synthetic template B')`,
    [fixtureWorkspaceIds[0], fixtureWorkspaceIds[1], fixtureKeys[0], fixtureKeys[1]],
  );

  const context = await withTenant(pool, fixtureWorkspaceIds[0], testUserId, async (client) => {
    await client.query('SET LOCAL ROLE formiva_app');
    const result = await client.query<{ workspace_id: string; user_id: string; key: string }>(
      `SELECT current_setting('app.workspace_id', true) AS workspace_id,
              current_setting('app.user_id', true) AS user_id,
              key
         FROM form_templates`,
    );
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0].workspace_id, fixtureWorkspaceIds[0]);
    assert.equal(result.rows[0].user_id, testUserId);
    assert.equal(result.rows[0].key, fixtureKeys[0]);
    return result.rows[0].workspace_id;
  });
  assert.equal(context, fixtureWorkspaceIds[0]);

  const noContextRows = await withTenant(pool, null, null, async (client) => {
    await client.query('SET LOCAL ROLE formiva_app');
    return client.query('SELECT key FROM form_templates');
  });
  assert.equal(noContextRows.rowCount, 0, 'missing tenant context must return no rows');

  for (const [workspaceId, expectedKey] of [
    [fixtureWorkspaceIds[0], fixtureKeys[0]],
    [fixtureWorkspaceIds[1], fixtureKeys[1]],
  ]) {
    const visibleTemplates = await withTenant(pool, workspaceId, crypto.randomUUID(), async (client) => {
      await client.query('SET LOCAL ROLE formiva_app');
      return client.query<{ key: string }>('SELECT key FROM form_templates');
    });
    assert.deepEqual(visibleTemplates.rows.map((row) => row.key), [expectedKey]);
  }

  const cleanedContext = await pool.query<{ workspace_id: string | null; user_id: string | null }>(
    `SELECT current_setting('app.workspace_id', true) AS workspace_id,
            current_setting('app.user_id', true) AS user_id`,
  );
  assert.ok(
    [null, ''].includes(cleanedContext.rows[0].workspace_id),
    'workspace context must not survive the transaction',
  );
  assert.ok([null, ''].includes(cleanedContext.rows[0].user_id), 'user context must not survive the transaction');

  const rollbackKey = `phase21-${suffix}-rollback`;
  await assert.rejects(
    withTenant(pool, fixtureWorkspaceIds[0], crypto.randomUUID(), async (client) => {
      await client.query('SET LOCAL ROLE formiva_app');
      await client.query(
        'INSERT INTO form_templates (workspace_id, key, name) VALUES ($1, $2, $3)',
        [fixtureWorkspaceIds[0], rollbackKey, 'Must roll back'],
      );
      throw new Error('synthetic transaction rollback');
    }),
    /synthetic transaction rollback/,
  );
  const rolledBackTemplate = await pool.query(
    'SELECT 1 FROM form_templates WHERE workspace_id = $1 AND key = $2',
    [fixtureWorkspaceIds[0], rollbackKey],
  );
  assert.equal(rolledBackTemplate.rowCount, 0, 'callback error must roll back transaction writes');

  const runtimeRoles = await pool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls
       FROM pg_roles
      WHERE rolname = ANY($1::text[])`,
    [['formiva_app', 'formiva_worker', 'formiva_readonly', 'formiva_ops']],
  );
  assert.equal(runtimeRoles.rowCount, 4, 'expected runtime roles must exist');
  for (const role of runtimeRoles.rows) {
    assert.equal(role.rolsuper, false, `${role.rolname} must not be SUPERUSER`);
    assert.equal(role.rolbypassrls, false, `${role.rolname} must not have BYPASSRLS`);
  }
}

test()
  .then(async () => {
    console.log('Phase 2.1 database tests passed');
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (fixturesCreated) {
      await pool.query('DELETE FROM form_templates WHERE workspace_id = ANY($1::uuid[])', [fixtureWorkspaceIds]);
      await pool.query('DELETE FROM workspaces WHERE id = ANY($1::uuid[])', [fixtureWorkspaceIds]);
    }
    await pool.end();
  });
