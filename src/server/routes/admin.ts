import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BusinessSettingsSchema, CreateUserSchema, SetCredentialsSchema, UpdateUserSchema } from '../../shared/schemas.ts';
import { readJsonOrIssues } from '../http/body.ts';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission, requireRecentPin } from '../http/middleware.ts';
import {
  createUser,
  listActiveSessions,
  listUsers,
  loginHistory,
  resetUserCredentials,
  revokeUserSessions,
  setUserCredentials,
  setUserStatus,
  updateUser,
  type AdminResult,
} from '../services/users.ts';
import { readBusinessSettings, updateBusinessSettings } from '../services/settings.ts';

const IdParam = z.uuid();
const ReasonBody = z.object({ reason: z.string().trim().min(1).max(300) });
const HistoryQuery = z.object({
  userId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

function targetId(c: Context<AppEnv>): string | null {
  const parsed = IdParam.safeParse(c.req.param('id'));
  return parsed.success ? parsed.data : null;
}

async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T> | null> {
  const parsed = schema.safeParse(await c.req.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

const BAD_INPUT = new Set(['invalid', 'pin_not_applicable', 'not_a_technician', 'password_length',
  'password_contains_username', 'password_repetitive', 'pin_format', 'pin_weak']);

function respond<T extends object>(c: Context<AppEnv>, result: AdminResult<T>) {
  if (result.ok) return c.json(result);
  const status = result.error === 'not_found' ? 404 : BAD_INPUT.has(result.error) ? 400 : 409;
  return c.json({ error: result.error }, status);
}

// Master-only team management. Reads need the permission; every change also needs a fresh PIN.
export const adminRoutes = new Hono<AppEnv>()
  .use('*', requireAuth())

  .get('/users', requirePermission('users.manage'), async (c) =>
    c.json({ users: await listUsers(c.get('deps').pool) }),
  )

  .post('/users', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const input = await body(c, CreateUserSchema);
    if (!input) return c.json({ error: 'invalid_request' }, 400);
    const deps = c.get('deps');
    return respond(c, await createUser(deps.pool, deps.pepper, c.get('auth').actor, input));
  })

  .get('/users/:id/sessions', requirePermission('users.manage'), async (c) => {
    const id = targetId(c);
    if (!id) return c.json({ error: 'not_found' }, 404);
    return c.json({ sessions: await listActiveSessions(c.get('deps').pool, id) });
  })

  .patch('/users/:id', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const id = targetId(c);
    const input = await body(c, UpdateUserSchema);
    if (!id) return c.json({ error: 'not_found' }, 404);
    if (!input) return c.json({ error: 'invalid_request' }, 400);
    const deps = c.get('deps');
    const result = await updateUser(deps.pool, deps.sessions, c.get('auth').actor, id, input);
    if (result.ok && input.technicianMode) deps.work.changed(id);
    return respond(c, result);
  })

  .post('/users/:id/credentials', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const id = targetId(c);
    const input = await body(c, SetCredentialsSchema);
    if (!id) return c.json({ error: 'not_found' }, 404);
    if (!input) return c.json({ error: 'invalid_request' }, 400);
    const deps = c.get('deps');
    return respond(c, await setUserCredentials(deps.pool, deps.sessions, deps.pepper, c.get('auth').actor, id, input));
  })

  .post('/users/:id/reset-credentials', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const id = targetId(c);
    if (!id) return c.json({ error: 'not_found' }, 404);
    const deps = c.get('deps');
    c.header('Cache-Control', 'no-store');
    return respond(c, await resetUserCredentials(deps.pool, deps.sessions, deps.pepper, c.get('auth').actor, id));
  })

  .post('/users/:id/disable', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const id = targetId(c);
    const input = await body(c, ReasonBody);
    if (!id) return c.json({ error: 'not_found' }, 404);
    if (!input) return c.json({ error: 'invalid_request' }, 400);
    const deps = c.get('deps');
    return respond(c, await setUserStatus(deps.pool, deps.sessions, c.get('auth').actor, id, 'disabled', input.reason));
  })

  .post('/users/:id/enable', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const id = targetId(c);
    const input = await body(c, ReasonBody);
    if (!id) return c.json({ error: 'not_found' }, 404);
    if (!input) return c.json({ error: 'invalid_request' }, 400);
    const deps = c.get('deps');
    return respond(c, await setUserStatus(deps.pool, deps.sessions, c.get('auth').actor, id, 'active', input.reason));
  })

  .post('/users/:id/revoke-sessions', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const id = targetId(c);
    if (!id) return c.json({ error: 'not_found' }, 404);
    const deps = c.get('deps');
    const { actor, entry } = c.get('auth');
    // Revoking one's own sessions keeps the current one.
    const keep = id === actor.id ? entry.id : undefined;
    return respond(c, await revokeUserSessions(deps.pool, deps.sessions, actor, id, keep));
  })

  // Business settings printed on every invoice: the Terms & Conditions link and the phone.
  .get('/settings', requirePermission('settings.manage'), async (c) =>
    c.json(await readBusinessSettings(c.get('deps').settings)),
  )

  .patch('/settings', requirePermission('settings.manage'), requireRecentPin(), async (c) => {
    const body = await readJsonOrIssues(c, BusinessSettingsSchema);
    if (!body.ok) return c.json({ error: 'invalid_request', issues: body.issues }, 422);
    const deps = c.get('deps');
    const saved = await updateBusinessSettings(deps.pool, deps.settings, c.get('auth').actor, body.data);
    deps.queue.changed(); // Work Inv previews show the new text
    return c.json(saved);
  })

  .get('/login-history', requirePermission('audit.view'), async (c) => {
    const query = HistoryQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json({ attempts: await loginHistory(c.get('deps').pool, query.data) });
  });
