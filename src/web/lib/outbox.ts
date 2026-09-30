// Offline outbox for technician submissions. A job is written to the phone first, shown as
// "Not yet on server", and sent (and re-sent) until the server confirms it. The client-made
// idempotency key means a retry after a lost response never creates a second record.
// Completing an assigned work order goes through the same outbox (with `workJobId`).

export interface SubmissionPayload {
  idempotencyKey: string;
  phone: string;
  customerName: string;
  areaId: string | null;
  applianceTypeKey: string;
  brandId: string | null;
  serviceDescription: string;
  totalRupees: number;
  spareCostRupees: number;
  confirmNegativeMargin: boolean;
  payment: { status: 'paid'; mode: 'cash' | 'upi' | 'other' } | { status: 'unpaid' };
  /** Warranty service: the invoice whose warranty covers this visit. */
  warrantyOfInvoiceId?: string | null;
}

export interface OutboxItem {
  key: string;
  /** Only the user who created an item may send it (shared phones). */
  userId: string;
  payload: SubmissionPayload;
  /** Set when this completes an assigned work order (Works assigned) instead of a walk-in job. */
  workJobId?: string;
  /** Display-only snapshot so the list can show it while offline. */
  summary: { customerName: string; applianceLabel: string; totalRupees: number; spareCostRupees: number };
  createdAt: number;
  attempts: number;
  /** "failed": the server refused it (validation) and it needs fixing or discarding. */
  status: 'pending' | 'failed';
  lastError: string | null;
}

export interface OutboxStore {
  all(): Promise<OutboxItem[]>;
  put(item: OutboxItem): Promise<void>;
  remove(key: string): Promise<void>;
}

/** What sending one item produced. */
export type SendOutcome = 'sent' | 'rejected' | 'retry';

export type Sender = (payload: SubmissionPayload, workJobId?: string) => Promise<SendOutcome>;

export class Outbox {
  private readonly store: OutboxStore;
  private readonly send: Sender;
  private readonly listeners = new Set<() => void>();
  private flushing: Promise<void> | null = null;

  constructor(store: OutboxStore, send: Sender) {
    this.store = store;
    this.send = send;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.listeners.forEach((l) => l());
  }

  async items(userId: string): Promise<OutboxItem[]> {
    const all = await this.store.all();
    return all.filter((i) => i.userId === userId).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Saves the job on the device, then tries to send it right away. */
  async add(item: Omit<OutboxItem, 'attempts' | 'status' | 'lastError' | 'createdAt'>): Promise<SendOutcome> {
    await this.store.put({ ...item, createdAt: Date.now(), attempts: 0, status: 'pending', lastError: null });
    this.changed();
    await this.flush(item.userId);
    const left = (await this.store.all()).find((i) => i.key === item.key);
    return !left ? 'sent' : left.status === 'failed' ? 'rejected' : 'retry';
  }

  async discard(key: string): Promise<void> {
    await this.store.remove(key);
    this.changed();
  }

  /** Sends this user's pending items oldest first; stops at the first network failure. */
  flush(userId: string): Promise<void> {
    this.flushing ??= this.doFlush(userId).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(userId: string): Promise<void> {
    for (const item of await this.items(userId)) {
      if (item.status !== 'pending') continue;
      let outcome: SendOutcome;
      try {
        outcome = await this.send(item.payload, item.workJobId);
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'sent') {
        await this.store.remove(item.key);
      } else if (outcome === 'rejected') {
        await this.store.put({ ...item, status: 'failed', attempts: item.attempts + 1, lastError: 'rejected' });
      } else {
        await this.store.put({ ...item, attempts: item.attempts + 1 });
        this.changed();
        return;
      }
      this.changed();
    }
  }
}

/** In-memory store (tests, and a fallback when IndexedDB is unavailable). */
export class MemoryOutboxStore implements OutboxStore {
  private readonly map = new Map<string, OutboxItem>();
  async all(): Promise<OutboxItem[]> {
    return [...this.map.values()].map((i) => structuredClone(i));
  }
  async put(item: OutboxItem): Promise<void> {
    this.map.set(item.key, structuredClone(item));
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
