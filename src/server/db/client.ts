import pg from 'pg';

// int8 (bigint) columns hold paise. Parse them to numbers, refusing anything unsafe
// instead of silently losing precision.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value out of safe range: ${value}`);
  return n;
});
// `date` columns are IST calendar dates; keep them as "YYYY-MM-DD" strings, never local-time Dates.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

/**
 * Neon hands out `sslmode=require`. node-postgres treats that as verify-full today but will
 * weaken it to libpq semantics in pg v9, so pin verify-full explicitly.
 */
export function normalizeConnectionString(url: string): string {
  const parsed = new URL(url);
  const mode = parsed.searchParams.get('sslmode');
  if (mode === null || mode === 'require' || mode === 'prefer' || mode === 'verify-ca') {
    parsed.searchParams.set('sslmode', 'verify-full');
  }
  return parsed.toString();
}

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({
    connectionString: normalizeConnectionString(connectionString),
    max,
    // Release idle connections quickly so Neon can scale to zero and save CU-hours.
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => {
    console.error('Postgres pool error:', err.message);
  });
  return pool;
}

/** Runs `fn` inside BEGIN/COMMIT on one pooled client, rolling back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === '23505' && (constraint === undefined || e.constraint === constraint);
}
