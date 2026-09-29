import { Hono } from 'hono';
import { z } from 'zod';
import { readJson } from '../http/body.ts';
import type { AppEnv } from '../http/context.ts';
import { requireAuth, requirePermission } from '../http/middleware.ts';

const SubscribeSchema = z.object({
  endpoint: z.url().max(1000).refine((u) => u.startsWith('https://'), 'push endpoints are https'),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
});
const UnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(1000) });

/** Web Push opt-in for checkers' devices (the Work Inv alert). */
export const pushRoutes = new Hono<AppEnv>()
  .use('*', requireAuth(), requirePermission('workinv.use'))

  .get('/config', (c) => {
    const { push } = c.get('deps');
    return c.json({ enabled: push.enabled, publicKey: push.publicKey });
  })

  .post('/subscribe', async (c) => {
    const { push } = c.get('deps');
    if (!push.enabled) return c.json({ error: 'push_disabled' }, 409);
    const body = await readJson(c, SubscribeSchema);
    if (!body) return c.json({ error: 'invalid_request' }, 400);
    await push.subscribe(c.get('auth').actor.id, body, c.req.header('user-agent') ?? null);
    return c.json({ ok: true });
  })

  .post('/unsubscribe', async (c) => {
    const body = await readJson(c, UnsubscribeSchema);
    if (!body) return c.json({ error: 'invalid_request' }, 400);
    await c.get('deps').push.unsubscribe(c.get('auth').actor.id, body.endpoint);
    return c.json({ ok: true });
  });
