import type pg from 'pg';
import type { TeamMember } from '../../shared/api-types.ts';
import { roleUsesPin, type RoleKey, type TechnicianMode } from '../../shared/constants.ts';
import { checkNewPassword, checkNewPin, type PasswordProblem, type PinProblem } from '../../shared/credentials.ts';
import type { CreateUserInput, SetCredentialsInput, UpdateUserInput } from '../../shared/schemas.ts';
import { generatePassword, generatePin, hashPassword, hashPin } from '../auth/hashing.ts';
import { replaceCredentials } from '../auth/service.ts';
import type { SessionStore } from '../auth/sessions.ts';
import { isUniqueViolation, withTransaction } from '../db/client.ts';
import type { Actor } from './types.ts';

// Master-only team management ("the Master is the master of the whole"). Routes enforce
// `users.manage` plus a fresh PIN (step-up) for every change. Every change is written to
// audit_log with old and new values, never secrets. Users are never deleted: "Remove" disables
// the account (their past invoices must keep pointing to them) and can be undone.

export async function listUsers(pool: pg.Pool): Promise<TeamMember[]> {
  const res = await pool.query<Omit<TeamMember, 'createdAt' | 'lastLoginAt'> & { createdAt: Date; lastLoginAt: Date | null }>(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.role_key AS "roleKey",
            u.technician_mode AS "technicianMode", u.status, u.must_change AS "mustChange",
            u.created_at AS "createdAt",
            (SELECT count(*)::int FROM sessions s
              WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.absolute_expires_at > now()) AS "activeSessions",
            (SELECT max(created_at) FROM login_attempts a
              WHERE a.user_id = u.id AND a.success AND a.stage IN ('password', 'pin')) AS "lastLoginAt",
            (SELECT count(*)::int FROM jobs j
              WHERE j.assigned_to = u.id AND j.status IN ('assigned', 'in_progress')) AS "openJobs"
     FROM users u
     ORDER BY u.status, CASE u.role_key WHEN 'master' THEN 0 WHEN 'admin_technician' THEN 1 ELSE 2 END, u.display_name`,
  );
  return res.rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    lastLoginAt: r.lastLoginAt?.toISOString() ?? null,
  }));
}

export interface LoginHistoryRow {
  id: number;
  usernameAttempted: string;
  userId: string | null;
  displayName: string | null;
  ip: string | null;
  stage: string;
  success: boolean;
  failureReason: string | null;
  createdAt: Date;
}

export async function loginHistory(
  pool: pg.Pool,
  filter: { userId?: string; limit: number },
): Promise<LoginHistoryRow[]> {
  const res = await pool.query<LoginHistoryRow>(
    `SELECT a.id, a.username_attempted AS "usernameAttempted", a.user_id AS "userId",
            u.display_name AS "displayName", a.ip, a.stage, a.success,
            a.failure_reason AS "failureReason", a.created_at AS "createdAt"
     FROM login_attempts a LEFT JOIN users u ON u.id = a.user_id
     WHERE ($1::uuid IS NULL OR a.user_id = $1::uuid)
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [filter.userId ?? null, filter.limit],
  );
  return res.rows;
}

export async function listActiveSessions(pool: pg.Pool, userId: string) {
  const res = await pool.query(
    `SELECT id, kind, device_label AS "deviceLabel", ip, user_agent AS "userAgent",
            created_at AS "createdAt", last_seen_at AS "lastSeenAt", absolute_expires_at AS "absoluteExpiresAt"
     FROM sessions
     WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()
     ORDER BY last_seen_at DESC`,
    [userId],
  );
  return res.rows;
}

export type AdminError =
  | 'not_found'
  | 'self_not_allowed'
  | 'last_master'
  | 'username_taken'
  | 'invalid'
  | 'not_a_technician'
  | 'pin_not_applicable'
  | 'has_open_work'
  | PasswordProblem
  | PinProblem;

export type AdminResult<T = unknown> = ({ ok: true } & T) | { ok: false; error: AdminError };

interface TargetRow {
  id: string;
  username: string;
  display_name: string;
  role_key: RoleKey;
  technician_mode: TechnicianMode | null;
  status: 'active' | 'disabled';
}

async function lockTarget(client: pg.PoolClient, userId: string): Promise<TargetRow | null> {
  const res = await client.query<TargetRow>(
    'SELECT id, username, display_name, role_key, technician_mode, status FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  return res.rows[0] ?? null;
}

async function openJobCount(client: pg.PoolClient, userId: string): Promise<number> {
  const res = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM jobs WHERE assigned_to = $1 AND status IN ('assigned', 'in_progress')",
    [userId],
  );
  return res.rows[0]!.n;
}

