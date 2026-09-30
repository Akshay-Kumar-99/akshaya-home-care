import type pg from 'pg';
import type { BusinessSettings } from '../../shared/api-types.ts';
import type { BusinessSettingsInput } from '../../shared/schemas.ts';
import { withTransaction } from '../db/client.ts';
import type { Actor } from './types.ts';

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

/** Master's business settings, printed on every invoice message. */
export async function readBusinessSettings(cache: SettingsCache): Promise<BusinessSettings> {
  const [officialPhone, termsUrl] = await Promise.all([
    cache.get<string>('official_phone', '+919841459657'),
    cache.get<string | null>('terms_url', null),
  ]);
  return { officialPhone, termsUrl: termsUrl || null };
}

/** Saves the business settings (Master, with step-up); every change is written to audit_log. */
export async function updateBusinessSettings(
  pool: pg.Pool,
  cache: SettingsCache,
  actor: Actor,
  input: BusinessSettingsInput,
): Promise<BusinessSettings> {
  const next: Record<string, unknown> = { official_phone: input.officialPhone, terms_url: input.termsUrl };
  await withTransaction(pool, async (client) => {
    const old = await client.query<{ key: string; value: unknown }>(
      "SELECT key, value FROM settings WHERE key IN ('official_phone', 'terms_url') FOR UPDATE",
    );
    for (const [key, value] of Object.entries(next)) {
      await client.query(
        `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), actor.id],
      );
    }
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, old_values, new_values, ip)
       VALUES ($1, 'settings.updated', 'settings', 'business', $2, $3, $4)`,
      [actor.id, JSON.stringify(Object.fromEntries(old.rows.map((r) => [r.key, r.value]))), JSON.stringify(next), actor.ip ?? null],
    );
  });
  cache.invalidate();
  return readBusinessSettings(cache);
}
