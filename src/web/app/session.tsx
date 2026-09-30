import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SessionInfo } from '../../shared/api-types.ts';
import { api, isNetworkError, onAuthEvent } from '../lib/api.ts';
import { clearWorkCache } from './work.tsx';

// App session state machine. The server is the source of truth: the idle PIN lock and the
// first-login change are enforced there, and surface here through API responses.

export type Phase =
  | { kind: 'booting'; waking: boolean }
  | { kind: 'unreachable' }
  | { kind: 'anonymous' }
  | { kind: 'must_change'; info: SessionInfo }
  | { kind: 'locked'; info: SessionInfo }
  | { kind: 'ready'; info: SessionInfo; offline: boolean };

interface SessionApi {
  phase: Phase;
  refresh: () => Promise<void>;
  setInfo: (info: SessionInfo) => void;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

const SessionContext = createContext<SessionApi | null>(null);

// Only non-secret display data is cached, so a technician can queue jobs while offline.
const CACHE_KEY = 'ahc.session.v1';

function readCache(): SessionInfo | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as SessionInfo) : null;
  } catch {
    return null;
  }
}

function writeCache(info: SessionInfo | null): void {
  try {
    if (info) localStorage.setItem(CACHE_KEY, JSON.stringify(info));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // storage unavailable: offline mode simply won't be offered
  }
}

function phaseFor(info: SessionInfo): Phase {
  if (info.mustChange) return { kind: 'must_change', info };
  if (info.locked) return { kind: 'locked', info };
  return { kind: 'ready', info, offline: false };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'booting', waking: false });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const apply = useCallback((res: SessionInfo | { authenticated: false }) => {
    if (!res.authenticated) {
      writeCache(null);
      setPhase({ kind: 'anonymous' });
      return;
    }
    writeCache(res);
    setPhase(phaseFor(res));
  }, []);

  const refresh = useCallback(async () => {
    const wakeTimer = window.setTimeout(() => {
      if (phaseRef.current.kind === 'booting') setPhase({ kind: 'booting', waking: true });
    }, 2500);
    try {
      apply(await api<SessionInfo | { authenticated: false }>('/api/auth/session'));
    } catch (err) {
      const cached = readCache();
      if (isNetworkError(err) && cached && cached.user.role === 'technician') {
        setPhase({ kind: 'ready', info: cached, offline: true });
      } else if (isNetworkError(err)) {
        setPhase({ kind: 'unreachable' });
      } else {
        setPhase({ kind: 'anonymous' });
      }
    } finally {
      window.clearTimeout(wakeTimer);
    }
  }, [apply]);

  useEffect(() => {
    void refresh();
    const off = onAuthEvent((event) => {
      const current = phaseRef.current;
      if (event === 'unauthenticated') {
        writeCache(null);
        setPhase({ kind: 'anonymous' });
      } else if (event === 'pin_required' && 'info' in current) {
        setPhase({ kind: 'locked', info: current.info });
      } else if (event === 'must_change') {
        void refresh();
      }
    });
    const online = () => {
      if (phaseRef.current.kind === 'ready' && phaseRef.current.offline) void refresh();
      if (phaseRef.current.kind === 'unreachable') void refresh();
    };
    window.addEventListener('online', online);
    return () => {
      off();
      window.removeEventListener('online', online);
    };
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    writeCache(null);
    clearWorkCache();
    setPhase({ kind: 'anonymous' });
  }, []);

  const value = useMemo<SessionApi>(
    () => ({
      phase,
      refresh,
      setInfo: (info) => apply(info),
      logout,
      can: (permission) => ('info' in phase ? phase.info.permissions.includes(permission) : false),
    }),
    [phase, refresh, apply, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

/** The signed-in user's info; only valid inside the app shells. */
export function useUser(): SessionInfo {
  const { phase } = useSession();
  if (!('info' in phase)) throw new Error('no signed-in user');
  return phase.info;
}
