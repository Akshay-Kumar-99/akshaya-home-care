import { timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { csrfTokenFor } from '../auth/sessions.ts';
import { can, type Action } from '../rbac/policy.ts';
import type { AppDeps, AppEnv } from './context.ts';

export const BACKGROUND_HEADER = 'x-ahc-background';
export const CSRF_HEADER = 'x-csrf-token';
/** Sensitive actions need the PIN within this window. [ASSUMPTION] 5 minutes. */
export const STEP_UP_WINDOW_SEC = 300;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function cookieNames(deps: AppDeps): { session: string; csrf: string } {
  return deps.secureCookies
    ? { session: '__Host-ahc_session', csrf: '__Host-ahc_csrf' }
    : { session: 'ahc_session', csrf: 'ahc_csrf' };
}

export function setSessionCookies(c: Context<AppEnv>, token: string, expiresAtMs: number): void {
  const deps = c.get('deps');
  const names = cookieNames(deps);
  const maxAge = Math.max(0, Math.floor((expiresAtMs - Date.now()) / 1000));
  const base = { path: '/', secure: deps.secureCookies, sameSite: 'Strict' as const, maxAge };
  setCookie(c, names.session, token, { ...base, httpOnly: true });
  // Readable by the page so it can echo it in the X-CSRF-Token header.
  setCookie(c, names.csrf, csrfTokenFor(token), { ...base, httpOnly: false });
}

export function clearSessionCookies(c: Context<AppEnv>): void {
  const deps = c.get('deps');
  const names = cookieNames(deps);
  deleteCookie(c, names.session, { path: '/', secure: deps.secureCookies });
  deleteCookie(c, names.csrf, { path: '/', secure: deps.secureCookies });
}

export function sessionToken(c: Context<AppEnv>): string | undefined {
  return getCookie(c, cookieNames(c.get('deps')).session);
}

export function isBackground(c: Context): boolean {
  return c.req.header(BACKGROUND_HEADER) === '1';
}

/** Client IP: first X-Forwarded-For hop behind the trusted proxy, else the socket address. */
export function clientIp(c: Context<AppEnv>): string | null {
  if (c.get('deps').trustProxy) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return forwarded.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null; // no socket (e.g. in-process test requests)
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Rejects cross-site state-changing requests before any handler runs: Origin (when sent)
 * must match Host, and Sec-Fetch-Site must not be cross-site. SameSite=Strict cookies and
 * the per-session CSRF token (checked in requireAuth) are the other two layers.
 */
export const sameOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (MUTATING.has(c.req.method)) {
    const origin = c.req.header('origin');
    const host = c.req.header('host') ?? new URL(c.req.url).host;
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (originHost !== host) return c.json({ error: 'bad_origin' }, 403);
    }
    if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'bad_origin' }, 403);
  }
  await next();
};

export interface RequireAuthOptions {
  /** Allow a session that is idle-locked (only the unlock / logout / session routes). */
  allowLocked?: boolean;
  /** Allow a session whose user must still change the seeded credentials. */
  allowMustChange?: boolean;
}

/** Loads the session, enforces CSRF, the idle PIN lock and forced credential change. */
export function requireAuth(options: RequireAuthOptions = {}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get('deps');
    const token = sessionToken(c);
    if (!token) return c.json({ error: 'unauthenticated' }, 401);

    const background = isBackground(c);
    const entry = await deps.sessions.resolve(token, { background });
    if (!entry) {
      clearSessionCookies(c);
      return c.json({ error: 'unauthenticated' }, 401);
    }

    if (MUTATING.has(c.req.method)) {
      const sent = c.req.header(CSRF_HEADER) ?? '';
      if (!safeEqual(sent, csrfTokenFor(token))) return c.json({ error: 'csrf_failed' }, 403);
    }

    const locked = deps.sessions.isLocked(entry, await deps.sessions.idleTimeoutMs());
    if (locked && !options.allowLocked) return c.json({ error: 'pin_required' }, 401);
    if (entry.user.mustChange && !options.allowMustChange) {
      return c.json({ error: 'must_change_credentials' }, 403);
    }
    if (!locked && !background) deps.sessions.touch(entry);

    c.set('auth', {
      entry,
      token,
      actor: { id: entry.user.id, roleKey: entry.user.roleKey, ip: clientIp(c) },
    });
    await next();
  };
}

export function requirePermission(action: Action): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!can(c.get('auth').actor.roleKey, action)) return c.json({ error: 'forbidden' }, 403);
    await next();
  };
}

/** Sensitive actions: the PIN must have been entered within STEP_UP_WINDOW_SEC. */
export function requireRecentPin(windowSec = STEP_UP_WINDOW_SEC): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { entry } = c.get('auth');
    if (Date.now() - entry.lastPinAt > windowSec * 1000) {
      return c.json({ error: 'step_up_required' }, 403);
    }
    await next();
  };
}
