import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { AppDeps, AppEnv } from './http/context.ts';
import { sameOriginGuard } from './http/middleware.ts';
import { adminRoutes } from './routes/admin.ts';
import { analyticsRoutes } from './routes/analytics.ts';
import { authRoutes } from './routes/auth.ts';
import { healthRoutes } from './routes/health.ts';
import { invoiceRoutes, voidRequestRoutes } from './routes/invoices.ts';
import { jobRoutes, lookupRoutes } from './routes/jobs.ts';
import { pushRoutes } from './routes/push.ts';
import { workRoutes } from './routes/work.ts';
import { workInvRoutes } from './routes/workinv.ts';
import { serveSpa } from './static.ts';

export interface AppOptions {
  /** Directory of the built SPA (dist/web). Omit in development, where Vite serves it. */
  staticRoot?: string;
  /** Database-backed services. Omitted only by tests that exercise health/static alone. */
  deps?: AppDeps;
}

export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
      referrerPolicy: 'no-referrer',
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.route('/api/health', healthRoutes);

  const { deps } = options;
  if (deps) {
    app.use('/api/*', async (c, next) => {
      c.set('deps', deps);
      c.header('Cache-Control', 'no-store');
      await next();
    });
    app.use('/api/*', sameOriginGuard);
    app.route('/api/auth', authRoutes);
    app.route('/api/admin', adminRoutes);
    app.route('/api/lookups', lookupRoutes);
    app.route('/api/jobs', jobRoutes);
    app.route('/api/workinv', workInvRoutes);
    app.route('/api/work', workRoutes);
    app.route('/api/invoices', invoiceRoutes);
    app.route('/api/void-requests', voidRequestRoutes);
    app.route('/api/push', pushRoutes);
    app.route('/api/analytics', analyticsRoutes);
  }

  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('Unhandled error:', err instanceof Error ? err.message : err);
    return c.json({ error: 'internal_error' }, 500);
  });

  const { staticRoot } = options;
  if (staticRoot) {
    app.get('*', (c) => serveSpa(staticRoot, c.req.path));
  }

  return app;
}
