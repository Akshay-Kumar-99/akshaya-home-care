import { Hono } from 'hono';
import { z } from 'zod';
import { ReasonSchema, SubmissionInputSchema } from '../../shared/schemas.ts';
import { isUuid, readJson, readJsonOrIssues } from '../http/body.ts';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission, requireRecentPin } from '../http/middleware.ts';
import {
  decideVoidRequest,
  getInvoice,
  issueOwn,
  listInvoices,
  listVoidRequests,
  requestVoid,
  voidInvoice,
  type VoidResult,
} from '../services/invoices.ts';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)));

const ListQuery = z
  .object({
    state: z.enum(['submitted', 'issued', 'void', 'rejected']).optional(),
    q: z.string().max(80).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, 'from must not be after to');

const NoteSchema = z.object({ note: z.string().trim().max(300).optional() });

function voidStatus(result: Exclude<VoidResult, { ok: true }>): 404 | 409 {
  return result.error === 'not_found' ? 404 : 409;
}

/** All invoices (checkers and Master), Issue & Copy for own jobs, void flows. */
export const invoiceRoutes = new Hono<AppEnv>()
  .use('*', requireAuth())

  .get('/', requirePermission('invoice.view_all'), async (c) => {
    const query = ListQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid_request' }, 400);
    return c.json(await listInvoices(c.get('deps').pool, query.data));
  })

  // Master / Admin Technician: submit + issue their own job in one transaction.
  .post('/issue-own', requirePermission('invoice.issue_own'), async (c) => {
    const body = await readJsonOrIssues(c, SubmissionInputSchema);
    if (!body.ok) return c.json({ error: 'invalid_request', issues: body.issues }, 422);
    const deps = c.get('deps');
    try {
      const result = await issueOwn(deps.pool, c.get('auth').actor, body.data);
      if (!result.ok) return c.json({ error: result.error }, 409);
      deps.queue.changed();
      return c.json({
        outcome: 'issued',
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        message: result.message,
        customerName: result.customerName,
        phone: result.phone,
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23503') return c.json({ error: 'invalid_reference' }, 422);
      throw err;
    }
  })

  .get('/:id', requirePermission('invoice.view_all'), async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const invoice = await getInvoice(c.get('deps').pool, id);
    return invoice ? c.json(invoice) : c.json({ error: 'not_found' }, 404);
  })

  .post('/:id/void', requirePermission('invoice.void'), requireRecentPin(), async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, ReasonSchema);
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    if (!body) return c.json({ error: 'reason_required' }, 400);
    const deps = c.get('deps');
    const result = await voidInvoice(deps.pool, c.get('auth').actor, id, body.reason);
    if (!result.ok) return c.json({ error: result.error }, voidStatus(result));
    deps.queue.changed();
    return c.json({ ok: true });
  })

  .post('/:id/void-request', requirePermission('void.request'), async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, ReasonSchema);
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    if (!body) return c.json({ error: 'reason_required' }, 400);
    const result = await requestVoid(c.get('deps').pool, c.get('auth').actor, id, body.reason);
    if (!result.ok) return c.json({ error: result.error }, voidStatus(result));
    return c.json({ ok: true });
  });

/** Master: approve or refuse the Admin Technician's void requests. */
export const voidRequestRoutes = new Hono<AppEnv>()
  .use('*', requireAuth(), requirePermission('void.approve'))

  .get('/', async (c) => {
    const status = z.enum(['pending', 'approved', 'rejected']).catch('pending').parse(c.req.query('status'));
    return c.json({ items: await listVoidRequests(c.get('deps').pool, status) });
  })

  .post('/:id/approve', requireRecentPin(), async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const body = (await readJson(c, NoteSchema)) ?? {};
    const deps = c.get('deps');
    const result = await decideVoidRequest(deps.pool, c.get('auth').actor, id, true, body.note ?? null);
    if (!result.ok) return c.json({ error: result.error }, voidStatus(result));
    deps.queue.changed();
    return c.json({ ok: true });
  })

  .post('/:id/reject', async (c) => {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'not_found' }, 404);
    const body = (await readJson(c, NoteSchema)) ?? {};
    const result = await decideVoidRequest(c.get('deps').pool, c.get('auth').actor, id, false, body.note ?? null);
    if (!result.ok) return c.json({ error: result.error }, voidStatus(result));
    return c.json({ ok: true });
  });
