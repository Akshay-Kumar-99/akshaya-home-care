import { existsSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { parsePepper } from './auth/hashing.ts';
import { SlidingWindowLimiter } from './auth/rate-limit.ts';
import { SessionStore } from './auth/sessions.ts';
import { loadConfig } from './config.ts';
import { createPool } from './db/client.ts';
import { SettingsCache } from './services/settings.ts';

const config = loadConfig();
const distWeb = path.resolve(import.meta.dirname, '../../dist/web');
const staticRoot = config.NODE_ENV === 'production' && existsSync(distWeb) ? distWeb : undefined;

const pool = createPool(config.DATABASE_URL);
const settings = new SettingsCache(pool);
const app = createApp({
  staticRoot,
  deps: {
    pool,
    settings,
    sessions: new SessionStore(pool, settings),
    pepper: parsePepper(config.PIN_PEPPER),
    secureCookies: config.NODE_ENV === 'production',
    trustProxy: config.TRUST_PROXY,
    // 10 login/recovery attempts per IP per 5 minutes.
    authLimiter: new SlidingWindowLimiter(10, 5 * 60_000),
  },
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Server listening on port ${info.port} (${config.NODE_ENV})`);
});

// Render sends SIGTERM on deploy and spin-down; let in-flight requests finish.
function shutdown(): void {
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
