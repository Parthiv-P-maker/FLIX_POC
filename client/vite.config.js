import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Three pages, not one. share.html and reset.html are opened by people who
 * may have no session at all, and their URLs are baked into share links and
 * reset emails the server has already sent - so they stay separate entries
 * at the same paths.
 *
 * In dev, /api goes to the Express server so the client runs same-origin,
 * exactly as it does in production where Express serves dist/.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:5000', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        share: resolve(import.meta.dirname, 'share.html'),
        reset: resolve(import.meta.dirname, 'reset.html'),
      },
    },
  },
});
