import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type pg from 'pg';
import { roleUsesPin, type RoleKey } from '../../src/shared/constants.ts';
import { isWeakPin } from '../../src/shared/credentials.ts';
import { SubmissionInputSchema, type SubmissionInputRaw } from '../../src/shared/schemas.ts';
import { generatePassword, generatePin } from '../../src/server/auth/hashing.ts';
import { createApp } from '../../src/server/app.ts';
import { SlidingWindowLimiter } from '../../src/server/auth/rate-limit.ts';
import { SessionStore } from '../../src/server/auth/sessions.ts';
import { createPool } from '../../src/server/db/client.ts';
import type { AppDeps } from '../../src/server/http/context.ts';
import { LookupsCache } from '../../src/server/services/lookups.ts';
import { PushService } from '../../src/server/services/push.ts';
import { QueueState } from '../../src/server/services/queue-state.ts';
import { SettingsCache } from '../../src/server/services/settings.ts';
import { runMigrations } from '../../src/server/db/migrate.ts';
import { runSeed } from '../../src/server/db/seed.ts';
import type { Actor } from '../../src/server/services/types.ts';

if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * The integration suite WIPES its database. It only ever uses TEST_DATABASE_URL and refuses
 * to run if that points at the same host as DATABASE_URL.
 */
export function testDatabaseUrl(): string | null {
  const test = process.env.TEST_DATABASE_URL;
  if (!test) return null;
  const dev = process.env.DATABASE_URL;
  if (dev && new URL(dev).hostname === new URL(test).hostname) {
    throw new Error('TEST_DATABASE_URL must not point at the same database as DATABASE_URL');
  }
  return test;
}

export const hasTestDatabase = testDatabaseUrl() !== null;

export function createTestPool(): pg.Pool {
  const url = testDatabaseUrl();
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return createPool(url, 10);
}

export const TEST_PEPPER = new Uint8Array(32).fill(7);

export interface SeededAccount {
  id: string;
  role: RoleKey;
  displayName: string;
  username: string;
  password: string;
  /** undefined for technicians, who have no PIN. */
  pin: string | undefined;
}

/** Drops everything, re-applies migrations and seeds. Returns the seeded accounts with credentials. */
export async function resetDatabaseWithAccounts(pool: pg.Pool): Promise<SeededAccount[]> {
  await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool);
  const masterPassword = generatePassword();
  const masterPin = generatePin();
  const seeded = await runSeed(pool, {
    pinPepper: TEST_PEPPER,
    masterInitialPassword: masterPassword,
    masterInitialPin: masterPin,
  });
  const ids = await pool.query<{ id: string; username: string }>('SELECT id, username FROM users');
  const idByUsername = new Map(ids.rows.map((r) => [r.username, r.id]));
  return seeded.accountsCreated.map((a) => ({
    id: idByUsername.get(a.username)!,
    role: a.role,
    displayName: a.displayName,
    username: a.username,
    password: a.password ?? masterPassword,
    pin: a.role === 'master' ? masterPin : a.pin,
  }));
}

/** Drops everything, re-applies migrations and seeds. Returns the seeded actors by role. */
export async function resetDatabase(pool: pg.Pool): Promise<Record<RoleKey, Actor[]>> {
  await resetDatabaseWithAccounts(pool);
  return loadActors(pool);
}

/** The real app wired to the test database, as index.ts wires it in production. */
export function buildTestApp(pool: pg.Pool, options: { limiter?: SlidingWindowLimiter } = {}) {
  const settings = new SettingsCache(pool);
  const deps: AppDeps = {
    pool,
    settings,
    sessions: new SessionStore(pool, settings),
    lookups: new LookupsCache(pool),
    queue: new QueueState(pool),
    push: new PushService(pool, null),
    pepper: TEST_PEPPER,
    secureCookies: false,
    trustProxy: true,
    authLimiter: options.limiter ?? new SlidingWindowLimiter(10_000, 60_000),
  };
  return { app: createApp({ deps }), deps };
}

