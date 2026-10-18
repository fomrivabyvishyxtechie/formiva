// Runs one SQL file against the local formiva_test database (no psql needed). Usage: ts-node scripts/run-sql.ts <file>
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Client } from 'pg';

const raw = process.env.DATABASE_URL;
const file = process.argv[2];
if (!raw || !file) throw new Error('Usage: DATABASE_URL=... ts-node scripts/run-sql.ts <file.sql>');
const url = new URL(raw);
if (
  !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
  url.port !== '55432' ||
  url.pathname !== '/formiva_test'
) {
  throw new Error('Refusing to run SQL outside the local formiva_test database');
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: raw });
  client.on('notice', (n) => console.log(n.message));
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.resolve(file as string), 'utf8'));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
