import { api } from './api.ts';

// Web Push opt-in for the checker's phone. Android Chrome first; iOS only works for the
// installed (Home Screen) app on iOS 16.4+. The payload never contains customer data.

export type PushState = 'unsupported' | 'disabled' | 'blocked' | 'off' | 'on';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const config = await api<{ enabled: boolean }>('/api/push/config', { background: true });
  if (!config.enabled) return 'disabled';
  if (Notification.permission === 'denied') return 'blocked';
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? 'on' : 'off';
}

/** Must be called from a tap (browsers require a user gesture for the permission prompt). */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported';
  const config = await api<{ enabled: boolean; publicKey: string | null }>('/api/push/config');
  if (!config.enabled || !config.publicKey) return 'disabled';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'blocked' : 'off';
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    }));
  await api('/api/push/subscribe', { method: 'POST', body: subscription.toJSON() });
  return 'on';
}
