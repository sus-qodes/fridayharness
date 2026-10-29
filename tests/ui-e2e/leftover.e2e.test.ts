import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import type { UiLoginCode } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterAll, describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { closeBrowser, E2E, ensureBundle, launchBrowser, SHOTS } from './harness.js';

/**
 * Something served earlier on Friday's address (plan §5.1, §7.1, FD-04): another program on the
 * same port left a caching service worker and a cache entry in the browser. Neither runs in the
 * Friday page, and no login code is exchanged while a worker controls the page.
 */

const ws = useTestWorkspace();
afterAll(() => closeBrowser());

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

/** A worker that answers from its cache when it can, and from the network otherwise. */
const CACHING_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
`;

/** The other program's page: it registers the worker and caches a page of its own under /ui/. */
const OTHER_APP = `<!doctype html><title>Another app</title><script>
navigator.serviceWorker.register('/sw.js').then(async () => {
  await navigator.serviceWorker.ready;
  const cache = await caches.open('another-app');
  await cache.put('/ui/', new Response('<h1>PLANTED</h1>', { headers: { 'content-type': 'text/html' } }));
  document.title = 'planted';
});
</script>`;

interface PolicyAnswer {
  policy: { loosening_hash: string | null };
}

describe.skipIf(!E2E)('a leftover service worker on Friday’s address', () => {
  it('is removed before any sign-in, and a fresh link then signs in', async () => {
    const port = await freePort();
    const browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('pageerror', (e) => problems.push(e.message));

    // 1. Another program on this address leaves its worker and a cached page behind.
    const other = createHttpServer((req, res) => {
      if (req.url === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(CACHING_WORKER);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(OTHER_APP);
    });
    await new Promise<void>((resolve) => other.listen(port, '127.0.0.1', resolve));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => document.title === 'planted', null, { timeout: 15_000 });
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length))).toBe(1);
    await new Promise<void>((resolve) => other.close(() => resolve()));

    // 2. Friday starts on the same address: a fixed port, which applies once this clone trusts it.
    const editConfig = (y: string) => y.replace('  port: 0', `  port: ${port}`);
    const first = await startTestDaemon(ws(), { editConfig, git: true });
    const { policy } = await first.operator.get<PolicyAnswer>(first.operator.projectPath('/policy'));
    await first.operator.post(first.operator.projectPath('/policy/trust'), { loosening_hash: policy.loosening_hash });
    await first.daemon.close('restart');
    const td = await startTestDaemon(ws(), { editConfig, uiDir: ensureBundle() });
    expect(td.daemon.port()).toBe(port);

    // 3. The link opens under the leftover worker: the page removes it and exchanges no code.
    const sessions = async () =>
      (
        await td.operator.get<{ events: unknown[] }>(
          td.operator.projectPath('/events?type=ui.session_started&limit=10'),
        )
      ).events.length;
    const first_link = await td.operator.post<UiLoginCode>(td.operator.projectPath('/ui/login-codes'), {});
    await page.goto(first_link.url);
    await page
      .getByText('Friday removed a leftover service worker', { exact: false })
      .first()
      .waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${SHOTS}/leftover-worker.png` });
    expect(await page.getByText('PLANTED').count()).toBe(0);
    expect(await sessions()).toBe(0);
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), {
        timeout: 10_000,
      })
      .toBe(0);

    // 4. A fresh link signs in normally, with nothing between the page and Friday.
    const second_link = await td.operator.post<UiLoginCode>(td.operator.projectPath('/ui/login-codes'), {});
    await page.goto(second_link.url);
    // Only the fragment differs from the first link, so the page starts over by itself (LESSONS UI-49).
    await page.getByText('test-project', { exact: false }).first().waitFor({ timeout: 15_000 });
    expect(await page.evaluate(() => navigator.serviceWorker.controller === null)).toBe(true);
    expect(await sessions()).toBe(1);
    expect(problems).toEqual([]);
    await context.close();
  });
});
