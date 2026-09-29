import { randomInt } from 'node:crypto';
import type pg from 'pg';
import {
  checkNewPassword,
  checkNewPin,
  type PasswordProblem,
  type PinProblem,
} from '../../shared/credentials.ts';
import { roleUsesPin, type RoleKey } from '../../shared/constants.ts';
import { withTransaction } from '../db/client.ts';
import { hash, verify } from '@node-rs/argon2';
import { hashPassword, hashPin, verifyPassword, verifyPin } from './hashing.ts';
import type { SessionEntry, SessionKind, SessionStore, SessionUser } from './sessions.ts';

export interface AuthDeps {
  pool: pg.Pool;
  sessions: SessionStore;
  pepper: Uint8Array;
}

// ------------------------------------------------------------------ progressive lockout

/** Consecutive failures allowed before any lock. */
export const LOCKOUT_FREE_FAILURES = 5;
export const LOCKOUT_MAX_MINUTES = 60;

/** 5 failures → 1 min, 6 → 2, 7 → 4 … capped at 60 minutes. */
export function lockoutMinutes(consecutiveFailures: number): number {
  if (consecutiveFailures < LOCKOUT_FREE_FAILURES) return 0;
  return Math.min(2 ** (consecutiveFailures - LOCKOUT_FREE_FAILURES), LOCKOUT_MAX_MINUTES);
}

/** Usernames are compared case-insensitively; unknown usernames are tracked the same way. */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase().slice(0, 64);
}

async function lockedForSeconds(pool: pg.Pool, key: string): Promise<number> {
  const res = await pool.query<{ failures: number; last_failure: Date | null }>(
    `WITH last_success AS (
       SELECT coalesce(max(created_at), '-infinity'::timestamptz) AS at
       FROM login_attempts
       WHERE username_attempted = $1 AND success AND stage IN ('password', 'pin', 'recovery')
     )
     SELECT count(*)::int AS failures, max(created_at) AS last_failure
     FROM login_attempts, last_success
     WHERE username_attempted = $1
       AND NOT success
       AND coalesce(failure_reason, '') <> 'locked'
       AND stage IN ('password', 'pin', 'recovery')
       AND created_at > last_success.at
       AND created_at > now() - interval '24 hours'`,
    [key],
  );
  const { failures, last_failure } = res.rows[0]!;
  const minutes = lockoutMinutes(failures);
  if (minutes === 0 || !last_failure) return 0;
  const until = last_failure.getTime() + minutes * 60_000;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

async function recordAttempt(
  pool: pg.Pool | pg.PoolClient,
  a: {
    key: string;
    userId: string | null;
    ip: string | null;
    stage: 'password' | 'pin' | 'unlock' | 'step_up' | 'recovery';
    success: boolean;
    reason?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO login_attempts (username_attempted, user_id, ip, stage, success, failure_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [a.key, a.userId, a.ip, a.stage, a.success, a.reason ?? null],
  );
}

// ------------------------------------------------------------------ timing equalisation

let dummyPasswordHash: Promise<string> | null = null;
let dummyPinHash: Promise<string> | null = null;

/** Burns the same Argon2 work as a real check so response time does not reveal which step failed. */
async function burnPassword(password: string): Promise<void> {
  dummyPasswordHash ??= hashPassword('dummy-password-for-timing-equalisation');
  await verifyPassword(await dummyPasswordHash, password);
}

async function burnPin(pin: string, pepper: Uint8Array): Promise<void> {
  dummyPinHash ??= hashPin('000000', pepper);
  await verifyPin(await dummyPinHash, pin, pepper);
}

// ------------------------------------------------------------------ login

interface CredentialRow {
  id: string;
  username: string;
  display_name: string;
  role_key: RoleKey;
  must_change: boolean;
  status: 'active' | 'disabled';
  password_hash: string | null;
  pin_hash: string | null;
}

async function loadUserWithCredentials(
  db: pg.Pool | pg.PoolClient,
  where: { key: string } | { userId: string },
): Promise<CredentialRow | null> {
  const byKey = 'key' in where;
  const res = await db.query<CredentialRow>(
    `SELECT u.id, u.username, u.display_name, u.role_key, u.must_change, u.status,
            (SELECT secret_hash FROM auth_credentials
              WHERE user_id = u.id AND factor_type = 'password' AND revoked_at IS NULL) AS password_hash,
            (SELECT secret_hash FROM auth_credentials
              WHERE user_id = u.id AND factor_type = 'pin' AND revoked_at IS NULL) AS pin_hash
     FROM users u
     WHERE ${byKey ? 'lower(u.username) = $1' : 'u.id = $1'}`,
    [byKey ? where.key : where.userId],
  );
  return res.rows[0] ?? null;
}

function toSessionUser(row: CredentialRow): SessionUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    roleKey: row.role_key,
    mustChange: row.must_change,
  };
}

