import { randomInt } from 'node:crypto';
import type pg from 'pg';
import {
  COUNTER_START_MAX,
  COUNTER_START_MIN,
  PIN_MIN_LENGTH,
  roleUsesPin,
  type RoleKey,
} from '../../shared/constants.ts';
import {
  generatePassword,
  generatePin,
  generateUsername,
  hashPassword,
  hashPin,
  isValidPassword,
  isValidPin,
} from '../auth/hashing.ts';
import { CHENNAI_AREAS } from './chennai-areas.ts';
import { withTransaction } from './client.ts';

// Idempotent seed. Safe to run any number of times:
//  - reference data is inserted with ON CONFLICT DO NOTHING (never overwrites admin edits);
//  - the invoice counter start is drawn ONCE, only if the counter row is absent;
//  - accounts are created only when the users table is empty.
// It never logs the counter start, and it prints generated credentials exactly once.

/** Uniform CSPRNG draw from [COUNTER_START_MIN, COUNTER_START_MAX], inclusive. */
export function pickCounterStart(draw: (min: number, max: number) => number = randomInt): number {
  // crypto.randomInt's upper bound is exclusive.
  const value = draw(COUNTER_START_MIN, COUNTER_START_MAX + 1);
  if (!Number.isInteger(value) || value < COUNTER_START_MIN || value > COUNTER_START_MAX) {
    throw new RangeError('counter start outside the allowed range');
  }
  return value;
}

const ROLES: Array<[RoleKey, string]> = [
  ['master', 'Master'],
  ['admin_technician', 'Admin Technician'],
  ['technician', 'Technician'],
];

// [ASSUMPTION] Reminder interval: AC only, 6 months (spec default). Editable later in settings.
const APPLIANCE_TYPES: Array<[string, string, number | null, number]> = [
  ['ac_split', 'AC (split)', 6, 1],
  ['ac_window', 'AC (window)', 6, 2],
  ['refrigerator', 'Refrigerator', null, 3],
  ['wm_top_load', 'Washing machine (top-load)', null, 4],
  ['wm_front_load', 'Washing machine (front-load)', null, 5],
  ['other', 'Other', null, 6],
];

const SETTINGS: Record<string, unknown> = {
  official_phone: '+919841459657',
  pin_idle_timeout_minutes: 10,
  queue_alert_hours: 4, // [ASSUMPTION] highlight pending items older than 4 hours
  session_absolute_days: 30,
};

// [ASSUMPTION] Starter vocabularies so the typeaheads work on day one. All admin-editable.
const SERVICE_PRESETS = [
  'General service',
  'Gas refilling',
  'Water leakage',
  'Not cooling',
  'PCB repair',
  'Compressor replacement',
  'Fan motor replacement',
  'Drum / motor repair',
  'Drain pump replacement',
  'Installation',
  'Uninstallation',
];

const AREAS = CHENNAI_AREAS;

const BRANDS = [
  'LG',
  'Samsung',
  'Voltas',
  'Daikin',
  'Blue Star',
  'Hitachi',
  'Panasonic',
  'Carrier',
  'Lloyd',
  'Godrej',
  'Whirlpool',
  'IFB',
  'Haier',
  'Bosch',
  'O General',
  'Onida',
  'Videocon',
  'Kelvinator',
];

export interface SeedOptions {
  pinPepper: Uint8Array;
  /** Required only when accounts are created (first run). */
  masterInitialPassword?: string;
  masterInitialPin?: string;
}

export interface CreatedAccount {
  role: RoleKey;
  displayName: string;
  username: string;
  /** Absent for the Master, whose password and PIN come from env vars. */
  password?: string;
  /** Absent for the Master (env var) and for technicians, who have no PIN. */
  pin?: string;
}

export interface SeedResult {
  counterCreated: boolean;
  accountsCreated: CreatedAccount[];
}

const ACCOUNT_PLAN: Array<{ role: RoleKey; displayName: string; prefix: string }> = [
  { role: 'master', displayName: 'Master', prefix: 'master' },
  { role: 'admin_technician', displayName: 'Admin Technician', prefix: 'admin' },
  { role: 'technician', displayName: 'Technician 1', prefix: 'tech' },
  { role: 'technician', displayName: 'Technician 2', prefix: 'tech' },
  { role: 'technician', displayName: 'Technician 3', prefix: 'tech' },
];

