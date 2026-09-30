import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkOrder, WorkVersion } from '../../shared/api-types.ts';
import { api, isNetworkError } from '../lib/api.ts';

// Works assigned, for "Invoice + Work allocation" technicians. One 30-second badge poll per
// session (paused while the app is hidden) asks the server whether the list changed; the
// server answers from memory, so an idle phone never wakes the database. The last list is
// kept on the phone so jobs can be opened and completed offline (completion uses the outbox).

const POLL_MS = 30_000;
/** A failed reload (weak signal, server hiccup) is tried again this much later. */
const RETRY_MS = 4_000;
const cacheKey = (userId: string) => `ahc.work.v1.${userId}`;

interface WorkApi {
  items: WorkOrder[] | null;
  /** Jobs still to do (assigned or in progress): the tab badge. */
  openCount: number;
  /** true while showing the copy saved on the phone because the server can't be reached. */
  fromCache: boolean;
  reload: () => Promise<void>;
  /** Shows a change on screen at once (e.g. after Start job), before the next reload. */
  update: (id: string, changes: Partial<WorkOrder>) => void;
}

const WorkContext = createContext<WorkApi | null>(null);

function readCache(userId: string): WorkOrder[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(userId));
    return raw ? (JSON.parse(raw) as WorkOrder[]) : null;
  } catch {
    return null;
  }
}

function writeCache(userId: string, items: WorkOrder[]): void {
  try {
    localStorage.setItem(cacheKey(userId), JSON.stringify(items));
  } catch {
    // storage unavailable: offline viewing simply isn't offered
  }
}

/** Drops every saved Works assigned list (on sign-out: shared phones). */
export function clearWorkCache(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('ahc.work.')) localStorage.removeItem(key);
  } catch {
    // nothing saved
  }
}

export function isOpenWork(w: WorkOrder): boolean {
  return w.status === 'assigned' || w.status === 'in_progress';
}

export function WorkProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const [items, setItems] = useState<WorkOrder[] | null>(() => readCache(userId));
  const [fromCache, setFromCache] = useState(false);
  const version = useRef<number | null>(null);
  // Only the newest reload may update the list: a slow, older reply must not overwrite it.
  const latest = useRef(0);
  const retry = useRef<number | undefined>(undefined);

  const reload = useCallback(async () => {
    const seq = ++latest.current;
    window.clearTimeout(retry.current);
    try {
      const res = await api<{ items: WorkOrder[] }>('/api/work/mine', { background: true });
      if (seq !== latest.current) return;
      setItems(res.items);
      setFromCache(false);
      writeCache(userId, res.items);
    } catch (err) {
      if (seq !== latest.current) return;
      if (isNetworkError(err)) setFromCache(true);
      retry.current = window.setTimeout(() => void reload(), RETRY_MS);
    }
  }, [userId]);

  useEffect(() => () => window.clearTimeout(retry.current), []);

  const update = useCallback((id: string, changes: Partial<WorkOrder>) => {
    setItems((list) => list?.map((w) => (w.id === id ? { ...w, ...changes } : w)) ?? list);
  }, []);

  const poll = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    api<WorkVersion>('/api/work/mine/version', { background: true })
      .then((next) => {
        if (next.version !== version.current) {
          version.current = next.version;
          void reload();
        }
      })
      .catch((err) => {
        if (isNetworkError(err)) setFromCache(true);
      });
  }, [reload]);

  useEffect(() => {
    poll();
    const id = window.setInterval(poll, POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && poll();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', poll);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', poll);
    };
  }, [poll]);

  const openCount = items ? items.filter(isOpenWork).length : 0;
  return <WorkContext.Provider value={{ items, openCount, fromCache, reload, update }}>{children}</WorkContext.Provider>;
}

export function useWork(): WorkApi {
  const ctx = useContext(WorkContext);
  if (!ctx) throw new Error('useWork outside WorkProvider');
  return ctx;
}
