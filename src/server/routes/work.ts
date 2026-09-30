import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { WorkVersion } from '../../shared/api-types.ts';
import { ReasonSchema, WorkCompleteSchema, WorkOrderInputSchema, WorkOrderUpdateSchema } from '../../shared/schemas.ts';
import { isUuid, readJson, readJsonOrIssues } from '../http/body.ts';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission } from '../http/middleware.ts';
import {
  cancelWorkOrder,
  completeWork,
  createWorkOrder,
  listMyWork,
  listWorkOrders,
  listWorkTechnicians,
  startWork,
  updateWorkOrder,
  type WorkError,
} from '../services/work.ts';
import { INVALID_WARRANTY_ISSUE } from '../services/warranty.ts';

const ListQuery = z.object({
  view: z.enum(['open', 'completed', 'cancelled']).default('open'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

function fail(c: Context<AppEnv>, error: WorkError) {
  const status = error === 'not_found' ? 404 : error === 'wrong_state' ? 409 : 422;
  if (error === 'invalid_warranty') return c.json({ error, issues: [INVALID_WARRANTY_ISSUE] }, status);
  return c.json({ error }, status);
}

/**
 * Work allocation. Office side (`work.assign`: Master, Admin Technician) creates and manages
 * work orders; the technician side (`work.do`: "Invoice + Work allocation" technicians) works
 * through their own list. Every change bumps the affected technicians' Works assigned version.
 */
export const workRoutes = new Hono<AppEnv>()
  .use('*', requireAuth())

  // ---------------------------------------------------------------- technician: Works assigned

  // The badge poll. Sent with X-Ahc-Background: answered from memory, no DB.
  .get('/mine/version', requirePermission('work.do'), (c) => {
    const body: WorkVersion = { version: c.get('deps').work.version(c.get('auth').actor.id) };
    return c.json(body);
  })

  .get('/mine', requirePermission('work.do'), async (c) =>
    c.json({ items: await listMyWork(c.get('deps').pool, c.get('auth').actor) }),
  )

  .post('/:id/start', requirePermission('work.do'), async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const deps = c.get('deps');
    const actor = c.get('auth').actor;
    const result = await startWork(deps.pool, actor, id);
    if (!result.ok) return fail(c, result.error);
    deps.work.changed(actor.id);
    return c.json({ ok: true });
  })

  .post('/:id/complete', requirePermission('work.do'), async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const body = await readJsonOrIssues(c, WorkCompleteSchema);
    if (!body.ok) return c.json({ error: 'invalid_request', issues: body.issues }, 422);
    const deps = c.get('deps');
    const actor = c.get('auth').actor;
    const result = await completeWork(deps.pool, actor, id, body.data);
    if (!result.ok) return fail(c, result.error);
    if (result.created) {
      deps.queue.changed();
      deps.work.changed(actor.id);
      deps.push.notifyNewSubmission();
    }
    return c.json({ invoiceId: result.invoiceId, created: result.created, state: 'submitted' });
  })

  // ---------------------------------------------------------------- office: work orders

  .get('/', requirePermission('work.assign'), async (c) => {
    const query = ListQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json({ items: await listWorkOrders(c.get('deps').pool, query.data.view, query.data.limit) });
  })

  .get('/technicians', requirePermission('work.assign'), async (c) =>
    c.json({ technicians: await listWorkTechnicians(c.get('deps').pool) }),
  )

  .post('/', requirePermission('work.assign'), async (c) => {
    const body = await readJsonOrIssues(c, WorkOrderInputSchema);
    if (!body.ok) return c.json({ error: 'invalid_request', issues: body.issues }, 422);
    const deps = c.get('deps');
    const result = await createWorkOrder(deps.pool, c.get('auth').actor, body.data);
    if (!result.ok) return fail(c, result.error);
    deps.work.changed(body.data.assignedTo);
    return c.json({ ok: true, jobId: result.jobId });
  })

  .patch('/:id', requirePermission('work.assign'), async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const body = await readJsonOrIssues(c, WorkOrderUpdateSchema);
    if (!body.ok) return c.json({ error: 'invalid_request', issues: body.issues }, 422);
    const deps = c.get('deps');
    const result = await updateWorkOrder(deps.pool, c.get('auth').actor, id, body.data);
    if (!result.ok) return fail(c, result.error);
    deps.work.changed(result.previousAssignee, result.assignee === result.previousAssignee ? null : result.assignee);
    return c.json({ ok: true });
  })

  .post('/:id/cancel', requirePermission('work.assign'), async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, ReasonSchema);
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    if (!body) return c.json({ error: 'reason_required' }, 400);
    const deps = c.get('deps');
    const result = await cancelWorkOrder(deps.pool, c.get('auth').actor, id, body.reason);
    if (!result.ok) return fail(c, result.error);
    deps.work.changed(result.assignee);
    return c.json({ ok: true });
  });
