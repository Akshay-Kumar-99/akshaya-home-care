/**
 * In-memory sliding-window limiter. Render Free runs a single instance, so process memory
 * is a correct place for per-IP counters. It resets on restart, and the per-account
 * progressive lockout (stored in login_attempts) is the durable control.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Records a hit for `key`. Returns whether it is allowed and, if not, when to retry. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterSec: number } {
    this.sweep(now);
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const retryAfterMs = recent[0]! + this.windowMs - now;
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSec: 0 };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, times] of this.hits) {
      if (times.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }
}
