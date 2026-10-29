import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';
import { attachedSession, codeOf, fakeBundle, mintCode, raw, signIn } from '../helpers/ui.js';

/**
 * The interface's security review points (docs/frontend/PLAN.md §9), as end-to-end checks of what
 * must not happen. Route-level detail is in tests/integration/ui-*.test.ts.
 */

const ws = useTestWorkspace();

describe('who may sign a browser in', () => {
  it('lets only the operator token mint a code; no other class, and not a UI session', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const session = await signIn(td);
    const { client } = await attachedSession(td);
    const harness = (client as unknown as { registration: { harness_token: string } }).registration.harness_token;
    for (const [name, token] of [
      ['bootstrap', td.daemon.tokens.bootstrap],
      ['harness', harness],
      ['UI session', session],
    ] as const) {
      const r = await raw(td, 'POST', td.operator.projectPath('/ui/login-codes'), { token, body: '{}' });
      expect(r.status, name).toBe(403);
    }
  });

  it('refuses the exchange from any other origin, and a framed page cannot load', async () => {
    const td = await startTestDaemon(ws(), { uiDir: fakeBundle(ws()) });
    const { code } = await mintCode(td);
    for (const origin of ['http://127.0.0.1:1', 'http://evil.example', 'null']) {
      const r = await raw(td, 'POST', '/ui/session', { origin, body: JSON.stringify({ code }) });
      expect(r.status, origin).toBe(403);
    }
    const base = (await raw(td, 'GET', '/ui')).headers.get('location') ?? '';
    const page = await raw(td, 'GET', base);
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(page.headers.get('x-frame-options')).toBe('DENY');
  });

  it('keeps a UI session away from admin routes (a backup could write anywhere)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const session = await signIn(td);
    const backup = await raw(td, 'POST', '/admin/backup', {
      token: session,
      body: JSON.stringify({ into: path.join(ws().root, 'stolen') }),
    });
    expect(backup.status).toBe(403);
    expect(codeOf(backup)).toBe('COS-3006');
  });
});

describe('what the bundle holds', () => {
  it('contains no token-shaped value and no runtime import of a Node module', () => {
    const dist = path.join(REPO_ROOT, 'apps', 'ui', 'dist');
    let files: string[] = [];
    try {
      files = readdirSync(dist, { recursive: true })
        .map((f) => path.join(dist, String(f)))
        .filter((f) => statSync(f).isFile());
    } catch {
      // Not built in this run: the build step of the suite checks it then.
    }
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/\b[A-Za-z0-9_-]{43}\b(?=["'])/);
      expect(text, f).not.toContain('__vite-browser-external');
      expect(text, f).not.toMatch(/from\s*["']node:/);
    }
  });
});
