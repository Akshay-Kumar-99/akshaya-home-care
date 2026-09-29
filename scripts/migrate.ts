import { createPool } from '../src/server/db/client.ts';
import { runMigrations } from '../src/server/db/migrate.ts';

// Usage: npm run db:migrate   (applies /drizzle migrations to DATABASE_URL)
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Add it to .env.');
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  await runMigrations(pool);
  console.log(`Migrations applied to ${new URL(url).hostname}.`);
} catch (err) {
  console.error('Migration failed:', (err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