export type LoginResult =
  | { ok: true; token: string; entry: SessionEntry }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSec: number };

export async function login(
  deps: AuthDeps,
  input: {
    username: string;
    password: string;
    pin: string;
    kind: SessionKind;
    ip: string | null;
    userAgent: string | null;
    deviceLabel: string | null;
  },
): Promise<LoginResult> {
  const key = usernameKey(input.username);
  const lockedSec = await lockedForSeconds(deps.pool, key);
  if (lockedSec > 0) {
    await recordAttempt(deps.pool, { key, userId: null, ip: input.ip, stage: 'password', success: false, reason: 'locked' });
    return { ok: false, reason: 'locked', retryAfterSec: lockedSec };
  }

  const user = await loadUserWithCredentials(deps.pool, { key });
  const needsPin = !!user && roleUsesPin(user.role_key);
  const usable =
    user && user.status === 'active' && user.password_hash && (!needsPin || user.pin_hash);

  // Step 1: password. Unknown or disabled users burn the same work.
  const passwordOk = usable ? await verifyPassword(user.password_hash!, input.password) : false;
  if (!usable) await burnPassword(input.password);
  if (!passwordOk || !user) {
    await burnPin(input.pin, deps.pepper);
    await recordAttempt(deps.pool, {
      key,
      userId: user?.id ?? null,
      ip: input.ip,
      stage: 'password',
      success: false,
      reason: !user ? 'unknown_user' : user.status !== 'active' ? 'disabled' : 'bad_password',
    });
    return { ok: false, reason: 'invalid' };
  }

  // Step 2: PIN, only after the password succeeded, and only for roles that have one.
  // Technicians have no PIN; the same Argon2 work is burned so timing reveals nothing.
  if (needsPin) {
    const pinOk = await verifyPin(user.pin_hash!, input.pin, deps.pepper);
    if (!pinOk) {
      await recordAttempt(deps.pool, { key, userId: user.id, ip: input.ip, stage: 'pin', success: false, reason: 'bad_pin' });
      return { ok: false, reason: 'invalid' };
    }
  } else {
    await burnPin(input.pin, deps.pepper);
  }

  const created = await withTransaction(deps.pool, async (client) => {
    await recordAttempt(client, {
      key,
      userId: user.id,
      ip: input.ip,
      stage: needsPin ? 'pin' : 'password',
      success: true,
    });
    await client.query(
      `UPDATE auth_credentials SET last_used_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND factor_type IN ('password', 'pin')`,
      [user.id],
    );
    return deps.sessions.create(client, toSessionUser(user), input.kind, {
      ip: input.ip,
      userAgent: input.userAgent,
      deviceLabel: input.deviceLabel,
    });
  });
  return { ok: true, ...created };
}

// ------------------------------------------------------------------ session PIN (unlock / step-up)

export type PinCheckResult =
  | { ok: true }
  | { ok: false; notApplicable: true }
  | { ok: false; notApplicable?: false; revoked: boolean; remaining: number };

