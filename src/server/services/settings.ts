import type pg from 'pg';

/**
 * In-process settings cache. Settings change only through this server (the Phase 5 settings
 * route calls `invalidate()`), so values are cached until invalidated. This keeps background
 * polls from waking Neon. A manual DB edit needs a restart (or redeploy) to take effect.
 */
export class SettingsCache {
  private values: Map<string, unknown> | null = null;
  private loading: Promise<Map<string, unknown>> | null = null;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  private async load(): Promise<Map<string, unknown>> {
    if (this.values) return this.values;
    this.loading ??= this.pool
      .query<{ key: string; value: unknown }>('SELECT key, value FROM settings')
      .then((res) => {
        this.values = new Map(res.rows.map((r) => [r.key, r.value]));
        return this.values;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    const values = await this.load();
    return values.has(key) ? (values.get(key) as T) : fallback;
  }

  invalidate(): void {
    this.values = null;
  }
}
