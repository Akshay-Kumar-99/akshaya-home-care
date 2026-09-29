import '@fontsource-variable/plus-jakarta-sans/wght.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { applyTheme, readTheme } from './lib/theme.ts';

// Apply the saved appearance before the first paint of the app.
applyTheme(readTheme());

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Missing #root element');

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker caches the app shell (instant start even while the free server wakes)
// and receives Work Inv push alerts. Production builds only.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // not fatal: the app works without it
    });
  });
}
