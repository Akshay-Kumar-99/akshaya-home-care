import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';

export const MIGRATIONS_FOLDER = path.resolve(import.meta.dirname, '../../../drizzle');

/** Applies pending SQL migrations from /drizzle. Safe to run repeatedly. */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const db = drizzle({ client: pool });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