async function insertReferenceData(client: pg.PoolClient): Promise<void> {
  for (const [key, name] of ROLES) {
    await client.query('INSERT INTO roles (key, name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [key, name]);
  }
  for (const [key, label, interval, sort] of APPLIANCE_TYPES) {
    await client.query(
      `INSERT INTO appliance_types (key, label, reminder_interval_months, sort_order)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [key, label, interval, sort],
    );
  }
  for (const [key, value] of Object.entries(SETTINGS)) {
    await client.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      key,
      JSON.stringify(value),
    ]);
  }
  await client.query(
    `INSERT INTO service_presets (label, sort_order)
     SELECT label, ord FROM unnest($1::text[]) WITH ORDINALITY AS t(label, ord)
     ON CONFLICT DO NOTHING`,
    [SERVICE_PRESETS],
  );
  await client.query(
    'INSERT INTO areas (name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING',
    [AREAS],
  );
  await client.query(
    'INSERT INTO brands (name) SELECT unnest($1::text[]) ON CONFLICT DO NOTHING',
    [BRANDS],
  );
}

async function ensureCounter(client: pg.PoolClient): Promise<boolean> {
  const start = pickCounterStart();
  const res = await client.query(
    `INSERT INTO invoice_counter (id, start_value, next_value) VALUES (1, $1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [start],
  );
  return res.rowCount === 1;
}

async function createAccounts(client: pg.PoolClient, options: SeedOptions): Promise<CreatedAccount[]> {
  const existing = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM users');
  if ((existing.rows[0]?.n ?? 0) > 0) return [];

  const { masterInitialPassword, masterInitialPin, pinPepper } = options;
  if (!masterInitialPassword || !isValidPassword(masterInitialPassword)) {
    throw new Error('MASTER_INITIAL_PASSWORD must be set and at least 12 characters long');
  }
  if (!masterInitialPin || !isValidPin(masterInitialPin)) {
    throw new Error(`MASTER_INITIAL_PIN must be set and be ${PIN_MIN_LENGTH} or more digits`);
  }

  const created: CreatedAccount[] = [];
  for (const plan of ACCOUNT_PLAN) {
    const isMaster = plan.role === 'master';
    const username = generateUsername(plan.prefix);
    const password = isMaster ? masterInitialPassword : generatePassword();
    const pin = isMaster ? masterInitialPin : roleUsesPin(plan.role) ? generatePin() : undefined;

    // Seeded technicians start as "Invoice only"; the Master can switch them in the Team panel.
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (username, display_name, role_key, technician_mode, must_change)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [username, plan.displayName, plan.role, plan.role === 'technician' ? 'invoice_only' : null],
    );
    const userId = user.rows[0]!.id;
    await client.query(
      "INSERT INTO auth_credentials (user_id, factor_type, secret_hash) VALUES ($1, 'password', $2)",
      [userId, await hashPassword(password)],
    );
    if (pin !== undefined) {
      await client.query(
        "INSERT INTO auth_credentials (user_id, factor_type, secret_hash) VALUES ($1, 'pin', $2)",
        [userId, await hashPin(pin, pinPepper)],
      );
    }
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, new_values)
       VALUES (NULL, 'user.seeded', 'user', $1, $2)`,
      [userId, JSON.stringify({ username, role: plan.role, display_name: plan.displayName })],
    );

    created.push(
      isMaster
        ? { role: plan.role, displayName: plan.displayName, username }
        : { role: plan.role, displayName: plan.displayName, username, password, pin },
    );
  }
  return created;
}

export async function runSeed(pool: pg.Pool, options: SeedOptions): Promise<SeedResult> {
  return withTransaction(pool, async (client) => {
    // Serialise concurrent seed runs.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ahc_seed'))");
    await insertReferenceData(client);
    const counterCreated = await ensureCounter(client);
    const accountsCreated = await createAccounts(client, options);
    return { counterCreated, accountsCreated };
  });
}
