import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission, requireRecentPin } from '../http/middleware.ts';
import {
  listActiveSessions,
  listUsers,
  loginHistory,
  renameUser,
  resetUserCredentials,
  revokeUserSessions,
  setUserStatus,
  type AdminResult,
} from '../services/users.ts';

const IdParam = z.uuid();
const ReasonBody = z.object({ reason: z.string().trim().min(1).max(300) });
const RenameBody = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    username: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{2,31}$/i, 'letters, digits, dot, dash or underscore; 3–32 chars')
      .optional(),
  })
  .refine((v) => v.displayName !== undefined || v.username !== undefined, 'nothing to change');
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

function respond<T extends object>(c: Context<AppEnv>, result: AdminResult<T>) {
  if (result.ok) return c.json(result);
  const status = result.error === 'not_found' ? 404 : result.error === 'invalid' ? 400 : 409;
  return c.json({ error: result.error }, status);
}

// Master-only administration. Reads need the permission; every change also needs a fresh PIN.
export const adminRoutes = new Hono<AppEnv>()
  .use('*', requireAuth())

  .get('/users', requirePermission('users.manage'), async (c) =>
    c.json({ users: await listUsers(c.get('deps').pool) }),
  )

  .get('/users/:id/sessions', requirePermission('users.manage'), async (c) => {
    const id = targetId(c);
    if (!id) return c.json({ error: 'not_found' }, 404);
    return c.json({ sessions: await listActiveSessions(c.get('deps').pool, id) });
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

  .patch('/users/:id', requirePermission('users.manage'), requireRecentPin(), async (c) => {
    const id = targetId(c);
    const input = await body(c, RenameBody);
    if (!id) return c.json({ error: 'not_found' }, 404);
    if (!input) return c.json({ error: 'invalid_request' }, 400);
    const deps = c.get('deps');
    return respond(c, await renameUser(deps.pool, deps.sessions, c.get('auth').actor, id, input));
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

  .get('/login-history', requirePermission('audit.view'), async (c) => {
    const query = HistoryQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json({ attempts: await loginHistory(c.get('deps').pool, query.data) });
  });