/** Verifies the PIN for an existing session: idle unlock and step-up both use this. */
export async function verifySessionPin(
  deps: AuthDeps,
  entry: SessionEntry,
  pin: string,
  meta: { ip: string | null; stage: 'unlock' | 'step_up' },
): Promise<PinCheckResult> {
  if (!roleUsesPin(entry.user.roleKey)) return { ok: false, notApplicable: true };
  const user = await loadUserWithCredentials(deps.pool, { userId: entry.user.id });
  const ok = !!user?.pin_hash && user.status === 'active' && (await verifyPin(user.pin_hash, pin, deps.pepper));
  await recordAttempt(deps.pool, {
    key: usernameKey(entry.user.username),
    userId: entry.user.id,
    ip: meta.ip,
    stage: meta.stage,
    success: ok,
    reason: ok ? undefined : 'bad_pin',
  });
  if (ok) {
    await deps.sessions.markPinVerified(entry);
    return { ok: true };
  }
  const failure = await deps.sessions.recordPinFailure(entry);
  return { ok: false, ...failure };
}

// ------------------------------------------------------------------ credential changes

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const RECOVERY_CODE_COUNT = 10;

/** 12 symbols from a 32-symbol alphabet (60 bits), shown as XXXX-XXXX-XXXX. */
export function generateRecoveryCode(): string {
  let raw = '';
  for (let i = 0; i < 12; i++) raw += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

export function normalizeRecoveryCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return raw.length === 12 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}` : raw;
}

/** Invalidates any unused codes and stores 10 new hashed ones. Returns the plaintext, to show once. */
export async function issueRecoveryCodes(client: pg.PoolClient, userId: string, actorId: string): Promise<string[]> {
  await client.query('UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  for (const code of codes) {
    await client.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, await hash(code)]);
  }
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, new_values)
     VALUES ($1, 'user.recovery_codes_issued', 'user', $2, $3)`,
    [actorId, userId, JSON.stringify({ count: RECOVERY_CODE_COUNT })],
  );
  return codes;
}

/** Replaces the password and PIN credentials inside an open transaction. */
async function replaceCredentials(
  client: pg.PoolClient,
  userId: string,
  password: string,
  /** null for roles without a PIN (technicians): any old PIN is revoked, none is stored. */
  pin: string | null,
  pepper: Uint8Array,
  mustChange: boolean,
): Promise<void> {
  await client.query(
    `UPDATE auth_credentials SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND factor_type IN ('password', 'pin')`,
    [userId],
  );
  await client.query(
    "INSERT INTO auth_credentials (user_id, factor_type, secret_hash) VALUES ($1, 'password', $2)",
    [userId, await hashPassword(password)],
  );
  if (pin !== null) {
    await client.query(
      "INSERT INTO auth_credentials (user_id, factor_type, secret_hash) VALUES ($1, 'pin', $2)",
      [userId, await hashPin(pin, pepper)],
    );
  }
  await client.query('UPDATE users SET must_change = $2, updated_at = now() WHERE id = $1', [userId, mustChange]);
}

export type ChangeCredentialsResult =
  | { ok: true; recoveryCodes: string[] | null }
  | {
      ok: false;
      error: 'current_password_wrong' | 'password_reused' | 'pin_reused' | PasswordProblem | PinProblem;
      sessionRevoked?: boolean;
    };

