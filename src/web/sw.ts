/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

// Service worker: precaches the built app shell (so the UI opens instantly, even while the
// free-tier server is waking), serves index.html for in-app navigations, and shows Work Inv
// push alerts. API calls are never cached: the server is the source of truth.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

void self.skipWaiting();
clientsClaim();

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//] }));

interface PushPayload {
  title?: string;
  body?: string;
  url?: string;
}

// The payload never carries customer data: "New invoice waiting".
self.addEventListener('push', (event) => {
  let payload: PushPayload = {};
  try {
    payload = (event.data?.json() as PushPayload) ?? {};
  } catch {
    payload = {};
  }
  const options: NotificationOptions & { renotify?: boolean } = {
    body: payload.body ?? 'New invoice waiting',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'new-invoice',
    renotify: true,
    data: { url: payload.url ?? '/work-inv' },
  };
  event.waitUntil(self.registration.showNotification(payload.title ?? 'Akshaya Home Care', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | null)?.url ?? '/work-inv';
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (existing) {
        await existing.focus();
        await existing.navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
