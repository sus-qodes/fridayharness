import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { fakeBundle, raw } from '../helpers/ui.js';

/** Serving the interface's bundle (docs/frontend/PLAN.md §5.1, FD-04). */

const ws = useTestWorkspace();

describe('serving the bundle', () => {
  it('serves it under a per-start path, never cached, with strict headers', async () => {
    const td = await startTestDaemon(ws(), { uiDir: fakeBundle(ws()) });
    const root = await raw(td, 'GET', '/ui');
    expect(root.status).toBe(302);
    const base = root.headers.get('location') ?? '';
    expect(base).toMatch(/^\/ui\/[A-Za-z0-9_-]{22}\/$/);
    expect(root.headers.get('cache-control')).toBe('no-store');
    // Every other /ui path (an old link, a guess) goes to the current one.
    for (const other of ['/ui/', '/ui/abc/', '/ui/assets/index-abc123.js']) {
      const r = await raw(td, 'GET', other);
      expect(r.status, other).toBe(302);
      expect(r.headers.get('location')).toBe(base);
    }
    const index = await raw(td, 'GET', base);
    expect(index.status).toBe(200);
    expect(index.text).toContain('Friday Studio');
    const csp = index.headers.get('content-security-policy') ?? '';
    for (const directive of [
      "script-src 'self'",
      "frame-ancestors 'none'",
      "require-trusted-types-for 'script'",
      "object-src 'none'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(index.headers.get('x-frame-options')).toBe('DENY');
    expect(index.headers.get('cache-control')).toBe('no-store');
    const asset = await raw(td, 'GET', `${base}assets/index-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
    // Nothing is cached, assets included: a planted entry could otherwise be served for them.
    expect(asset.headers.get('cache-control')).toBe('no-store');
    for (const bad of ['../package.json', '%2e%2e/x.js', 'assets\\x.js', 'missing.js', 'a.exe', '.hidden.js']) {
      const r = await raw(td, 'GET', `${base}${bad}`);
      expect(r.status, bad).not.toBe(200);
    }
  });

  it('starts a new path at every start', async () => {
    const dir = fakeBundle(ws());
    const a = await startTestDaemon(ws(), { uiDir: dir });
    const first = (await raw(a, 'GET', '/ui')).headers.get('location');
    await a.daemon.close('test');
    const b = await startTestDaemon(ws(), { uiDir: dir });
    const second = (await raw(b, 'GET', '/ui')).headers.get('location');
    expect(second).not.toBe(first);
  });

  it('refuses a link inside the bundle that points outside it', async () => {
    const dir = fakeBundle(ws());
    const outside = path.join(ws().root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.js'), 'secret');
    symlinkSync(outside, path.join(dir, 'linked'), 'junction');
    const td = await startTestDaemon(ws(), { uiDir: dir });
    const base = (await raw(td, 'GET', '/ui')).headers.get('location') ?? '';
    const r = await raw(td, 'GET', `${base}linked/secret.js`);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('secret');
  });

  it('answers a request for a service-worker script, on any path, with a worker that removes itself', async () => {
    const td = await startTestDaemon(ws(), { uiDir: fakeBundle(ws()) });
    for (const p of ['/sw.js', '/ui/sw.js', `/api/v1/projects/${td.project.project_id}/x.js`]) {
      const r = await raw(td, 'GET', p, { headers: { 'service-worker': 'script' } });
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/javascript');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.text).toContain('registration');
      expect(r.text).toContain('unregister()');
    }
  });

  it('keeps the legacy status page without a bundle', async () => {
    const td = await startTestDaemon(ws());
    const r = await raw(td, 'GET', '/ui');
    expect(r.status).toBe(200);
    expect(r.text).toContain('Friday status');
  });
});
