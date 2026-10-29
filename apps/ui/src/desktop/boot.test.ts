import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeApproval, makeSnapshot, makeTask } from '../test/fixtures.js';
import {
  applyDeepLink,
  bootDesktopStudio,
  type DaemonStatus,
  type DesktopEnv,
  statusScreen,
  trayState,
  untilReady,
} from './boot.js';

const INFO = {
  project_id: 'proj_000000000000000000000000t1',
  name: 'shop',
  root: 'C:/shop',
  port: 1,
  url: 'http://127.0.0.1:1',
  ui_api: 1,
};

/** A shell that answers `daemon_status` from a list, and the board snapshot for any read. */
function fakeShell(statuses: DaemonStatus[], snapshot = makeSnapshot()) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const listeners = new Map<string, (p: unknown) => void>();
  let i = 0;
  const env: DesktopEnv = {
    pollMs: 1,
    core: {
      invoke: (async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ? { args } : {}) });
        if (cmd === 'daemon_status') return statuses[Math.min(i++, statuses.length - 1)];
        if (cmd === 'project_info') return INFO;
        if (cmd === 'friday_request') return snapshot;
        if (cmd === 'stream_open') return 1;
        return null;
      }) as DesktopEnv['core']['invoke'],
      Channel: class {
        readonly id = 7;
      } as unknown as DesktopEnv['core']['Channel'],
    },
    listen: async (event, handler) => {
      listeners.set(event, handler as (p: unknown) => void);
      return () => listeners.delete(event);
    },
  };
  return { env, calls, emit: (event: string, payload: unknown) => listeners.get(event)?.(payload) };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('waiting for Friday in the desktop app', () => {
  it('shows the daemon state until it is ready, then answers the project', async () => {
    const shell = fakeShell([{ state: 'starting' }, { state: 'starting' }, { state: 'ready' }]);
    const root = document.createElement('div');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(root.querySelector('.sh-login-title')?.textContent ?? ''));
    observer.observe(root, { childList: true, subtree: true });
    expect(await untilReady(shell.env, root)).toEqual(INFO);
    observer.disconnect();
    expect(seen).toContain('Friday is starting');
    // Shown once per state, not on every poll.
    expect(shell.calls.filter((c) => c.cmd === 'daemon_status')).toHaveLength(3);
  });

  it('starts a stopped Friday only when asked, and shows what the shell saw when it failed', () => {
    const start = vi.fn();
    const stopped = statusScreen({ state: 'stopped' }, start);
    const btn = [...stopped.querySelectorAll('button')].find((b) => b.textContent === 'Start Friday');
    expect(btn).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    btn?.click();
    expect(start).toHaveBeenCalledOnce();
    const failed = statusScreen({ state: 'failed', message: 'port taken <b>x</b>' }, start);
    expect(failed.querySelector('.sh-login-detail')?.textContent).toBe('port taken <b>x</b>');
    expect(failed.querySelector('b')).toBeNull();
    expect(statusScreen({ state: 'starting' }, start).querySelector('button')).toBeNull();
  });
});

describe('the desktop Studio', () => {
  it('mounts the Studio without an in-page Notch, through the shell, holding no token', async () => {
    const shell = fakeShell([{ state: 'ready' }]);
    const root = document.createElement('div');
    document.body.append(root);
    await bootDesktopStudio(root, shell.env);
    await new Promise((r) => setTimeout(r, 20));
    expect(root.querySelector('.sh-app')).toBeTruthy();
    expect(root.querySelector('.sh-notch-layer')?.childElementCount).toBe(0);
    const reads = shell.calls.filter((c) => c.cmd === 'friday_request');
    expect(reads.some((c) => String(c.args?.path).endsWith('/ui/snapshot'))).toBe(true);
    expect(JSON.stringify(shell.calls)).not.toMatch(/token|authorization/i);
  });

  it('follows deep links: an approval opens its full view, a task its inspector, a known panel only', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ approvals: [makeApproval()], tasks: [makeTask()] }) });
    ctx.registry.drawer('agents', () => ({ el: document.createElement('div'), title: 'Agents', destroy() {} }));
    applyDeepLink(ctx, { approval_id: 'apr_1' });
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'approval', id: 'apr_1' });
    applyDeepLink(ctx, { focus_task: 'task_1' });
    expect(ctx.store.select('ui')).toMatchObject({
      selectedTaskId: 'task_1',
      drawer: { kind: 'inspector', id: 'task_1' },
    });
    applyDeepLink(ctx, { panel: 'agents' });
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents' });
    applyDeepLink(ctx, { panel: 'not-a-panel' });
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents' });
  });
});

describe('the tray line', () => {
  it('says what runs, what waits and whether Friday is paused', () => {
    const board = makeSnapshot({
      approvals: [makeApproval()],
      tasks: [makeTask({ status: 'RUNNING' })],
    });
    const t = trayState(board, 'live', Date.now());
    expect(t.state).toBe('waiting');
    expect(t.countsLine).toContain('1 waiting for you');
    expect(trayState(makeSnapshot(), 'live', Date.now()).state).toBe('idle');
    expect(trayState(null, 'stopped', Date.now())).toMatchObject({ state: 'error' });
  });
});
