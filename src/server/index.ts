import { existsSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { parsePepper } from './auth/hashing.ts';
import { PinChallengeStore } from './auth/challenges.ts';
import { SlidingWindowLimiter } from './auth/rate-limit.ts';
import { SessionStore } from './auth/sessions.ts';
import { loadConfig, vapidFrom } from './config.ts';
import { createPool } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { LookupsCache } from './services/lookups.ts';
import { PushService } from './services/push.ts';
import { QueueState } from './services/queue-state.ts';
import { SettingsCache } from './services/settings.ts';
import { WorkState } from './services/work-state.ts';

const config = loadConfig();
const distWeb = path.resolve(import.meta.dirname, '../../dist/web');
const staticRoot = config.NODE_ENV === 'production' && existsSync(distWeb) ? distWeb : undefined;

const pool = createPool(config.DATABASE_URL);

// Apply pending migrations before serving, so a `git push` deploy updates the database too.
// If a migration fails the process exits and Render keeps the previous version live.
try {
  await runMigrations(pool);
} catch (err) {
  console.error('Database migration failed; not starting:', (err as Error).message);
  process.exit(1);
}
const settings = new SettingsCache(pool);
const push = new PushService(pool, vapidFrom(config));
const app = createApp({
  staticRoot,
  deps: {
    pool,
    settings,
    sessions: new SessionStore(pool, settings),
    lookups: new LookupsCache(pool),
    queue: new QueueState(pool),
    work: new WorkState(),
    challenges: new PinChallengeStore(),
    push,
    pepper: parsePepper(config.PIN_PEPPER),
    secureCookies: config.NODE_ENV === 'production',
    trustProxy: config.TRUST_PROXY,
    // Password and recovery attempts per IP per 5 minutes (default 10).
    authLimiter: new SlidingWindowLimiter(config.AUTH_IP_LIMIT, 5 * 60_000),
  },
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`Server listening on port ${info.port} (${config.NODE_ENV}); web push ${push.enabled ? 'on' : 'off'}`);
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
