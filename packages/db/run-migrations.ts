import { Pool } from 'pg';
import { runMigrations } from './src/migration-runner';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

runMigrations(pool)
  .then(() => {
    console.log('Migrations applied successfully');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed', err);
    process.exit(1);
  });