async function audit(
  client: pg.PoolClient,
  actor: Actor,
  action: string,
  userId: string,
  oldValues: unknown,
  newValues: unknown,
  reason: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity_type, entity_id, old_values, new_values, reason, ip)
     VALUES ($1, $2, 'user', $3, $4, $5, $6, $7)`,
    [
      actor.id,
      action,
      userId,
      oldValues === null ? null : JSON.stringify(oldValues),
      newValues === null ? null : JSON.stringify(newValues),
      reason,
      actor.ip ?? null,
    ],
  );
}

/** Master adds an Admin Technician or a Technician (with its label). */
export async function createUser(
  pool: pg.Pool,
  pepper: Uint8Array,
  actor: Actor,
  input: CreateUserInput,
): Promise<AdminResult<{ userId: string }>> {
  const passwordProblem = checkNewPassword(input.password, input.username);
  if (passwordProblem) return { ok: false, error: passwordProblem };
  const usesPin = roleUsesPin(input.role);
  if (usesPin) {
    const pinProblem = checkNewPin(input.pin ?? '');
    if (pinProblem) return { ok: false, error: pinProblem };
  }
  const passwordHash = await hashPassword(input.password);
  const pinHash = usesPin ? await hashPin(input.pin!, pepper) : null;
  try {
    return await withTransaction(pool, async (client) => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO users (username, display_name, role_key, technician_mode, must_change)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.username, input.displayName, input.role, input.role === 'technician' ? input.technicianMode : null, input.mustChange],
      );
      const userId = res.rows[0]!.id;
      await client.query(
        "INSERT INTO auth_credentials (user_id, factor_type, secret_hash) VALUES ($1, 'password', $2)",
        [userId, passwordHash],
      );
      if (pinHash) {
        await client.query("INSERT INTO auth_credentials (user_id, factor_type, secret_hash) VALUES ($1, 'pin', $2)", [
          userId,
          pinHash,
        ]);
      }
      await audit(client, actor, 'user.created', userId, null, {
        username: input.username,
        display_name: input.displayName,
        role: input.role,
        technician_mode: input.role === 'technician' ? input.technicianMode : null,
        must_change: input.mustChange,
      });
      return { ok: true, userId };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_username_lower_uq')) return { ok: false, error: 'username_taken' };
    throw err;
  }
}

/** Rename, change username, or switch a technician between Invoice only and Invoice + Work. */
export async function updateUser(
  pool: pg.Pool,
  sessions: SessionStore,
  actor: Actor,
  userId: string,
  changes: UpdateUserInput,
): Promise<AdminResult> {
  try {
    return await withTransaction(pool, async (client) => {
      const target = await lockTarget(client, userId);
      if (!target) return { ok: false, error: 'not_found' };
      if (changes.technicianMode !== undefined && target.role_key !== 'technician') {
        return { ok: false, error: 'not_a_technician' };
      }
      if (
        changes.technicianMode === 'invoice_only' &&
        target.technician_mode === 'invoice_and_work' &&
        (await openJobCount(client, userId)) > 0
      ) {
        return { ok: false, error: 'has_open_work' };
      }
      const next = {
        display_name: changes.displayName ?? target.display_name,
        username: changes.username ?? target.username,
        technician_mode: changes.technicianMode ?? target.technician_mode,
      };
      await client.query(
        'UPDATE users SET display_name = $2, username = $3, technician_mode = $4, updated_at = now() WHERE id = $1',
        [userId, next.display_name, next.username, next.technician_mode],
      );
      await audit(
        client,
        actor,
        'user.updated',
        userId,
        { display_name: target.display_name, username: target.username, technician_mode: target.technician_mode },
        next,
      );
      sessions.forgetUser(userId);
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_username_lower_uq')) return { ok: false, error: 'username_taken' };
    throw err;
  }
}

/**
 * Master sets a specific password and/or PIN for someone (PIN only for office roles).
 * Their other sessions are signed out. By default they must choose their own at next sign-in.
 */
export async function setUserCredentials(
  pool: pg.Pool,
  sessions: SessionStore,
  pepper: Uint8Array,
  actor: Actor,
  userId: string,
  input: SetCredentialsInput,
): Promise<AdminResult> {
  if (userId === actor.id) return { ok: false, error: 'self_not_allowed' };
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, userId);
    if (!target) return { ok: false, error: 'not_found' };
    if (input.pin !== undefined && !roleUsesPin(target.role_key)) return { ok: false, error: 'pin_not_applicable' };
    if (input.password !== undefined) {
      const problem = checkNewPassword(input.password, target.username);
      if (problem) return { ok: false, error: problem };
    }
    if (input.pin !== undefined) {
      const problem = checkNewPin(input.pin);
      if (problem) return { ok: false, error: problem };
    }
    const factors: Array<['password' | 'pin', string]> = [];
    if (input.password !== undefined) factors.push(['password', await hashPassword(input.password)]);
    if (input.pin !== undefined) factors.push(['pin', await hashPin(input.pin, pepper)]);
    for (const [factor, secretHash] of factors) {
      await client.query(
        'UPDATE auth_credentials SET revoked_at = now() WHERE user_id = $1 AND factor_type = $2 AND revoked_at IS NULL',
        [userId, factor],
      );
      await client.query('INSERT INTO auth_credentials (user_id, factor_type, secret_hash) VALUES ($1, $2, $3)', [
        userId,
        factor,
        secretHash,
      ]);
    }
    await client.query('UPDATE users SET must_change = $2, updated_at = now() WHERE id = $1', [userId, input.mustChange]);
    await sessions.revokeAllForUser(client, userId, 'credentials_set_by_master');
    await audit(client, actor, 'user.credentials_set', userId, null, {
      password_changed: input.password !== undefined,
      pin_changed: input.pin !== undefined,
      must_change: input.mustChange,
    });
    return { ok: true };
  });
}

/** Issues a one-time password and PIN (shown once to the Master), forces a change at next login. */
export async function resetUserCredentials(
  pool: pg.Pool,
  sessions: SessionStore,
  pepper: Uint8Array,
  actor: Actor,
  userId: string,
): Promise<AdminResult<{ username: string; temporaryPassword: string; temporaryPin: string | null }>> {
  if (userId === actor.id) return { ok: false, error: 'self_not_allowed' };
  const temporaryPassword = generatePassword();
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, userId);
    if (!target) return { ok: false, error: 'not_found' };
    // Technicians have no PIN: only a temporary password is issued.
    const temporaryPin = roleUsesPin(target.role_key) ? generatePin() : null;
    await replaceCredentials(client, userId, temporaryPassword, temporaryPin, pepper, true);
    await sessions.revokeAllForUser(client, userId, 'credentials_reset_by_master');
    await audit(client, actor, 'user.credentials_reset', userId, null, { must_change: true });
    return { ok: true, username: target.username, temporaryPassword, temporaryPin };
  });
}

/** "Remove" (disable) or "Restore" (enable) a user. Removed users can't sign in; history is kept. */
export async function setUserStatus(
  pool: pg.Pool,
  sessions: SessionStore,
  actor: Actor,
  userId: string,
  status: 'active' | 'disabled',
  reason: string,
): Promise<AdminResult> {
  if (userId === actor.id) return { ok: false, error: 'self_not_allowed' };
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, userId);
    if (!target) return { ok: false, error: 'not_found' };
    if (status === 'disabled' && target.role_key === 'master') {
      const masters = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM users WHERE role_key = 'master' AND status = 'active' AND id <> $1",
        [userId],
      );
      if (masters.rows[0]!.n === 0) return { ok: false, error: 'last_master' };
    }
    if (status === 'disabled' && (await openJobCount(client, userId)) > 0) return { ok: false, error: 'has_open_work' };
    await client.query(
      `UPDATE users SET status = $2, disabled_at = CASE WHEN $3 THEN now() ELSE NULL END,
              updated_at = now()
       WHERE id = $1`,
      [userId, status, status === 'disabled'],
    );
    if (status === 'disabled') await sessions.revokeAllForUser(client, userId, 'user_disabled');
    await audit(client, actor, `user.${status === 'disabled' ? 'disabled' : 'enabled'}`, userId,
      { status: target.status }, { status }, reason);
    return { ok: true };
  });
}

export async function revokeUserSessions(
  pool: pg.Pool,
  sessions: SessionStore,
  actor: Actor,
  userId: string,
  exceptSessionId?: string,
): Promise<AdminResult<{ revoked: number }>> {
  return withTransaction(pool, async (client) => {
    const target = await lockTarget(client, userId);
    if (!target) return { ok: false, error: 'not_found' };
    const revoked = await sessions.revokeAllForUser(client, userId, 'revoked_by_master', exceptSessionId);
    await audit(client, actor, 'user.sessions_revoked', userId, null, { revoked });
    return { ok: true, revoked };
  });
}
