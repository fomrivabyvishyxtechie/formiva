import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export async function runMigrations(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Ensure migration table exists
    const metadataSql = fs.readFileSync(path.join(__dirname, '../migrations/009_migration_metadata.sql'), 'utf8');
    await client.query(metadataSql);

    const migrationFiles = fs.readdirSync(path.join(__dirname, '../migrations'))
      .filter(f => f.endsWith('.sql') && f !== '009_migration_metadata.sql')
      .sort();

    for (const filename of migrationFiles) {
      const version = parseInt(filename.split('_')[0]);
      const filePath = path.join(__dirname, '../migrations', filename);
      const sql = fs.readFileSync(filePath, 'utf8');
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      const { rows } = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [version]);

      if (rows.length > 0) {
        if (rows[0].checksum !== checksum) {
          throw new Error(`Checksum mismatch for migration ${filename}. Expected ${checksum}, found ${rows[0].checksum}`);
        }
      } else {
        console.log(`Applying migration: ${filename}`);
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [version, checksum]);
      }
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
