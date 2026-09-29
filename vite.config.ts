import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The SPA lives in src/web and builds to dist/web, which the Hono server serves in production.
// In development Vite serves the SPA and proxies /api to the Node server on port 3000.
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
