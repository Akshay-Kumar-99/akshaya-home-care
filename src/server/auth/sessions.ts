import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { roleUsesPin, type RoleKey, type TechnicianMode } from '../../shared/constants.ts';
import type { SettingsCache } from '../services/settings.ts';

export type SessionKind = 'mobile' | 'desktop';

/** Desktop sessions (the Master's PC) get a shorter absolute lifetime. [ASSUMPTION] */
export const DESKTOP_ABSOLUTE_HOURS = 12;
/** Wrong PINs on an existing session before it is revoked outright (forcing a full login). */
export const SESSION_PIN_MAX_FAILURES = 5;
/** Foreground requests re-read a cached session from the DB after this long. */
const FOREGROUND_RELOAD_MS = 5 * 60_000;
/** Activity timestamps are written to the DB at most this often per session. */
const ACTIVITY_PERSIST_MS = 60_000;

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  roleKey: RoleKey;
  mustChange: boolean;
  technicianMode: TechnicianMode | null;
}

export interface SessionEntry {
  id: string;
  tokenHash: string;
  kind: SessionKind;
  user: SessionUser;
  absoluteExpiresAt: number;
  lastPinAt: number;
  /** Last user-initiated request (background polls excluded). Drives the idle PIN lock. */
  lastActivityAt: number;
  pinFailCount: number;
  loadedAt: number;
  lastPersistedAt: number;
}

interface SessionRow {
  id: string;
  kind: SessionKind;
  absolute_expires_at: Date;
  last_pin_at: Date;
  last_seen_at: Date;
  pin_fail_count: number;
  revoked_at: Date | null;
  user_id: string;
  username: string;
  display_name: string;
  role_key: RoleKey;
  must_change: boolean;
  technician_mode: TechnicianMode | null;
  status: 'active' | 'disabled';
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** CSRF token bound to the session: derivable only by someone holding the (HttpOnly) session token. */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`csrf:${sessionToken}`).digest('base64url');
}

/**
 * Server-side sessions with an in-process cache.
 *
 * Background polls (the Work Inv badge, every 30 s) are answered from the cache with ZERO
 * database queries, so Neon can scale to zero while a phone sits on the panel. Everything
 * that changes a session goes through this class, which keeps the cache exact. Changes made
 * outside the process (the emergency-reset script) take effect on the user's next foreground
 * request, within FOREGROUND_RELOAD_MS.
 */
export class SessionStore {
  private readonly byHash = new Map<string, SessionEntry>();
  private readonly pool: pg.Pool;
  private readonly settings: SettingsCache;

  constructor(pool: pg.Pool, settings: SettingsCache) {
    this.pool = pool;
    this.settings = settings;
  }

  async idleTimeoutMs(): Promise<number> {
    const minutes = await this.settings.get<number>('pin_idle_timeout_minutes', 10);
    return Math.max(1, minutes) * 60_000;
  }

