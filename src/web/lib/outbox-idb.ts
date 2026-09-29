import { openDB, type IDBPDatabase } from 'idb';
import { api, ApiError } from './api.ts';
import { MemoryOutboxStore, Outbox, type OutboxItem, type OutboxStore, type SendOutcome, type SubmissionPayload } from './outbox.ts';

/** IndexedDB-backed outbox store: survives the app being closed or the phone restarting. */
class IdbOutboxStore implements OutboxStore {
  private readonly db: Promise<IDBPDatabase>;

  constructor() {
    this.db = openDB('akshaya-home-care', 1, {
      upgrade(db) {
        db.createObjectStore('outbox', { keyPath: 'key' });
      },
    });
  }

  async all(): Promise<OutboxItem[]> {
    return (await this.db).getAll('outbox');
  }
  async put(item: OutboxItem): Promise<void> {
    await (await this.db).put('outbox', item);
  }
  async remove(key: string): Promise<void> {
    await (await this.db).delete('outbox', key);
  }
}

async function sendSubmission(payload: SubmissionPayload): Promise<SendOutcome> {
  try {
    await api('/api/jobs', { method: 'POST', body: payload });
    return 'sent';
  } catch (err) {
    // 422: the server refused the content. Anything else (offline, cold start, 5xx, signed
    // out, PIN lock) is retried later without losing the job.
    if (err instanceof ApiError && err.status === 422) return 'rejected';
    return 'retry';
  }
}

function createStore(): OutboxStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IdbOutboxStore();
  } catch {
    // private mode or storage blocked
  }
  return new MemoryOutboxStore();
}

export const outbox = new Outbox(createStore(), sendSubmission);
