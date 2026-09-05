import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * One id per build, stamped into the bundle AND written beside it as
 * `dist/build-id.txt`.
 *
 * `npm run build` overwrites `ui/dist` under a console that is already running,
 * so the browser can end up loading a NEW page that talks to an OLD API. Nothing
 * errors — the buttons just quietly stop working, which is what happened to the
 * operator's Approve button. The page knows the id it was built with, the server
 * reports the id it started with, and a mismatch becomes a banner that says
 * reload instead of a dead button.
 *
 * It is a timestamp rather than a hash so the page can say which side is older.
 */
const buildId = new Date().toISOString();

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'worker-console-build-id',
      closeBundle() {
        writeFileSync(fileURLToPath(new URL('./dist/build-id.txt', import.meta.url)), `${buildId}\n`);
      },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(buildId) },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4400' },
  },
});
