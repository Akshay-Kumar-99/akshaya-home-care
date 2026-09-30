import { createHash, randomBytes } from 'node:crypto';
import type { SessionKind } from './sessions.ts';

/** How long the PIN page stays valid after a correct password. */
export const PIN_CHALLENGE_TTL_MS = 5 * 60_000;
/** Wrong PINs allowed on one challenge before the user must start again with the password. */
export const PIN_CHALLENGE_MAX_ATTEMPTS = 5;

export interface PinChallenge {
  userId: string;
  usernameKey: string;
  displayName: string;
  kind: SessionKind;
  ip: string | null;
  userAgent: string | null;
  deviceLabel: string | null;
  expiresAt: number;
  attempts: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Two-step sign-in for office roles (owner decision, Sep 2026): after a correct password the
 * server issues a short-lived challenge (random token in an HttpOnly cookie, stored here only
 * as a hash) and the PIN page answers it. In memory is correct on Render Free's single
 * instance; a restart simply means signing in again. Wrong PINs also count toward the
 * per-account lockout in login_attempts.
 */
export class PinChallengeStore {
  private readonly byHash = new Map<string, PinChallenge>();

  create(data: Omit<PinChallenge, 'expiresAt' | 'attempts'>): string {
    this.sweep();
    const token = randomBytes(32).toString('base64url');
    this.byHash.set(hash(token), { ...data, expiresAt: Date.now() + PIN_CHALLENGE_TTL_MS, attempts: 0 });
    return token;
  }

  get(token: string | undefined): PinChallenge | null {
    if (!token) return null;
    const key = hash(token);
    const challenge = this.byHash.get(key);
    if (!challenge) return null;
    if (challenge.expiresAt <= Date.now()) {
      this.byHash.delete(key);
      return null;
    }
    return challenge;
  }

  /** Counts a wrong PIN; returns how many attempts remain (0 = challenge discarded). */
  fail(token: string): number {
    const key = hash(token);
    const challenge = this.byHash.get(key);
    if (!challenge) return 0;
    challenge.attempts += 1;
    const remaining = PIN_CHALLENGE_MAX_ATTEMPTS - challenge.attempts;
    if (remaining <= 0) this.byHash.delete(key);
    return Math.max(0, remaining);
  }

  delete(token: string): void {
    this.byHash.delete(hash(token));
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, c] of this.byHash) if (c.expiresAt <= now) this.byHash.delete(key);
  }
}
