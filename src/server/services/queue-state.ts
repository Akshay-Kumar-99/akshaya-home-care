import type pg from 'pg';

export interface QueueSnapshot {
  /** Increments on every change to the Work Inv queue (submit, edit, copy, reject, requeue, void). */
  version: number;
  pendingCount: number;
  /** Oldest pending item's submission time, for the "overdue in queue" alert. */
  oldestPendingAt: string | null;
}

/**
 * In-process view of the Work Inv queue for the 30-second badge poll.
 *
 * Every queue mutation goes through this server (single Render instance) and calls
 * `changed()`. Polls between changes are answered from memory with no database query,
 * so an open panel does not keep Neon awake. After a change (or a restart) the next poll
 * recounts once.
 */
export class QueueState {
  private version = 1;
  private cached: { pendingCount: number; oldestPendingAt: string | null } | null = null;
  private generation = 0;
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  changed(): void {
    this.version += 1;
    this.generation += 1;
    this.cached = null;
  }

  async snapshot(): Promise<QueueSnapshot> {
    if (!this.cached) {
      const generation = this.generation;
      const res = await this.pool.query<{ n: number; oldest: Date | null }>(
        `SELECT count(*)::int AS n, min(submitted_at) AS oldest
         FROM invoices
         WHERE state = 'submitted' OR (state = 'issued' AND requeued_at IS NOT NULL)`,
      );
      const loaded = {
        pendingCount: res.rows[0]!.n,
        oldestPendingAt: res.rows[0]!.oldest?.toISOString() ?? null,
      };
      // Only cache if nothing changed while we were counting.
      if (generation === this.generation) this.cached = loaded;
      return { version: this.version, ...loaded };
    }
    return { version: this.version, ...this.cached };
  }
}