  async create(
    client: pg.PoolClient | pg.Pool,
    user: SessionUser,
    kind: SessionKind,
    meta: { ip: string | null; userAgent: string | null; deviceLabel: string | null },
  ): Promise<{ token: string; entry: SessionEntry }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const absoluteMs =
      kind === 'mobile'
        ? (await this.settings.get<number>('session_absolute_days', 30)) * 86_400_000
        : DESKTOP_ABSOLUTE_HOURS * 3_600_000;
    const now = Date.now();
    const res = await client.query<{ id: string }>(
      `INSERT INTO sessions (user_id, token_hash, kind, device_label, ip, user_agent,
                             last_seen_at, last_pin_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now() + make_interval(secs => $7))
       RETURNING id`,
      [user.id, tokenHash, kind, meta.deviceLabel, meta.ip, meta.userAgent?.slice(0, 300) ?? null, absoluteMs / 1000],
    );
    const entry: SessionEntry = {
      id: res.rows[0]!.id,
      tokenHash,
      kind,
      user,
      absoluteExpiresAt: now + absoluteMs,
      lastPinAt: now,
      lastActivityAt: now,
      pinFailCount: 0,
      loadedAt: now,
      lastPersistedAt: now,
    };
    this.byHash.set(tokenHash, entry);
    return { token, entry };
  }

  /** Returns the live session for a token, or null if unknown, revoked, expired or the user is disabled. */
  async resolve(token: string, { background }: { background: boolean }): Promise<SessionEntry | null> {
    const tokenHash = hashToken(token);
    const now = Date.now();
    let entry = this.byHash.get(tokenHash);

    if (!entry || (!background && now - entry.loadedAt > FOREGROUND_RELOAD_MS)) {
      const loaded = await this.load(tokenHash);
      if (!loaded) {
        this.byHash.delete(tokenHash);
        return null;
      }
      if (entry) loaded.lastActivityAt = Math.max(loaded.lastActivityAt, entry.lastActivityAt);
      entry = loaded;
      this.byHash.set(tokenHash, entry);
    }

    if (entry.absoluteExpiresAt <= now) {
      this.byHash.delete(tokenHash);
      return null;
    }
    return entry;
  }

  private async load(tokenHash: string): Promise<SessionEntry | null> {
    const res = await this.pool.query<SessionRow>(
      `SELECT s.id, s.kind, s.absolute_expires_at, s.last_pin_at, s.last_seen_at, s.pin_fail_count,
              s.revoked_at, u.id AS user_id, u.username, u.display_name, u.role_key, u.must_change, u.technician_mode, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1`,
      [tokenHash],
    );
    const row = res.rows[0];
    if (!row || row.revoked_at || row.status !== 'active') return null;
    const now = Date.now();
    return {
      id: row.id,
      tokenHash,
      kind: row.kind,
      user: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name,
        roleKey: row.role_key,
        mustChange: row.must_change,
        technicianMode: row.technician_mode,
      },
      absoluteExpiresAt: row.absolute_expires_at.getTime(),
      lastPinAt: row.last_pin_at.getTime(),
      lastActivityAt: row.last_seen_at.getTime(),
      pinFailCount: row.pin_fail_count,
      loadedAt: now,
      lastPersistedAt: now,
    };
  }

  /** Idle PIN lock. Roles without a PIN (technicians) never lock; see PIN_ROLES. */
  isLocked(entry: SessionEntry, idleMs: number, now = Date.now()): boolean {
    if (!roleUsesPin(entry.user.roleKey)) return false;
    return now - entry.lastActivityAt > idleMs;
  }

  /** Records user activity (not for background polls). Persists at most once a minute. */
  touch(entry: SessionEntry, now = Date.now()): void {
    entry.lastActivityAt = now;
    if (now - entry.lastPersistedAt < ACTIVITY_PERSIST_MS) return;
    entry.lastPersistedAt = now;
    this.pool
      .query('UPDATE sessions SET last_seen_at = to_timestamp($2 / 1000.0) WHERE id = $1', [entry.id, now])
      .catch((err: Error) => console.error('session activity write failed:', err.message));
  }

  async markPinVerified(entry: SessionEntry): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET last_pin_at = now(), last_seen_at = now(), pin_fail_count = 0 WHERE id = $1',
      [entry.id],
    );
    const now = Date.now();
    entry.lastPinAt = now;
    entry.lastActivityAt = now;
    entry.lastPersistedAt = now;
    entry.pinFailCount = 0;
  }

  /** Counts a wrong PIN on this session; revokes it at SESSION_PIN_MAX_FAILURES. */
  async recordPinFailure(entry: SessionEntry): Promise<{ revoked: boolean; remaining: number }> {
    const res = await this.pool.query<{ n: number }>(
      'UPDATE sessions SET pin_fail_count = pin_fail_count + 1 WHERE id = $1 RETURNING pin_fail_count AS n',
      [entry.id],
    );
    entry.pinFailCount = res.rows[0]?.n ?? entry.pinFailCount + 1;
    if (entry.pinFailCount >= SESSION_PIN_MAX_FAILURES) {
      await this.revoke(entry.id, 'pin_lockout');
      return { revoked: true, remaining: 0 };
    }
    return { revoked: false, remaining: SESSION_PIN_MAX_FAILURES - entry.pinFailCount };
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.pool.query(
      'UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL',
      [sessionId, reason],
    );
    for (const [hash, entry] of this.byHash) if (entry.id === sessionId) this.byHash.delete(hash);
  }

  /** Revokes every session of a user (optionally keeping one). Returns how many were revoked. */
  async revokeAllForUser(
    client: pg.PoolClient | pg.Pool,
    userId: string,
    reason: string,
    exceptSessionId?: string,
  ): Promise<number> {
    const res = await client.query(
      `UPDATE sessions SET revoked_at = now(), revoked_reason = $2
       WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [userId, reason, exceptSessionId ?? null],
    );
    for (const [hash, entry] of this.byHash) {
      if (entry.user.id === userId && entry.id !== exceptSessionId) this.byHash.delete(hash);
    }
    return res.rowCount ?? 0;
  }

  /** Drops cached entries for a user so the next request reloads them (e.g. after a rename). */
  forgetUser(userId: string): void {
    for (const [hash, entry] of this.byHash) if (entry.user.id === userId) this.byHash.delete(hash);
  }
}
