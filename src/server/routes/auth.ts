import { Hono, type Context } from 'hono';
import { roleUsesPin } from '../../shared/constants.ts';
import { z } from 'zod';
import {
  changeCredentials,
  login,
  recoverWithCode,
  verifySessionPin,
  issueRecoveryCodes,
} from '../auth/service.ts';
import { withTransaction } from '../db/client.ts';
import type { AppEnv } from '../http/context.ts';
import {
  clearSessionCookies,
  clientIp,
  isBackground,
  requireAuth,
  requireRecentPin,
  sessionToken,
  setSessionCookies,
} from '../http/middleware.ts';
import { permissionsFor } from '../rbac/policy.ts';
import type { SessionEntry } from '../auth/sessions.ts';

const INVALID_CREDENTIALS = 'Username, password or PIN is incorrect.';

// The PIN field is optional: office roles must fill it, technicians leave it empty (ignored).

const LoginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  pin: z.string().max(12).optional().default(''),
  deviceKind: z.enum(['mobile', 'desktop']).default('mobile'),
  deviceLabel: z.string().trim().max(60).optional(),
});

const PinBody = z.object({
  pin: z.string().min(1).max(12),
  purpose: z.enum(['unlock', 'step_up']).default('unlock'),
});

const ChangeCredentialsBody = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
  /** Required for office roles; ignored for technicians, who have no PIN. */
  newPin: z.string().max(12).optional(),
});

const RecoverBody = z.object({
  username: z.string().min(1).max(64),
  recoveryCode: z.string().min(1).max(32),
  newPassword: z.string().min(1).max(256),
  newPin: z.string().min(1).max(12),
});

function sessionView(entry: SessionEntry, locked: boolean, idleMs: number) {
  return {
    authenticated: true as const,
    locked,
    /** false for technicians: no PIN at login, no idle lock, no step-up. */
    pinEnabled: roleUsesPin(entry.user.roleKey),
    mustChange: entry.user.mustChange,
    user: {
      id: entry.user.id,
      username: entry.user.username,
      displayName: entry.user.displayName,
      role: entry.user.roleKey,
    },
    permissions: permissionsFor(entry.user.roleKey),
    kind: entry.kind,
    idleTimeoutMinutes: Math.round(idleMs / 60_000),
    absoluteExpiresAt: new Date(entry.absoluteExpiresAt).toISOString(),
  };
}

function limited(c: Context<AppEnv>, retryAfterSec: number) {
  c.header('Retry-After', String(retryAfterSec));
  return c.json({ error: 'too_many_attempts', retryAfterSec }, 429);
}

async function parseJson<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T> | null> {
  const body = await c.req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
}

export const authRoutes = new Hono<AppEnv>()
  .post('/login', async (c) => {
    const deps = c.get('deps');
    const ip = clientIp(c);
    const gate = deps.authLimiter.hit(`ip:${ip ?? 'unknown'}`);
    if (!gate.allowed) return limited(c, gate.retryAfterSec);

    const body = await parseJson(c, LoginBody);
    if (!body) return c.json({ error: 'invalid_request' }, 400);

    const result = await login(deps, {
      username: body.username,
      password: body.password,
      pin: body.pin,
      kind: body.deviceKind,
      ip,
      userAgent: c.req.header('user-agent') ?? null,
      deviceLabel: body.deviceLabel ?? null,
    });
    if (!result.ok) {
      return result.reason === 'locked'
        ? limited(c, result.retryAfterSec)
        : c.json({ error: 'invalid_credentials', message: INVALID_CREDENTIALS }, 401);
    }
    setSessionCookies(c, result.token, result.entry.absoluteExpiresAt);
    return c.json(sessionView(result.entry, false, await deps.sessions.idleTimeoutMs()));
  })

  .get('/session', async (c) => {
    const deps = c.get('deps');
    c.header('Cache-Control', 'no-store');
    const token = sessionToken(c);
    const entry = token ? await deps.sessions.resolve(token, { background: isBackground(c) }) : null;
    if (!entry) {
      if (token) clearSessionCookies(c);
      return c.json({ authenticated: false });
    }
    const idleMs = await deps.sessions.idleTimeoutMs();
    const locked = deps.sessions.isLocked(entry, idleMs);
    if (!locked && !isBackground(c)) deps.sessions.touch(entry);
    return c.json(sessionView(entry, locked, idleMs));
  })

  .post('/logout', requireAuth({ allowLocked: true, allowMustChange: true }), async (c) => {
    const { entry } = c.get('auth');
    await c.get('deps').sessions.revoke(entry.id, 'logout');
    clearSessionCookies(c);
    return c.json({ ok: true });
  })

  // Idle unlock and step-up re-entry. Five wrong PINs revoke the session.
  .post('/verify-pin', requireAuth({ allowLocked: true, allowMustChange: true }), async (c) => {
    const deps = c.get('deps');
    const body = await parseJson(c, PinBody);
    if (!body) return c.json({ error: 'invalid_request' }, 400);
    const { entry } = c.get('auth');
    const result = await verifySessionPin(deps, entry, body.pin, { ip: clientIp(c), stage: body.purpose });
    if (result.ok) return c.json({ ok: true });
    if (result.notApplicable) return c.json({ error: 'pin_not_applicable' }, 403);
    if (result.revoked) {
      clearSessionCookies(c);
      return c.json({ error: 'unauthenticated', reason: 'pin_lockout' }, 401);
    }
    return c.json({ error: 'invalid_pin', remainingAttempts: result.remaining }, 403);
  })

  .post('/change-credentials', requireAuth({ allowMustChange: true }), async (c) => {
    const deps = c.get('deps');
    const body = await parseJson(c, ChangeCredentialsBody);
    if (!body) return c.json({ error: 'invalid_request' }, 400);
    const { entry } = c.get('auth');
    const result = await changeCredentials(deps, entry, { ...body, ip: clientIp(c) });
    if (result.ok) return c.json({ ok: true, recoveryCodes: result.recoveryCodes });
    if (result.sessionRevoked) {
      clearSessionCookies(c);
      return c.json({ error: 'unauthenticated', reason: 'pin_lockout' }, 401);
    }
    return c.json({ error: result.error }, 400);
  })

  // Master-only: replace the recovery codes (old unused ones stop working). Shown once.
  .post('/recovery-codes', requireAuth(), requireRecentPin(), async (c) => {
    const { actor } = c.get('auth');
    if (actor.roleKey !== 'master') return c.json({ error: 'forbidden' }, 403);
    const codes = await withTransaction(c.get('deps').pool, (client) =>
      issueRecoveryCodes(client, actor.id, actor.id),
    );
    return c.json({ recoveryCodes: codes });
  })

  // Email-free Master recovery with a single-use code. Rate limited like login.
  .post('/recover', async (c) => {
    const deps = c.get('deps');
    const ip = clientIp(c);
    const gate = deps.authLimiter.hit(`ip:${ip ?? 'unknown'}`);
    if (!gate.allowed) return limited(c, gate.retryAfterSec);
    const body = await parseJson(c, RecoverBody);
    if (!body) return c.json({ error: 'invalid_request' }, 400);
    const result = await recoverWithCode(deps, {
      username: body.username,
      code: body.recoveryCode,
      newPassword: body.newPassword,
      newPin: body.newPin,
      ip,
    });
    if (result.ok) return c.json({ ok: true, remainingCodes: result.remainingCodes });
    if (result.reason === 'locked') return limited(c, result.retryAfterSec);
    if (result.reason === 'invalid') return c.json({ error: 'invalid_recovery' }, 401);
    return c.json({ error: result.reason }, 400);
  });