/**
 * Minimal browser stand-in: keeps cookies between requests and, like the real client,
 * echoes the CSRF cookie in X-CSRF-Token on state-changing requests.
 */
export class TestClient {
  readonly cookies = new Map<string, string>();
  private readonly app: ReturnType<typeof createApp>;
  private readonly ip: string;

  constructor(app: ReturnType<typeof createApp>, ip = '203.0.113.10') {
    this.app = app;
    this.ip = ip;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any; headers: Headers }> {
    const h: Record<string, string> = { 'x-forwarded-for': this.ip, ...headers };
    if (this.cookies.size > 0) {
      h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (method !== 'GET' && this.cookies.has('ahc_csrf') && !('x-csrf-token' in headers)) {
      h['x-csrf-token'] = this.cookies.get('ahc_csrf')!;
    }
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await this.app.request(path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/max-age=0/i.test(cookie) || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }

  get(path: string, headers?: Record<string, string>) {
    return this.request('GET', path, undefined, headers);
  }

  post(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.request('POST', path, body, headers);
  }

  login(account: { username: string; password: string; pin?: string | undefined }, deviceKind: 'mobile' | 'desktop' = 'mobile') {
    return this.post('/api/auth/login', {
      username: account.username,
      password: account.password,
      pin: account.pin,
      deviceKind,
    });
  }
}

/** A random PIN that passes the weak-PIN rules. */
export function strongPin(): string {
  for (;;) {
    const pin = generatePin();
    if (!isWeakPin(pin)) return pin;
  }
}

/** Logs in over HTTP and completes the forced first-login change. Mutates `account`. */
export async function activateAccount(
  app: ReturnType<typeof createApp>,
  account: SeededAccount,
  kind: 'mobile' | 'desktop' = 'mobile',
): Promise<TestClient> {
  const client = new TestClient(app);
  const login = await client.login(account, kind);
  if (login.status !== 200) throw new Error(`login failed for ${account.displayName}: ${login.status}`);
  const newPassword = generatePassword();
  const newPin = roleUsesPin(account.role) ? strongPin() : undefined;
  const res = await client.post('/api/auth/change-credentials', {
    currentPassword: account.password,
    newPassword,
    newPin,
  });
  if (res.status !== 200) throw new Error(`credential change failed for ${account.displayName}`);
  account.password = newPassword;
  account.pin = newPin;
  return client;
}

export async function loadActors(pool: pg.Pool): Promise<Record<RoleKey, Actor[]>> {
  const res = await pool.query<{ id: string; role_key: RoleKey }>(
    'SELECT id, role_key FROM users ORDER BY display_name',
  );
  const actors: Record<RoleKey, Actor[]> = { master: [], admin_technician: [], technician: [] };
  for (const row of res.rows) actors[row.role_key].push({ id: row.id, roleKey: row.role_key });
  return actors;
}

let phoneSeq = 0;

/** A valid, parsed submission with a fresh idempotency key and a unique customer phone. */
export function makeSubmission(overrides: Partial<SubmissionInputRaw> = {}) {
  phoneSeq += 1;
  const raw: SubmissionInputRaw = {
    idempotencyKey: randomUUID(),
    phone: `98${String(10_000_000 + phoneSeq).slice(-8)}`,
    customerName: `Test Customer ${phoneSeq}`,
    areaId: null,
    applianceTypeKey: 'ac_split',
    brandId: null,
    serviceDescription: 'General service',
    totalRupees: 2300,
    spareCostRupees: 800,
    payment: { status: 'paid', mode: 'upi' },
    ...overrides,
  };
  return SubmissionInputSchema.parse(raw);
}

export async function counterState(pool: pg.Pool): Promise<{ start: number; next: number }> {
  const res = await pool.query<{ start_value: number; next_value: number }>(
    'SELECT start_value, next_value FROM invoice_counter WHERE id = 1',
  );
  const row = res.rows[0]!;
  return { start: row.start_value, next: row.next_value };
}
