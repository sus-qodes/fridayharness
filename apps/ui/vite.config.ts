import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
/** The daemon the dev server proxies to (`friday status` prints its URL). */
const daemon = process.env.FRIDAY_DAEMON_URL ?? 'http://127.0.0.1:4310';

// The daemon accepts only its own Host and Origin (plan §2): the dev proxy rewrites both.
const toDaemon = {
  target: daemon,
  changeOrigin: true,
  configure: (proxy: {
    on: (event: 'proxyReq', fn: (req: { setHeader: (k: string, v: string) => void }) => void) => void;
  }) => {
    proxy.on('proxyReq', (req) => req.setHeader('origin', daemon));
  },
};

export default defineConfig({
  root,
  // Relative asset URLs work under the daemon's /ui/ and under the desktop shell's own origin (FD-03).
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    // No inline script: the CSP allows scripts from the bundle's own files only.
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    rollupOptions: { input: { index: `${root}index.html`, notch: `${root}notch.html` } },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': toDaemon, '/ui/session': toDaemon },
  },
});
