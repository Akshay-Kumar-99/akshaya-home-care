import { Hono } from 'hono';
import { z } from 'zod';
import { istDateString } from '../../shared/dates.ts';
import { PhoneSchema } from '../../shared/schemas.ts';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission } from '../http/middleware.ts';
import { customerHistory, daysBetween, overview } from '../services/analytics.ts';

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)));
const MAX_DAYS = 1100; // about three financial years

const RangeQuery = z
  .object({ from: IsoDate.optional(), to: IsoDate.optional() })
  .transform((q) => {
    const to = q.to ?? istDateString();
    const from = q.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
    return { from, to };
  })
  .refine((r) => r.from <= r.to, 'from must not be after to')
  .refine((r) => daysBetween(r.from, r.to) <= MAX_DAYS, 'range too long');

/** Master analytics (read-only). */
export const analyticsRoutes = new Hono<AppEnv>()
  .use('*', requireAuth(), requirePermission('analytics.view'))

  .get('/overview', async (c) => {
    const range = RangeQuery.safeParse(c.req.query());
    if (!range.success) return c.json({ error: 'invalid_range' }, 400);
    return c.json(await overview(c.get('deps').pool, range.data.from, range.data.to));
  })

  .get('/customer', async (c) => {
    const phone = PhoneSchema.safeParse(c.req.query('phone') ?? '');
    if (!phone.success) return c.json({ error: 'invalid_phone' }, 400);
    const history = await customerHistory(c.get('deps').pool, phone.data);
    return history ? c.json(history) : c.json({ error: 'not_found' }, 404);
  });