export async function changeCredentials(
  deps: AuthDeps,
  entry: SessionEntry,
  input: { currentPassword: string; newPassword: string; newPin?: string; ip: string | null },
): Promise<ChangeCredentialsResult> {
  const user = await loadUserWithCredentials(deps.pool, { userId: entry.user.id });
  if (!user?.password_hash) return { ok: false, error: 'current_password_wrong' };
  const usesPin = roleUsesPin(user.role_key);

  if (!(await verifyPassword(user.password_hash, input.currentPassword))) {
    // A thief holding an unlocked session must not get unlimited password guesses here.
    const failure = await deps.sessions.recordPinFailure(entry);
    return { ok: false, error: 'current_password_wrong', sessionRevoked: failure.revoked };
  }

  const passwordProblem = checkNewPassword(input.newPassword, user.username);
  if (passwordProblem) return { ok: false, error: passwordProblem };
  if (usesPin) {
    const pinProblem = checkNewPin(input.newPin ?? '');
    if (pinProblem) return { ok: false, error: pinProblem };
  }
  if (input.newPassword === input.currentPassword) return { ok: false, error: 'password_reused' };
  if (usesPin && user.pin_hash && (await verifyPin(user.pin_hash, input.newPin!, deps.pepper))) {
    return { ok: false, error: 'pin_reused' };
  }

  const recoveryCodes = await withTransaction(deps.pool, async (client) => {
    await replaceCredentials(client, user.id, input.newPassword, usesPin ? input.newPin! : null, deps.pepper, false);
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, new_values, ip)
       VALUES ($1, 'user.credentials_changed', 'user', $2, $3, $4)`,
      [user.id, user.id, JSON.stringify({ forced: user.must_change }), input.ip],
    );
    await deps.sessions.revokeAllForUser(client, user.id, 'credentials_changed', entry.id);

    if (user.role_key !== 'master') return null;
    const unused = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [user.id],
    );
    return unused.rows[0]!.n === 0 ? issueRecoveryCodes(client, user.id, user.id) : null;
  });

  entry.user.mustChange = false;
  await deps.sessions.markPinVerified(entry);
  return { ok: true, recoveryCodes };
}

// ------------------------------------------------------------------ Master recovery

export type RecoverResult =
  | { ok: true; remainingCodes: number }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterSec: number }
  | { ok: false; reason: PasswordProblem | PinProblem };

/**
 * Master-only, email-free recovery: a single-use recovery code resets the password and PIN.
 * Every session is revoked; the Master then logs in normally.
 */
export async function recoverWithCode(
  deps: AuthDeps,
  input: { username: string; code: string; newPassword: string; newPin: string; ip: string | null },
): Promise<RecoverResult> {
  const key = usernameKey(input.username);
  const lockedSec = await lockedForSeconds(deps.pool, key);
  if (lockedSec > 0) {
    await recordAttempt(deps.pool, { key, userId: null, ip: input.ip, stage: 'recovery', success: false, reason: 'locked' });
    return { ok: false, reason: 'locked', retryAfterSec: lockedSec };
  }

  const passwordProblem = checkNewPassword(input.newPassword, input.username);
  if (passwordProblem) return { ok: false, reason: passwordProblem };
  const pinProblem = checkNewPin(input.newPin);
  if (pinProblem) return { ok: false, reason: pinProblem };

  const user = await loadUserWithCredentials(deps.pool, { key });
  const code = normalizeRecoveryCode(input.code);
  let matchedId: string | null = null;
  if (user && user.role_key === 'master' && user.status === 'active') {
    const codes = await deps.pool.query<{ id: string; code_hash: string }>(
      'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [user.id],
    );
    for (const row of codes.rows) {
      if (await verify(row.code_hash, code)) {
        matchedId = row.id;
        break;
      }
    }
  } else {
    await burnPassword(code);
  }

  if (!user || !matchedId) {
    await recordAttempt(deps.pool, { key, userId: user?.id ?? null, ip: input.ip, stage: 'recovery', success: false, reason: 'bad_code' });
    return { ok: false, reason: 'invalid' };
  }

  const remaining = await withTransaction(deps.pool, async (client) => {
    const used = await client.query(
      'UPDATE recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL',
      [matchedId],
    );
    if (used.rowCount !== 1) throw new Error('recovery code already used');
    await replaceCredentials(client, user.id, input.newPassword, input.newPin, deps.pepper, false);
    await deps.sessions.revokeAllForUser(client, user.id, 'recovered');
    await recordAttempt(client, { key, userId: user.id, ip: input.ip, stage: 'recovery', success: true });
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, ip)
       VALUES ($1, 'user.recovered_with_code', 'user', $2, $3)`,
      [user.id, user.id, input.ip],
    );
    const left = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL',
      [user.id],
    );
    return left.rows[0]!.n;
  });
  return { ok: true, remainingCodes: remaining };
}

export { loadUserWithCredentials, replaceCredentials, recordAttempt };
