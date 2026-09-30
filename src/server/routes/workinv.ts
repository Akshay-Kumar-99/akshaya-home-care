import { Hono, type Context } from 'hono';
import type { QueueResponse, QueueVersion } from '../../shared/api-types.ts';
import { CopySchema, EditPendingSchema, ReasonSchema } from '../../shared/schemas.ts';
import { isUuid, readJson, readJsonOrIssues } from '../http/body.ts';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission, STEP_UP_WINDOW_SEC } from '../http/middleware.ts';
import { copyMessage, editPending, listPending, listRecent, reject, requeue, type Business } from '../services/workinv.ts';

/** The phone and Terms & Conditions link printed on every message (cached settings). */
async function business(c: Context<AppEnv>): Promise<Business> {
  const settings = c.get('deps').settings;
  const [officialPhoneE164, termsUrl] = await Promise.all([
    settings.get<string>('official_phone', '+919841459657'),
    settings.get<string | null>('terms_url', null),
  ]);
  return { officialPhoneE164, termsUrl: termsUrl || null };
}

async function alertHours(c: Context<AppEnv>): Promise<number> {
  return c.get('deps').settings.get<number>('queue_alert_hours', 4);
}

/** Technician Work Inv: the checkers' queue (Admin Technician primary, Master backup). */
export const workInvRoutes = new Hono<AppEnv>()
  .use('*', requireAuth(), requirePermission('workinv.use'))

  // The 30-second badge poll. Sent with X-Ahc-Background: answered from memory, no DB,
  // and does not count as user activity.
  .get('/version', async (c) => {
    const snapshot = await c.get('deps').queue.snapshot();
    const body: QueueVersion = { ...snapshot, queueAlertHours: await alertHours(c) };
    return c.json(body);
  })

  .get('/pending', async (c) => {
    const body: QueueResponse = {
      items: await listPending(c.get('deps').pool, await business(c)),
      queueAlertHours: await alertHours(c),
    };
    return c.json(body);
  })

  .get('/recent', async (c) => {
    const body: QueueResponse = {
      items: await listRecent(c.get('deps').pool, await business(c)),
      queueAlertHours: await alertHours(c),
    };
    return c.json(body);
  })

  .post('/:id/copy', async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, CopySchema);
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    if (!body) return c.json({ error: 'invalid_request' }, 400);
    const deps = c.get('deps');
    const result = await copyMessage(deps.pool, c.get('auth').actor, id, body.expect);
    if (!result.ok) {
      if (result.error === 'not_found') return c.json({ error: 'not_found' }, 404);
      return c.json(result.error === 'already_copied'
        ? { error: 'already_copied', by: result.by, at: result.at }
        : { error: 'not_copyable', state: result.state }, 409);
    }
    deps.queue.changed();
    const { ok: _ok, ...copy } = result;
    return c.json(copy);
  })

  .post('/:id/requeue', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const deps = c.get('deps');
    const result = await requeue(deps.pool, c.get('auth').actor, id);
    if (!result.ok) return c.json({ error: result.error }, result.error === 'not_found' ? 404 : 409);
    deps.queue.changed();
    return c.json({ ok: true });
  })

  .post('/:id/reject', requirePermission('invoice.reject'), async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, ReasonSchema);
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    if (!body) return c.json({ error: 'reason_required' }, 400);
    const deps = c.get('deps');
    const result = await reject(deps.pool, c.get('auth').actor, id, body.reason);
    if (!result.ok) return c.json({ error: result.error }, result.error === 'not_found' ? 404 : 409);
    deps.queue.changed();
    deps.work.changed(result.returnedTo);
    return c.json({ ok: true, returnedToTechnician: result.returnedTo !== null });
  })

  // Edit a pending item. Amount changes need a fresh PIN (step-up).
  .patch('/:id', requirePermission('invoice.edit_pending'), async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const body = await readJsonOrIssues(c, EditPendingSchema);
    if (!body.ok) return c.json({ error: 'invalid_request', issues: body.issues }, 422);
    const deps = c.get('deps');
    const { actor, entry } = c.get('auth');
    const stepUpFresh = Date.now() - entry.lastPinAt <= STEP_UP_WINDOW_SEC * 1000;
    const result = await editPending(deps.pool, actor, id, body.data, stepUpFresh);
    if (!result.ok) {
      const status =
        result.error === 'not_found' ? 404 : result.error === 'step_up_required' ? 403 : result.error === 'wrong_state' ? 409 : 422;
      return c.json({ error: result.error }, status);
    }
    if (result.changed.length > 0) deps.queue.changed();
    return c.json({ ok: true, changed: result.changed });
  });
