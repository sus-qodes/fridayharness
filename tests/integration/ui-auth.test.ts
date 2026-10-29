import { existsSync, readFileSync } from 'node:fs';
import { UI_SESSION_MAX_AGE_MS } from '@friday/daemon';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { codeOf, fakeBundle, mintCode, raw, signIn } from '../helpers/ui.js';

/** Browser sign-in and the UI session (docs/frontend/PLAN.md §5.2, FD-05). */

const ws = useTestWorkspace();

/** Opens the event stream with a token; resolves when it ends, with what it received. */
function openStream(td: TestDaemon, token: string) {
  const ctrl = new AbortController();
  const done = (async () => {
    const res = await fetch(`${td.url}${td.operator.projectPath('/events/stream?since=0')}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: ctrl.signal,
    });
    const reader = res.body?.getReader();
    let text = '';
    if (!reader) return text;
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      text += new TextDecoder().decode(value);
    }
    return text;
  })();
  return { done, abort: () => ctrl.abort() };
}

describe('the one-time link', () => {
  it('reaches the browser through a user-only redirect file, deleted once the code is used', async () => {
    const td = await startTestDaemon(ws(), { uiDir: fakeBundle(ws()) });
    const { code, login } = await mintCode(td);
    const base = (await raw(td, 'GET', '/ui')).headers.get('location');
    expect(login.url).toBe(`${td.url}${base}#code=${code}`);
    expect(login.redirect_file).toBeTruthy();
    const file = login.redirect_file as string;
    expect(file.startsWith(ws().stateDir)).toBe(true);
    const html = readFileSync(file, 'utf8');
    expect(html).toContain(`<meta http-equiv="refresh" content="0;url=${login.url}">`);
    expect(html).not.toMatch(/<script/i);
    const r = await raw(td, 'POST', '/ui/session', { origin: td.url, body: JSON.stringify({ code }) });
    expect(r.status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });

  it('deletes the redirect file when the code expires unused', async () => {
    const clock = new FakeClock('2026-10-17T10:00:00.000Z');
    const td = await startTestDaemon(ws(), { clock });
    const { login } = await mintCode(td);
    expect(existsSync(login.redirect_file as string)).toBe(true);
    clock.advance(61_000);
    await mintCode(td);
    expect(existsSync(login.redirect_file as string)).toBe(false);
  });

  it('accepts a code once, from the daemon origin, as JSON only', async () => {
    const td = await startTestDaemon(ws());
    const { code } = await mintCode(td);
    const body = JSON.stringify({ code });
    expect((await raw(td, 'POST', '/ui/session', { body })).status).toBe(403);
    expect((await raw(td, 'POST', '/ui/session', { origin: 'http://127.0.0.1:1', body })).status).toBe(403);
    expect((await raw(td, 'POST', '/ui/session', { origin: td.url, body, type: 'text/plain' })).status).toBe(400);
    expect((await raw(td, 'POST', '/ui/session', { origin: td.url, body })).status).toBe(200);
    const again = await raw(td, 'POST', '/ui/session', { origin: td.url, body });
    expect(again.status).toBe(401);
    const unknown = await raw(td, 'POST', '/ui/session', {
      origin: td.url,
      body: JSON.stringify({ code: 'x'.repeat(43) }),
    });
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual(again.json);
  });

  it('lets only the operator token mint codes', async () => {
    const td = await startTestDaemon(ws());
    const token = await signIn(td);
    expect((await raw(td, 'POST', td.operator.projectPath('/ui/login-codes'), { token, body: '{}' })).status).toBe(403);
    const fromBootstrap = await raw(td, 'POST', td.operator.projectPath('/ui/login-codes'), {
      token: td.daemon.tokens.bootstrap,
      body: '{}',
    });
    expect(fromBootstrap.status).toBe(403);
  });
});

describe('the UI session', () => {
  it('reads the board, and no API answer may be cached', async () => {
    const td = await startTestDaemon(ws());
    const token = await signIn(td);
    expect(token).not.toBe(td.daemon.tokens.operator);
    const snap = await raw(td, 'GET', td.operator.projectPath('/ui/snapshot'), { token });
    expect(snap.status, snap.text).toBe(200);
    expect(snap.headers.get('cache-control')).toBe('no-store');
    const tasks = await raw(td, 'GET', td.operator.projectPath('/tasks'), { token });
    expect(tasks.headers.get('cache-control')).toBe('no-store');
  });

  it('cannot reach admin, protocol or session-binding routes', async () => {
    const td = await startTestDaemon(ws());
    const token = await signIn(td);
    for (const [method, p] of [
      ['POST', '/admin/backup'],
      ['POST', '/admin/shutdown'],
      ['POST', '/admin/rotate-tokens'],
      ['POST', td.operator.projectPath('/harness-sessions/bind')],
    ] as const) {
      const r = await raw(td, method, p, { token, body: '{}' });
      expect(r.status, p).toBe(403);
      expect(codeOf(r), p).toBe('COS-3006');
    }
    // The operator token itself still can (the CLI).
    expect(
      (await raw(td, 'POST', '/admin/rotate-tokens', { token: td.daemon.tokens.operator, body: '{}' })).status,
    ).toBe(200);
  });

  it('logs out exactly itself, and its event stream ends with it', async () => {
    const td = await startTestDaemon(ws());
    const a = await signIn(td);
    const b = await signIn(td);
    const stream = openStream(td, a);
    await new Promise((r) => setTimeout(r, 300));
    expect((await raw(td, 'POST', td.operator.projectPath('/ui/logout'), { token: a, body: '{}' })).status).toBe(200);
    const ended = await Promise.race([
      stream.done.then(() => 'ended'),
      new Promise((r) => setTimeout(() => r('open'), 3000)),
    ]);
    stream.abort();
    expect(ended).toBe('ended');
    expect((await raw(td, 'GET', td.operator.projectPath('/ui/snapshot'), { token: a })).status).toBe(401);
    // Another session and the operator token are untouched.
    expect((await raw(td, 'GET', td.operator.projectPath('/ui/snapshot'), { token: b })).status).toBe(200);
    expect(
      (await raw(td, 'GET', td.operator.projectPath('/ui/snapshot'), { token: td.daemon.tokens.operator })).status,
    ).toBe(200);
    // The operator token itself cannot log out.
    expect(
      (await raw(td, 'POST', td.operator.projectPath('/ui/logout'), { token: td.daemon.tokens.operator, body: '{}' }))
        .status,
    ).toBe(403);
  });

  it('ends at its age limit and at a token rotation, streams included', async () => {
    const clock = new FakeClock('2026-10-17T10:00:00.000Z');
    const td = await startTestDaemon(ws(), { clock });
    const old = await signIn(td);
    const stream = openStream(td, old);
    await new Promise((r) => setTimeout(r, 300));
    clock.advance(UI_SESSION_MAX_AGE_MS + 1000);
    const ended = await Promise.race([
      stream.done.then(() => 'ended'),
      new Promise((r) => setTimeout(() => r('open'), 3000)),
    ]);
    stream.abort();
    expect(ended).toBe('ended');
    const after = await raw(td, 'GET', td.operator.projectPath('/ui/snapshot'), { token: old });
    expect(after.status).toBe(401);

    const fresh = await signIn(td);
    const s2 = openStream(td, fresh);
    await new Promise((r) => setTimeout(r, 300));
    await raw(td, 'POST', '/admin/rotate-tokens', { token: td.daemon.tokens.operator, body: '{}' });
    const ended2 = await Promise.race([
      s2.done.then(() => 'ended'),
      new Promise((r) => setTimeout(() => r('open'), 3000)),
    ]);
    s2.abort();
    expect(ended2).toBe('ended');
  });

  it('can stop Friday', async () => {
    const td = await startTestDaemon(ws());
    const token = await signIn(td);
    const r = await raw(td, 'POST', td.operator.projectPath('/daemon/stop'), { token, body: '{}' });
    expect(r.status).toBe(202);
    await td.daemon.closed;
  });
});
