import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { UI_PREFS_FILE } from '@friday/daemon';
import { privateDirFor } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { codeOf, raw, signIn } from '../helpers/ui.js';

/**
 * The interface's preferences are kept with the project, not with a browser origin
 * (docs/frontend/PLAN.md §6 rule 8): Friday's port, so the page's origin, changes at every start.
 */

const ws = useTestWorkspace();

/** What the page sends: no notifications (their permission belongs to the origin), and when it saved them. */
const PREFS = {
  muted: true,
  volume: 0.4,
  motion: 'reduce',
  outfit: 'visor',
  showFinished: false,
  notchAutoCollapseS: 20,
  notchHideS: 90,
  positions: { task_0000000000000000000000aa01: { x: 120, y: -40.5 } },
  gettingStartedDismissed: true,
  terminalHeight: 420,
  saved_at: 1_792_000_000_123,
};

const prefsPath = (td: TestDaemon) => td.operator.projectPath('/ui/prefs');
const prefsFile = (td: TestDaemon) =>
  path.join(privateDirFor(td.project, { FRIDAY_STATE_DIR: ws().stateDir }), UI_PREFS_FILE);

/** Holds `port`, so the next daemon cannot listen there; null when something else already has it. */
function hold(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

describe('the interface preferences', () => {
  it('survive a restart of Friday on another port', async () => {
    const first = await startTestDaemon(ws());
    const token = await signIn(first);
    expect((await raw(first, 'GET', prefsPath(first), { token })).json).toEqual({ prefs: null });
    const saved = await raw(first, 'POST', prefsPath(first), { token, body: JSON.stringify({ prefs: PREFS }) });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.json).toEqual({ ok: true });
    const port = first.daemon.port();
    await first.daemon.close('restart');

    const held = await hold(port);
    try {
      const second = await startTestDaemon(ws(), { initialized: true });
      expect(second.daemon.port()).not.toBe(port);
      // The first start's session ended with it; the page signs in again and finds what it saved.
      expect((await raw(second, 'GET', prefsPath(second), { token })).status).toBe(401);
      const again = await raw(second, 'GET', prefsPath(second), { token: await signIn(second) });
      expect(again.status, again.text).toBe(200);
      expect(again.json).toEqual({ prefs: PREFS });
      expect(again.headers.get('cache-control')).toBe('no-store');
    } finally {
      held?.close();
    }
  });

  it('are kept in the private folder, for the operator and a UI session only', async () => {
    const td = await startTestDaemon(ws());
    const body = JSON.stringify({ prefs: { volume: 0.3 } });
    expect((await raw(td, 'POST', prefsPath(td), { token: td.daemon.tokens.operator, body })).status).toBe(200);
    const file = prefsFile(td);
    expect(file.startsWith(ws().stateDir)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ volume: 0.3 });

    const bootstrap = await raw(td, 'GET', prefsPath(td), { token: td.daemon.tokens.bootstrap });
    expect(bootstrap.status).toBe(403);
    expect(codeOf(bootstrap)).toBe('COS-3006');
    expect((await raw(td, 'POST', prefsPath(td), { token: td.daemon.tokens.bootstrap, body })).status).toBe(403);
    expect((await raw(td, 'GET', prefsPath(td))).status).toBe(401);
  });

  it('refuse anything but a JSON object of at most 64 KB, and keep what was saved', async () => {
    const td = await startTestDaemon(ws());
    const token = await signIn(td);
    const post = (body: string) => raw(td, 'POST', prefsPath(td), { token, body });
    expect((await post(JSON.stringify({ prefs: { outfit: 'winter' } }))).status).toBe(200);

    let deep: unknown = { x: 1 };
    for (let i = 0; i < 10; i++) deep = { deep };
    for (const body of ['', '[]', '{not json', '{}', '{"prefs":null}', '{"prefs":[1,2]}', '{"prefs":"x"}']) {
      const r = await post(body);
      expect(r.status, body).toBe(400);
      expect(codeOf(r), body).toMatch(/^COS-100[01]$/);
    }
    const nested = await post(JSON.stringify({ prefs: deep }));
    expect(nested.status).toBe(400);

    const big = await post(JSON.stringify({ prefs: { saved_at: PREFS.saved_at, pad: 'x'.repeat(70_000) } }));
    expect(big.status).toBe(413);
    expect(codeOf(big)).toBe('COS-1004');

    expect((await raw(td, 'GET', prefsPath(td), { token })).json).toEqual({ prefs: { outfit: 'winter' } });
  });

  it('never hold a credential, and read an unusable file as none', async () => {
    const td = await startTestDaemon(ws());
    const token = await signIn(td);
    const key = `sk-ant-${'a'.repeat(30)}`;
    const prefs = { outfit: td.daemon.tokens.operator, note: key, session: token, saved_at: PREFS.saved_at };
    const body = JSON.stringify({ prefs });
    expect((await raw(td, 'POST', prefsPath(td), { token, body })).status).toBe(200);
    const text = readFileSync(prefsFile(td), 'utf8');
    for (const secret of [td.daemon.tokens.operator, key, token]) expect(text).not.toContain(secret);
    const back = (await raw(td, 'GET', prefsPath(td), { token })).json as { prefs: Record<string, unknown> };
    expect(back.prefs.outfit).toMatch(/^\[REDACTED/);
    expect(back.prefs.note).toMatch(/^\[REDACTED/);
    // The time the page saved them comes back as it was sent: a number, untouched by the masking.
    expect(back.prefs.saved_at).toBe(PREFS.saved_at);

    for (const content of ['{not json', '[1,2]', '"x"']) {
      writeFileSync(prefsFile(td), content);
      expect((await raw(td, 'GET', prefsPath(td), { token })).json, content).toEqual({ prefs: null });
    }
  });
});
