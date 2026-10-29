import { afterEach, describe, expect, it, vi } from 'vitest';
import { takeRequestedReach } from '../governance/decisions.js';
import { SAVE_DEBOUNCE_MS } from '../store/prefs.js';
import { makeContext } from '../test/context.js';
import { makeApproval, makeEvent, makeRun, makeSnapshot, makeTask, T0 } from '../test/fixtures.js';
import {
  applyDeepLink,
  bootDesktopNotch,
  bootDesktopStudio,
  type DaemonStatus,
  type DesktopEnv,
  type StudioTarget,
  sendableLink,
  statusScreen,
  studioLink,
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
  /** The event stream's channel, once the page opened it. */
  let channel: ((message: unknown) => void) | null = null;
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
        constructor(onmessage?: (message: unknown) => void) {
          channel = onmessage ?? null;
        }
      } as unknown as DesktopEnv['core']['Channel'],
    },
    listen: async (event, handler) => {
      listeners.set(event, handler as (p: unknown) => void);
      return () => listeners.delete(event);
    },
  };
  return {
    env,
    calls,
    emit: (event: string, payload: unknown) => listeners.get(event)?.(payload),
    send: (message: unknown) => channel?.(message),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

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

  it('carries the reach chosen on the Notch, and the id a panel opens on (review M9i)', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ approvals: [makeApproval()] }) });
    ctx.registry.modal('recover', () => ({ el: document.createElement('div'), title: 'Recover', destroy() {} }));
    applyDeepLink(ctx, { approval_id: 'apr_1', reach: 'task' });
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'approval', id: 'apr_1' });
    expect(takeRequestedReach('apr_1')).toBe('task');
    applyDeepLink(ctx, { panel: 'recover', id: 'task_7' });
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'recover', id: 'task_7' });
  });
});

describe('deep links from the Notch window (deep review R7)', () => {
  /** A Studio window's context with the drawers the links name. */
  function studio() {
    const ctx = makeContext({ snapshot: makeSnapshot({ tasks: [makeTask({ task_id: 't1' })] }) });
    for (const kind of ['settings', 'agents', 'diff', 'inspector'] as const)
      ctx.registry.drawer(kind, () => ({ el: document.createElement('div'), title: kind, destroy() {} }));
    return ctx;
  }
  /** The link as the Studio receives it: JSON, across the shell. */
  const across = (link: unknown): StudioTarget => JSON.parse(JSON.stringify(link)) as StudioTarget;

  it('opens the drawer each Notch target names, with its tab and file', () => {
    const ctx = studio();
    applyDeepLink(ctx, across(studioLink({ panel: 'settings' })));
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings' });
    applyDeepLink(ctx, across(studioLink({ panel: 'agents', tab: 'routing' })));
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents', tab: 'routing' });
    applyDeepLink(ctx, across(studioLink({ task_id: 't1', panel: 'diff', path: 'backend/src/checkout.ts' })));
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 't1', path: 'backend/src/checkout.ts' });
    applyDeepLink(ctx, across(studioLink({ task_id: 't1' })));
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: 't1' });
    expect(studioLink({ task_id: 't1', approval_id: 'apr_1' })).toEqual({ focus_task: 't1', approval_id: 'apr_1' });
  });

  it('drops a tab or a file path of an unexpected form', () => {
    const ctx = studio();
    applyDeepLink(ctx, { panel: 'agents', tab: '<b>routing</b>' });
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents' });
    applyDeepLink(ctx, { panel: 'diff', id: 't1', path: `a${String.fromCharCode(7)}b.ts` });
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 't1' });
    applyDeepLink(ctx, { panel: 'diff', id: 't1', path: 'x'.repeat(2000) });
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 't1' });
  });

  it('the Notch window sends Settings, Routing and the ticker’s file, and the Studio opens that drawer', async () => {
    const snapshot = makeSnapshot({
      tasks: [makeTask({ task_id: 't1', status: 'RUNNING', plan_key: 'api' })],
      runs: { t1: makeRun({ task_id: 't1' }) },
    });
    const shell = fakeShell([{ state: 'ready' }], snapshot);
    const root = document.createElement('div');
    document.body.append(root);
    await bootDesktopNotch(root, shell.env);
    await settle();
    const ctx = studio();
    /** The last `show_studio` target, delivered to the Studio as the shell's `studio-deeplink`. */
    const deliver = () => {
      const sent = shell.calls.filter((c) => c.cmd === 'show_studio').at(-1);
      applyDeepLink(ctx, across(sent?.args?.target));
    };
    const q = <T extends HTMLElement>(sel: string): T => {
      const el = root.querySelector<T>(sel);
      if (!el) throw new Error(`no ${sel}`);
      return el;
    };
    try {
      q<HTMLButtonElement>('.nt-foot-btn').click();
      deliver();
      expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings' });
      q<HTMLButtonElement>('.nt-routing').click();
      deliver();
      expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents', tab: 'routing' });

      // An agent writes a file; on the folded pill the ticker names it.
      shell.send({
        kind: 'event',
        event: makeEvent(1000, 'run.paths_observed', { task_id: 't1', paths: ['backend/src/checkout.ts'] }),
      });
      shell.emit('notch-open', { focus: true });
      q('.nt-expanded').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const ticker = q<HTMLButtonElement>('.nt-ticker');
      expect(ticker.hidden).toBe(false);
      ticker.click();
      deliver();
      expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 't1', path: 'backend/src/checkout.ts' });
    } finally {
      window.dispatchEvent(new Event('pagehide'));
    }
  });

  it('leaves out a file path the shell would refuse, so the diff still opens without it', async () => {
    const snapshot = makeSnapshot({
      tasks: [makeTask({ task_id: 't1', status: 'RUNNING', plan_key: 'api' })],
      runs: { t1: makeRun({ task_id: 't1' }) },
    });
    const shell = fakeShell([{ state: 'ready' }], snapshot);
    const root = document.createElement('div');
    document.body.append(root);
    await bootDesktopNotch(root, shell.env);
    await settle();
    const ctx = studio();
    const sent = () => shell.calls.filter((c) => c.cmd === 'show_studio').at(-1)?.args?.target;
    const ticker = () => {
      const el = root.querySelector<HTMLButtonElement>('.nt-ticker');
      if (!el) throw new Error('no ticker');
      return el;
    };
    try {
      shell.emit('notch-open', { focus: true });
      root
        .querySelector('.nt-expanded')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      // An agent's file names hold what they like: a line break, or more than the shell takes.
      let at = 1000;
      for (const path of ['backend/src/a\nb.ts', `backend/src/${'x'.repeat(1100)}.ts`]) {
        shell.send({ kind: 'event', event: makeEvent(at++, 'run.paths_observed', { task_id: 't1', paths: [path] }) });
        expect(ticker().hidden).toBe(false);
        ticker().click();
        expect(sent()).toEqual({ panel: 'diff', id: 't1' });
        applyDeepLink(ctx, across(sent()));
        expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 't1' });
      }
    } finally {
      window.dispatchEvent(new Event('pagehide'));
    }
  });

  it('sends a tab and a path only of the forms both sides take', () => {
    expect(sendableLink({ panel: 'agents', tab: 'routing' })).toEqual({ panel: 'agents', tab: 'routing' });
    expect(sendableLink({ panel: 'settings', tab: 'step-2' })).toEqual({ panel: 'settings', tab: 'step-2' });
    for (const tab of ['Routing', 'pins_1', '-pins', 'a'.repeat(33)])
      expect(sendableLink({ panel: 'agents', tab })).toEqual({ panel: 'agents' });
    expect(sendableLink({ panel: 'diff', id: 't1', path: 'a\tb.ts', tab: 'goal' })).toEqual({
      panel: 'diff',
      id: 't1',
      tab: 'goal',
    });
    expect(sendableLink({ panel: 'diff', id: 't1', path: 'é'.repeat(1024) })).toEqual({
      panel: 'diff',
      id: 't1',
      path: 'é'.repeat(1024),
    });
    expect(sendableLink({ approval_id: 'apr_1', reach: 'task' })).toEqual({ approval_id: 'apr_1', reach: 'task' });
  });
});

