import { Hono } from 'hono';

// Warm-up and liveness endpoint. It deliberately does NOT touch the database:
// the app calls it on open to wake the Render instance, and a DB query here would
// also keep Neon awake and burn the free 100 CU-hour monthly budget.
export const healthRoutes = new Hono().get('/', (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json({ status: 'ok', time: new Date().toISOString() });
});
