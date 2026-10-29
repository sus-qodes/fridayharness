import { randomBytes } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Context, Env, Hono } from 'hono';

/**
 * Serves the interface's built bundle under `/ui/<nonce>/` (plan M9, `docs/frontend/PLAN.md` §5.1):
 * public routes registered before authentication, only regular files inside the real bundle folder,
 * strict security headers, nothing cached. The nonce is random per daemon start: the address
 * `http://127.0.0.1:<port>` may have been served earlier by another program that left cache
 * entries behind, and those can never match a path that did not exist then (LESSONS UI-24).
 * Without a bundle, `/ui` keeps serving the legacy status page.
 */

/** Headers on every bundle response (plan §5.1). No inline script or style, no framing. */
export const UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.wav': 'audio/wav',
};

/** Paths the bundle may hold: plain names, folders, dots inside names; never `..`, `\`, `%` or NUL. */
const SAFE_PATH = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface UiBundle {
  /** The bundle folder's real path. */
  root: string;
  /** Random per daemon start; the bundle is served under `/ui/<nonce>/`. */
  nonce: string;
}

/** The path the bundle is served under. */
export const uiPath = (bundle: UiBundle) => `/ui/${bundle.nonce}/`;

/** The bundle at `dir`, if it holds an `index.html`. */
export function openUiBundle(dir: string | undefined): UiBundle | undefined {
  if (!dir) return undefined;
  try {
    const root = realpathSync(dir);
    if (!statSync(path.join(root, 'index.html')).isFile()) return undefined;
    return { root, nonce: randomBytes(16).toString('base64url') };
  } catch {
    return undefined;
  }
}

/**
 * A service worker that removes itself and reloads the pages it controlled: the answer to any
 * request for a worker script, so a worker an earlier program registered for this address dies at
 * its next update check (LESSONS UI-24).
 */
export const SELF_REMOVING_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration
      .unregister()
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((client) => client.navigate(client.url))),
  );
});
`;

function withHeaders(c: Context, extra: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries({ ...UI_SECURITY_HEADERS, ...extra })) c.header(k, v);
}

/** Reads a file of the bundle, or undefined when the request names nothing servable. */
export function readBundleFile(bundle: UiBundle, rel: string): { body: Buffer; type: string } | undefined {
  if (!SAFE_PATH.test(rel) || rel.split('/').some((seg) => seg === '.' || seg === '..')) return undefined;
  const type = CONTENT_TYPES[path.extname(rel).toLowerCase()];
  if (!type) return undefined;
  const full = path.join(bundle.root, ...rel.split('/'));
  try {
    // A link inside the bundle could point anywhere: only regular files whose real path stays inside.
    if (!lstatSync(full).isFile()) return undefined;
    const real = realpathSync(full);
    if (!real.startsWith(bundle.root + path.sep)) return undefined;
    const st = statSync(real);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return undefined;
    return { body: readFileSync(real), type };
  } catch {
    return undefined;
  }
}

/**
 * Mounts `/ui`, `/ui/` and `/ui/<file>`. Call before the bearer middleware: the bundle holds no
 * secret (plan §9), and the data it shows needs a UI session.
 */
export function mountUiStatic<E extends Env>(
  app: Hono<E>,
  bundle: UiBundle | undefined,
  legacyHtml: () => string,
): void {
  // Any request for a service-worker script, on any path, before authentication.
  app.use('*', async (c, next) => {
    if (c.req.header('service-worker') !== 'script') return next();
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(SELF_REMOVING_WORKER, 200);
  });
  if (!bundle) {
    app.get('/ui', (c) => c.html(legacyHtml()));
    return;
  }
  const base = uiPath(bundle);
  const home = (c: Context) => {
    c.header('cache-control', 'no-store');
    return c.redirect(base, 302);
  };
  app.get('/sounds/*', (c) => {
    const raw = new URL(c.req.url).pathname;
    const rest = raw.replace(/^\/sounds\//, '');
    const file = readBundleFile(bundle, `sounds/${rest}`);
    if (!file) {
      withHeaders(c, { 'cache-control': 'no-store' });
      return c.text('not found', 404);
    }
    withHeaders(c, { 'content-type': file.type, 'cache-control': 'no-store' });
    return c.body(new Uint8Array(file.body), 200);
  });
  app.get('/ui', home);
  app.get('/ui/*', (c) => {
    const raw = new URL(c.req.url).pathname;
    // Another nonce (a link from before a restart) or none: the bundle's current path.
    if (!raw.startsWith(base)) return home(c);
    const rest = raw.slice(base.length);
    const rel = rest === '' ? 'index.html' : rest;
    const file = readBundleFile(bundle, rel);
    if (!file) {
      withHeaders(c, { 'cache-control': 'no-store' });
      return c.text('not found', 404);
    }
    withHeaders(c, { 'content-type': file.type, 'cache-control': 'no-store' });
    return c.body(new Uint8Array(file.body), 200);
  });
}
