import type pg from 'pg';
import type { SlidingWindowLimiter } from '../auth/rate-limit.ts';
import type { SessionEntry, SessionStore } from '../auth/sessions.ts';
import type { SettingsCache } from '../services/settings.ts';
import type { Actor } from '../services/types.ts';

/** Everything a request handler needs, built once at startup (and by tests). */
export interface AppDeps {
  pool: pg.Pool;
  settings: SettingsCache;
  sessions: SessionStore;
  pepper: Uint8Array;
  /** true in production: Secure + __Host- cookies. */
  secureCookies: boolean;
  /** true behind Render's proxy: client IP comes from X-Forwarded-For. */
  trustProxy: boolean;
  /** Per-IP limiter for login and recovery attempts. */
  authLimiter: SlidingWindowLimiter;
}

export interface AuthState {
  entry: SessionEntry;
  actor: Actor;
  token: string;
}

export type AppEnv = {
  Variables: {
    deps: AppDeps;
    auth: AuthState;
  };
};