describe('preferences in the desktop windows (deep review R5)', () => {
  const prefsCalls = (calls: { cmd: string; args?: Record<string, unknown> }[], method: 'GET' | 'POST') =>
    calls.filter(
      (c) => c.cmd === 'friday_request' && c.args?.method === method && String(c.args?.path).endsWith('/ui/prefs'),
    );

  it('read and keep the project’s copy, and stop with the window', async () => {
    const studioShell = fakeShell([{ state: 'ready' }]);
    const studioRoot = document.createElement('div');
    document.body.append(studioRoot);
    await bootDesktopStudio(studioRoot, studioShell.env);
    await settle();
    expect(prefsCalls(studioShell.calls, 'GET')).toHaveLength(1);

    const shell = fakeShell([{ state: 'ready' }]);
    const root = document.createElement('div');
    document.body.append(root);
    await bootDesktopNotch(root, shell.env);
    await settle();
    expect(prefsCalls(shell.calls, 'GET')).toHaveLength(1);
    // The daemon held none: this window's copy became the first.
    expect(prefsCalls(shell.calls, 'POST')).toHaveLength(1);
    shell.emit('toggle-mute', { muted: true });
    window.dispatchEvent(new Event('pagehide'));
    await settle();
    // The change made just before the window closed was sent; nothing is sent after.
    const saved = prefsCalls(shell.calls, 'POST');
    expect(saved).toHaveLength(2);
    expect(saved[1]?.args?.body).toMatchObject({ prefs: { muted: true } });
    shell.emit('toggle-mute', { muted: false });
    await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 100));
    expect(prefsCalls(shell.calls, 'POST')).toHaveLength(2);
  });
});

describe('the tray line', () => {
  it('says what runs, what waits and whether Friday is paused', () => {
    const board = makeSnapshot({
      approvals: [makeApproval()],
      tasks: [makeTask({ status: 'RUNNING' })],
    });
    // The fixtures' clock, not the machine's: the approval expires at a fixed time, and a test that
    // read the real clock passed only until that afternoon (LESSONS T-69).
    const now = Date.parse(T0);
    const t = trayState(board, 'live', now);
    expect(t.state).toBe('waiting');
    expect(t.countsLine).toContain('1 waiting for you');
    expect(trayState(makeSnapshot(), 'live', now).state).toBe('idle');
    expect(trayState(null, 'stopped', now)).toMatchObject({ state: 'error' });
  });
});
