import { defineConfig } from 'drizzle-kit';

// Used only for `drizzle-kit generate` (schema diff → SQL). Migrations are applied by
// src/server/db/migrate.ts so the same code path runs locally, in tests and on deploy.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
});
