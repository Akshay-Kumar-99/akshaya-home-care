import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { QueueVersion } from '../../shared/api-types.ts';
import { api } from '../lib/api.ts';

// One poll per checker session: the Work Inv badge, the overdue banner and list refreshes
// all hang off it. Every 30 s while the page is visible, paused when hidden (Page Visibility),
// immediately on returning to the app. Sent as a background request: the server answers
// from memory and it does not count as user activity (the idle PIN lock still applies).

const POLL_MS = 30_000;
const SOUND_KEY = 'ahc.sound';

interface QueueApi {
  snapshot: QueueVersion | null;
  /** Force an immediate poll (after this user changed the queue). */
  poll: () => void;
  sound: boolean;
  setSound: (on: boolean) => void;
}

const QueueContext = createContext<QueueApi | null>(null);

function beep(): void {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    // audio unavailable
  }
}

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === 'on';
  } catch {
    return false;
  }
}

export function QueueProvider({ children }: { children: ReactNode }) {
  const [snapshot, setSnapshot] = useState<QueueVersion | null>(null);
  const [sound, setSoundState] = useState(readSound);
  const lastCount = useRef<number | null>(null);
  const soundRef = useRef(sound);
  soundRef.current = sound;

  const poll = useCallback(() => {
    if (document.visibilityState !== 'visible') return;
    api<QueueVersion>('/api/workinv/version', { background: true })
      .then((next) => {
        if (soundRef.current && lastCount.current !== null && next.pendingCount > lastCount.current) beep();
        lastCount.current = next.pendingCount;
        setSnapshot((prev) => (prev && prev.version === next.version && prev.pendingCount === next.pendingCount ? prev : next));
      })
      .catch(() => {
        // offline or signed out: the next poll or the auth handler deals with it
      });
  }, []);

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

  const setSound = useCallback((on: boolean) => {
    setSoundState(on);
    try {
      localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      // not persisted
    }
    if (on) beep();
  }, []);

  return <QueueContext.Provider value={{ snapshot, poll, sound, setSound }}>{children}</QueueContext.Provider>;
}

export function useQueue(): QueueApi {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useQueue outside QueueProvider');
  return ctx;
}

/** True when the oldest pending item is older than the configured alert hours. */
export function isOverdue(snapshot: QueueVersion | null, now = Date.now()): boolean {
  if (!snapshot?.oldestPendingAt || snapshot.pendingCount === 0) return false;
  return now - Date.parse(snapshot.oldestPendingAt) > snapshot.queueAlertHours * 3_600_000;
}
