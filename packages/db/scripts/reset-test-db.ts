// Drops and recreates ONLY the local formiva_test database, then applies every migration.
// formiva_test is the cluster's bootstrap superuser (migration admin); runtime access is tested via SET ROLE formiva_app.
import { Client, Pool } from 'pg';
import { runMigrations } from '../src/migration-runner';

const raw = process.env.DATABASE_URL;
if (!raw) throw new Error('Set DATABASE_URL to the local formiva_test URL first');
const url = new URL(raw);
if (
  !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  url.port !== '55432' ||
  url.pathname !== '/formiva_test' ||
  url.username !== 'formiva_test'
) {
  throw new Error('Refusing to reset anything except formiva_test on localhost:55432');
}

async function main(): Promise<void> {
  const admin = new URL(url.toString());
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  await client.query(
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'formiva_test' AND pid <> pg_backend_pid()",
  );
  await client.query('DROP DATABASE IF EXISTS formiva_test');
  await client.query('CREATE DATABASE formiva_test');
  await client.end();

  const pool = new Pool({ connectionString: raw });
  await runMigrations(pool);
  await pool.end();
  console.log('formiva_test rebuilt from scratch.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
