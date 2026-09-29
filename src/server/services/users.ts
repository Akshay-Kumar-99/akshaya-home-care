import type pg from 'pg';
import { roleUsesPin, type RoleKey } from '../../shared/constants.ts';
import { generatePassword, generatePin } from '../auth/hashing.ts';
import { replaceCredentials } from '../auth/service.ts';
import type { SessionStore } from '../auth/sessions.ts';
import { isUniqueViolation, withTransaction } from '../db/client.ts';
import type { Actor } from './types.ts';

// Master-only user administration. Routes enforce `users.manage` plus a fresh PIN (step-up).
// Every change is written to audit_log with old and new values (never secrets).

export interface UserSummary {
  id: string;
  username: string;
  displayName: string;
  roleKey: RoleKey;
  status: 'active' | 'disabled';
  mustChange: boolean;
  createdAt: Date;
  activeSessions: number;
  lastLoginAt: Date | null;
}

export async function listUsers(pool: pg.Pool): Promise<UserSummary[]> {
  const res = await pool.query<UserSummary>(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.role_key AS "roleKey", u.status,
            u.must_change AS "mustChange", u.created_at AS "createdAt",
            (SELECT count(*)::int FROM sessions s
              WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.absolute_expires_at > now()) AS "activeSessions",
            (SELECT max(created_at) FROM login_attempts a
              WHERE a.user_id = u.id AND a.success AND a.stage IN ('password', 'pin')) AS "lastLoginAt"
     FROM users u
     ORDER BY CASE u.role_key WHEN 'master' THEN 0 WHEN 'admin_technician' THEN 1 ELSE 2 END, u.display_name`,
  );
  return res.rows;
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

export type AdminResult<T = unknown> =
  | ({ ok: true } & T)
  | { ok: false; error: 'not_found' | 'self_not_allowed' | 'last_master' | 'username_taken' | 'invalid' };

interface TargetRow {
  id: string;
  username: string;
  display_name: string;
  role_key: RoleKey;
  status: 'active' | 'disabled';
}

async function lockTarget(client: pg.PoolClient, userId: string): Promise<TargetRow | null> {
  const res = await client.query<TargetRow>(
    'SELECT id, username, display_name, role_key, status FROM users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  return res.rows[0] ?? null;
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

export async function renameUser(
  pool: pg.Pool,
  sessions: SessionStore,
  actor: Actor,
  userId: string,
  changes: { displayName?: string; username?: string },
): Promise<AdminResult> {
  try {
    return await withTransaction(pool, async (client) => {
      const target = await lockTarget(client, userId);
      if (!target) return { ok: false, error: 'not_found' };
      const next = {
        display_name: changes.displayName ?? target.display_name,
        username: changes.username ?? target.username,
      };
      await client.query(
        'UPDATE users SET display_name = $2, username = $3, updated_at = now() WHERE id = $1',
        [userId, next.display_name, next.username],
      );
      await audit(client, actor, 'user.renamed', userId,
        { display_name: target.display_name, username: target.username }, next);
      sessions.forgetUser(userId);
      return { ok: true };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'users_username_lower_uq')) return { ok: false, error: 'username_taken' };
    throw err;
  }
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
