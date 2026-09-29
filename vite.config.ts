import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The SPA lives in src/web and builds to dist/web, which the Hono server serves in production.
// In development Vite serves the SPA and proxies /api to the Node server on port 3000.
export default defineConfig({
  root: 'src/web',
  plugins: [
    react(),
    VitePWA({
      // Our own service worker (src/web/sw.ts): precache + Work Inv push handler.
      strategies: 'injectManifest',
      srcDir: '.',
      filename: 'sw.ts',
      injectRegister: false,
      manifest: {
        name: 'Akshaya Home Care',
        short_name: 'Akshaya',
        description: 'Jobs and invoices for Akshaya Home Care',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest,woff2}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: false,
    // Used by scripts/check-bundle.ts to enforce the technician route's JS budget.
    manifest: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Keep the browser's Host (localhost:5173) so the API's same-origin check sees
      // Origin and Host match. Without this, every sign-in in dev is refused as "bad_origin".
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
