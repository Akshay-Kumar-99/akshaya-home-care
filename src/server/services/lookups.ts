import type pg from 'pg';
import type { CustomerLookup } from '../../shared/api-types.ts';
import { withActorContext } from '../db/actor-context.ts';
import type { Actor } from './types.ts';
import { liveWarranties, recentVisits } from './warranty.ts';

export interface Lookups {
  applianceTypes: Array<{ key: string; label: string }>;
  areas: Array<{ id: string; name: string }>;
  brands: Array<{ id: string; name: string }>;
  servicePresets: string[];
}

/**
 * Controlled vocabularies for the job form (chips and typeaheads). Admin-managed and
 * rarely changed, so cached in process; the Phase 5 vocabulary manager calls invalidate().
 */
export class LookupsCache {
  private value: Lookups | null = null;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  async get(): Promise<Lookups> {
    if (this.value) return this.value;
    const [types, areas, brands, presets] = await Promise.all([
      this.pool.query<{ key: string; label: string }>(
        'SELECT key, label FROM appliance_types WHERE active ORDER BY sort_order, label',
      ),
      this.pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM areas WHERE active AND merged_into_id IS NULL ORDER BY name',
      ),
      this.pool.query<{ id: string; name: string }>(
        'SELECT id, name FROM brands WHERE active AND merged_into_id IS NULL ORDER BY name',
      ),
      this.pool.query<{ label: string }>('SELECT label FROM service_presets WHERE active ORDER BY sort_order, label'),
    ]);
    this.value = {
      applianceTypes: types.rows,
      areas: areas.rows,
      brands: brands.rows,
      servicePresets: presets.rows.map((r) => r.label),
    };
    return this.value;
  }

  invalidate(): void {
    this.value = null;
  }
}

/**
 * Known phone → name and area (the form auto-fills for repeat customers), plus the last visits
 * and any live service warranties (owner, 30 Sep 2026: "Warranty service" on the form).
 * Visits and warranties carry no amounts; see services/warranty.ts.
 */
export async function findCustomerByPhone(pool: pg.Pool, actor: Actor, phoneE164: string): Promise<CustomerLookup> {
  const res = await withActorContext(pool, actor, (client) =>
    client.query<{ name: string; area_id: string | null }>(
      'SELECT name, area_id FROM customers WHERE phone_e164 = $1',
      [phoneE164],
    ),
  );
  const row = res.rows[0];
  if (!row) return { found: false };
  const [visits, warranties] = await Promise.all([recentVisits(pool, phoneE164), liveWarranties(pool, phoneE164)]);
  return { found: true, name: row.name, areaId: row.area_id, visits, warranties };
}
