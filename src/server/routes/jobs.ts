import { Hono } from 'hono';
import { z } from 'zod';
import { PhoneSchema, SubmissionInputSchema } from '../../shared/schemas.ts';
import { readJsonOrIssues } from '../http/body.ts';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission } from '../http/middleware.ts';
import { listMine } from '../services/invoices.ts';
import { findCustomerByPhone } from '../services/lookups.ts';
import { createSubmission } from '../services/submissions.ts';
import { INVALID_WARRANTY_ISSUE, InvalidWarranty } from '../services/warranty.ts';

const MineQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Form vocabularies and the repeat-customer lookup. Any signed-in role that can submit. */
export const lookupRoutes = new Hono<AppEnv>()
  .use('*', requireAuth())
  .get('/', async (c) => c.json(await c.get('deps').lookups.get()))
  .get('/customer', requirePermission('invoice.submit'), async (c) => {
    const phone = PhoneSchema.safeParse(c.req.query('phone') ?? '');
    if (!phone.success) return c.json({ error: 'invalid_phone' }, 400);
    return c.json(await findCustomerByPhone(c.get('deps').pool, c.get('auth').actor, phone.data));
  });

/** The maker side: "Save to Server" and "My Submissions". */
export const jobRoutes = new Hono<AppEnv>()
  .use('*', requireAuth())

  .post('/', requirePermission('invoice.submit'), async (c) => {
    const deps = c.get('deps');
    const body = await readJsonOrIssues(c, SubmissionInputSchema);
    if (!body.ok) return c.json({ error: 'invalid_request', issues: body.issues }, 422);
    try {
      const result = await createSubmission(deps.pool, c.get('auth').actor, body.data);
      if (result.created) {
        deps.queue.changed();
        deps.push.notifyNewSubmission();
      }
      return c.json({ invoiceId: result.invoiceId, created: result.created, state: 'submitted' });
    } catch (err) {
      if (err instanceof InvalidWarranty) return c.json({ error: 'invalid_warranty', issues: [INVALID_WARRANTY_ISSUE] }, 422);
      // Unknown appliance type, area or brand id.
      if ((err as { code?: string }).code === '23503') return c.json({ error: 'invalid_reference' }, 422);
      throw err;
    }
  })

  .get('/mine', requirePermission('invoice.view_own'), async (c) => {
    const query = MineQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid_request' }, 400);
    const items = await listMine(c.get('deps').pool, c.get('auth').actor, query.data.limit);
    return c.json({ items });
  });
