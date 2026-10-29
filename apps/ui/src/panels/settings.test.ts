import type { BrainStatusView } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopPlatform, TEST_BODY, TEST_TITLE } from '../platform/desktop-platform.js';
import type { TauriCore } from '../platform/tauri-transport.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { clampNumber, pageActions, plannerSteps, readLoosening, settingsDrawer } from './settings.js';
import { buttonBy, check, choose, controlBy, flush, HOSTILE, type } from './test-support.js';

const brain = (over: Partial<BrainStatusView> = {}): BrainStatusView => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  remote: true,
  allow_remote: false,
  approved_here: false,
  endpoint: null,
  ignored_base_url: null,
  key: 'missing',
  planner_available: false,
  reason: 'no key',
  auto_approve: false,
  escalate_after_failures: 2,
  max_replans: 3,
  daily_budget_usd: 5,
  spent_today_usd: 0,
  cursor: 0,
  head: 0,
  ...over,
});

const POLICY = {
  policy: {
    version: 'v1',
    loosening: [{ source: '.friday/policy.yaml', setting: 'autonomy.git.push', from: 'manual', to: HOSTILE }],
    loosening_hash: 'abc123def4567890',
    trusted: false,
  },
};

function findCheckbox(root: HTMLElement, text: string): HTMLInputElement {
  const label = Array.from(root.querySelectorAll('label.check')).find((l) => l.textContent?.includes(text));
  return label?.querySelector('input') as HTMLInputElement;
}

/** How the shell refuses a native dialog the human cancelled (apps/desktop README, Errors). */
const CANCELLED = {
  status: 400,
  body: {
    error: {
      code: 'DESKTOP-1003',
      name: 'cancelled',
      message: 'you cancelled it in the confirmation dialog',
      retryable: false,
    },
  },
};

type ShellAnswer = (args: Record<string, unknown> | undefined) => unknown;

/** A context whose platform is the desktop's, over a fake shell answering each command from `answers`. */
function desktopContext(answers: Record<string, ShellAnswer> = {}, over: Partial<BrainStatusView> = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const all: Record<string, ShellAnswer> = { get_shortcuts: () => [], get_autostart: () => false, ...answers };
  const core: Pick<TauriCore, 'invoke'> = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, ...(args ? { args } : {}) });
      const answer = all[cmd];
      return answer ? answer(args) : null;
    }) as TauriCore['invoke'],
  };
  const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain(over) }) });
  (ctx as { platform: unknown }).platform = desktopPlatform(core, { writeText: async () => undefined });
  return { ctx, calls, to: (cmd: string) => calls.filter((c) => c.cmd === cmd) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('settings helpers', () => {
  it('clamps numbers', () => {
    expect(clampNumber('', 0, 1)).toBeNull();
    expect(clampNumber('abc', 0, 1)).toBeNull();
    expect(clampNumber('5', 0, 1)).toBe(1);
    expect(clampNumber('-1', 0, 1)).toBe(0);
  });

  it('reads both policy shapes', () => {
    expect(readLoosening(POLICY as never)).toEqual({
      items: POLICY.policy.loosening,
      hash: 'abc123def4567890',
      trusted: false,
    });
    expect(
      readLoosening({
        policy: {
          version: 'v',
          files: [],
          errors: [],
          loosening: { items: [{ setting: 's' }], hash: 'h', trusted: true },
        },
      } as never),
    ).toEqual({
      items: [{ source: '', setting: 's', from: '', to: '' }],
      hash: 'h',
      trusted: true,
    });
    expect(readLoosening(null)).toEqual({ items: [], hash: null, trusted: false });
  });

  it('lists only the planner steps still needed', () => {
    expect(plannerSteps(brain(), 7).map((s) => s.command ?? s.text)).toEqual([
      'friday secrets set anthropic',
      'friday brain allow-remote --budget 7',
      expect.stringContaining('providers.anthropic.allow_remote: true'),
      expect.stringContaining('Restart Friday'),
    ]);
    expect(plannerSteps(brain({ key: 'stored', approved_here: true }), 7).map((s) => s.command ?? s.text)).toEqual([
      expect.stringContaining('allow_remote'),
      expect.stringContaining('Restart'),
    ]);
  });
});

describe('settings drawer', () => {
  it('writes preferences', () => {
    const ctx = makeContext();
    const d = settingsDrawer(ctx, { kind: 'settings' });
    check(findCheckbox(d.el, 'Play sounds'), false);
    expect(ctx.store.select('prefs').muted).toBe(true);
    type(controlBy(d.el, 'Volume'), '0.5');
    expect(ctx.store.select('prefs').volume).toBe(0.5);
    buttonBy(d.el, /^On$/).click();
    expect(ctx.store.select('prefs').motion).toBe('reduce');
    buttonBy(d.el, /^Off$/).click();
    expect(ctx.store.select('prefs').motion).toBe('full');
    choose(controlBy<HTMLSelectElement>(d.el, 'Mascot outfit'), 'witch');
    expect(ctx.store.select('prefs').outfit).toBe('witch');
    const collapse = controlBy(d.el, 'Fold the Notch after (seconds)');
    collapse.value = '500';
    collapse.dispatchEvent(new Event('change'));
    expect(ctx.store.select('prefs').notchAutoCollapseS).toBe(120);
    const hide = controlBy(d.el, 'Hide the Notch after (seconds)');
    hide.value = 'x';
    hide.dispatchEvent(new Event('change'));
    expect(ctx.store.select('prefs').notchHideS).toBe(60);
    expect(hide.value).toBe('60');
    check(findCheckbox(d.el, 'Show finished goals'), false);
    expect(ctx.store.select('prefs').showFinished).toBe(false);
    d.destroy();
  });

  it('offers the desktop app its shortcuts and a restart, and nothing of them in a browser', async () => {
    expect(settingsDrawer(makeContext(), { kind: 'settings' }).el.textContent).not.toContain('Desktop app');
    const ctx = makeContext();
    const setShortcut = vi.fn(async (id: string, accel: string) => [
      { id, accel, state: 'registered' },
      { id: 'notch', accel: 'Ctrl+Alt+Shift+N', state: 'skipped', note: 'the keyboard layout types a letter' },
    ]);
    const restart = vi.fn(async () => true);
    (ctx as { platform: unknown }).platform = {
      kind: 'tauri',
      openInEditor: () => undefined,
      copy: async () => true,
      requestNotifications: async () => 'granted',
      desktop: {
        shortcuts: async () => [
          { id: 'studio', accel: 'Ctrl+Alt+Shift+F', state: 'registered' },
          { id: 'notch', accel: 'Ctrl+Alt+Shift+N', state: 'in_use' },
        ],
        setShortcut,
        restart,
        storeKey: async () => true,
        allowSpending: async () => true,
        autostart: async () => false,
        setAutostart: async (on: boolean) => on,
        testNotification: async () => true,
      },
    };
    const d = settingsDrawer(ctx, { kind: 'settings' });
    await flush();
    expect(d.el.textContent).toContain('Show the Studio');
    expect(d.el.textContent).toContain('Not active: in use');
    const keys = d.el.querySelector('input[aria-label="Keys for: Show the Studio"]') as HTMLInputElement;
    type(keys, 'Ctrl+Alt+Shift+B');
    const set = [...d.el.querySelectorAll('button')].find((b) => b.textContent === 'Set');
    set?.click();
    await flush();
    expect(setShortcut).toHaveBeenCalledWith('studio', 'Ctrl+Alt+Shift+B');
    expect(d.el.textContent).toContain('Not active: skipped. the keyboard layout types a letter');
    buttonBy(d.el, 'Restart Friday').click();
    await flush();
    expect(restart).toHaveBeenCalledOnce();
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Friday is restarting' });
    d.destroy();
  });

  it('says nothing when the human cancels the native restart dialog', async () => {
    const { ctx, to } = desktopContext({
      restart_daemon: () => {
        throw CANCELLED;
      },
    });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    await flush();
    const restart = buttonBy(d.el, 'Restart Friday');
    restart.click();
    await flush();
    expect(to('restart_daemon')).toHaveLength(1);
    expect(ctx.toasts).toEqual([]);
    expect(restart.disabled).toBe(false);
    d.destroy();
  });

  it('sends a test notification and says only what the shell can tell', async () => {
    let answer: unknown = true;
    const { ctx, to } = desktopContext({
      notify: () => {
        if (answer instanceof Error) throw { status: 429, body: { error: { code: 'DESKTOP-1008', message: 'wait' } } };
        return answer;
      },
    });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    await flush();
    const send = buttonBy(d.el, 'Send a test notification');
    send.click();
    await flush();
    expect(to('notify')).toEqual([{ cmd: 'notify', args: { title: TEST_TITLE, body: TEST_BODY, test: true } }]);
    // Handed to Windows: whether it appeared is beyond what the shell sees, and no answer claims
    // Windows refused it (the shell never learns Windows' answer).
    expect(d.el.textContent).toContain('Friday handed a test notification to Windows.');
    expect(d.el.textContent).toContain('If none appeared, Windows is holding Friday’s notifications back');
    expect(d.el.textContent).toContain('Do Not Disturb, Focus');
    expect(d.el.textContent).not.toContain('refused');
    answer = false;
    send.click();
    await flush();
    expect(d.el.textContent).toContain('Friday could not prepare the notification, so Windows was not asked.');
    expect(d.el.textContent).not.toContain('Friday handed');
    expect(d.el.textContent).not.toContain('refused');
    answer = new Error('too many');
    send.click();
    await flush();
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'error', text: 'Send a test notification', detail: 'wait' });
    expect(d.el.textContent).not.toContain('could not prepare');
    expect(d.el.textContent).not.toContain('Friday handed');
    expect(send.disabled).toBe(false);
    d.destroy();
  });

  it('asks the browser for notification permission and says when it was refused', async () => {
    const requestPermission = vi.fn(async () => 'denied');
    vi.stubGlobal('Notification', { requestPermission });
    const ctx = makeContext();
    const d = settingsDrawer(ctx, { kind: 'settings' });
    const box = findCheckbox(d.el, 'Notify me');
    check(box, true);
    await flush();
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(ctx.store.select('prefs').notifications).toBe(false);
    expect(box.checked).toBe(false);
    expect(d.el.textContent).toContain('The browser refused notifications');
    requestPermission.mockResolvedValueOnce('granted');
    check(box, true);
    await flush();
    expect(ctx.store.select('prefs').notifications).toBe(true);
    check(box, false);
    expect(ctx.store.select('prefs').notifications).toBe(false);
    expect(requestPermission).toHaveBeenCalledTimes(2);
    d.destroy();
  });

  it('says when the browser has no notifications', async () => {
    vi.stubGlobal('Notification', undefined);
    const ctx = makeContext();
    const d = settingsDrawer(ctx, { kind: 'settings' });
    check(findCheckbox(d.el, 'Notify me'), true);
    await flush();
    expect(d.el.textContent).toContain('This browser has no notifications.');
    expect(ctx.store.select('prefs').notifications).toBe(false);
    d.destroy();
  });

  it('in the desktop app turns notifications on without the browser API, absent or denying (deep review R8)', async () => {
    for (const api of [undefined, { requestPermission: vi.fn(async () => 'denied') }]) {
      vi.stubGlobal('Notification', api);
      const { ctx } = desktopContext();
      const d = settingsDrawer(ctx, { kind: 'settings' });
      const box = findCheckbox(d.el, 'Notify me while the Notch is hidden or the screen is locked');
      check(box, true);
      await flush();
      expect(ctx.store.select('prefs').notifications).toBe(true);
      expect(box.checked).toBe(true);
      expect(d.el.textContent).not.toContain('This browser has no notifications.');
      expect(d.el.textContent).not.toContain('The browser refused');
      if (api) expect(api.requestPermission).not.toHaveBeenCalled();
      check(box, false);
      expect(ctx.store.select('prefs').notifications).toBe(false);
      d.destroy();
    }
  });

  it('in the desktop app stores the key and allows spending through the native dialogs (deep review R9)', async () => {
    const { ctx, to } = desktopContext({
      store_key: (args) => ({ name: args?.name, stored: true, protection: 'dpapi', endpoint: null }),
      allow_spending: () => ({ ok: true }),
    });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'planner' });
    await flush();
    buttonBy(d.el, 'Store the key…').click();
    await flush();
    // Only the provider's name goes to the shell: the key stays in Windows' own prompt.
    expect(to('store_key')).toEqual([{ cmd: 'store_key', args: { name: 'anthropic' } }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'The key is stored' });
    expect(ctx.refreshes).toBe(1);
    expect(d.el.querySelector('input[type="password"]')).toBeNull();
    type(controlBy(d.el, 'Daily budget (USD) for the command below'), '12');
    buttonBy(d.el, 'Allow spending up to $12.00 a day…').click();
    await flush();
    expect(to('allow_spending')).toEqual([{ cmd: 'allow_spending', args: { budget: 12 } }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'This clone may spend up to $12.00 a day' });
    expect(ctx.refreshes).toBe(2);
    // Once the board says both are done, neither is offered again.
    ctx.board(makeSnapshot({ brain: brain({ key: 'stored', approved_here: true }) }));
    expect(buttonBy(d.el, 'Store the key…').hidden).toBe(true);
    expect(buttonBy(d.el, 'Allow spending').hidden).toBe(true);
    d.destroy();
  });

  it('a cancelled native dialog changes nothing and shows no error (deep review R9)', async () => {
    const { ctx, to } = desktopContext({
      store_key: () => {
        throw CANCELLED;
      },
      allow_spending: () => {
        throw CANCELLED;
      },
    });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'planner' });
    await flush();
    buttonBy(d.el, 'Store the key…').click();
    await flush();
    buttonBy(d.el, 'Allow spending').click();
    await flush();
    expect(to('store_key')).toHaveLength(1);
    expect(to('allow_spending')).toHaveLength(1);
    expect(ctx.toasts).toEqual([]);
    expect(ctx.refreshes).toBe(0);
    expect(buttonBy(d.el, 'Store the key…').disabled).toBe(false);
    d.destroy();
  });

  it('offers no native dialogs in a browser', () => {
    const d = settingsDrawer(makeContext({ snapshot: makeSnapshot({ brain: brain() }) }), { kind: 'settings' });
    expect(() => buttonBy(d.el, 'Store the key…')).toThrow();
    expect(() => buttonBy(d.el, 'Allow spending')).toThrow();
    expect(d.el.textContent).not.toContain('Start Friday when I sign in');
    d.destroy();
  });

  it('in the desktop app turns starting at sign-in on and off (deep review R11)', async () => {
    let on = true;
    const { ctx, to } = desktopContext({
      get_autostart: () => on,
      set_autostart: (args) => {
        on = args?.enabled === true;
        return on;
      },
    });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    const box = findCheckbox(d.el, 'Start Friday when I sign in');
    expect(box.disabled).toBe(true);
    await flush();
    expect(box.disabled).toBe(false);
    expect(box.checked).toBe(true);
    check(box, false);
    await flush();
    expect(to('set_autostart')).toEqual([{ cmd: 'set_autostart', args: { enabled: false } }]);
    expect(box.checked).toBe(false);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Friday no longer starts when you sign in' });
    check(box, true);
    await flush();
    expect(to('set_autostart').at(-1)?.args).toEqual({ enabled: true });
    expect(box.checked).toBe(true);
    d.destroy();
  });

  it('puts the sign-in toggle back when the shell refuses (deep review R11)', async () => {
    const { ctx } = desktopContext({
      set_autostart: () => {
        throw { status: 500, body: { error: { code: 'DESKTOP-2007', name: 'autostart_failed', message: 'no' } } };
      },
    });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    await flush();
    const box = findCheckbox(d.el, 'Start Friday when I sign in');
    check(box, true);
    await flush();
    expect(box.checked).toBe(false);
    // The shell's refusal reaches the toast as Friday's error, its message readable.
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'error', text: 'Change starting at sign-in', detail: 'no' });
    d.destroy();
  });

  it('shows the planner steps as copyable commands and takes no key', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain() }) });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'planner' });
    const text = d.el.textContent ?? '';
    expect(text).toContain('store a provider key');
    expect(text).toContain('friday secrets set anthropic');
    expect(text).toContain('friday brain allow-remote --budget 5');
    expect(text).toContain('cd "C:/demo/shop"');
    type(controlBy(d.el, 'Daily budget (USD) for the command below'), '12');
    expect(d.el.textContent).toContain('friday brain allow-remote --budget 12');
    expect(d.el.querySelector('input[type="password"]')).toBeNull();
    expect(
      Array.from(d.el.querySelectorAll('label')).some(
        (l) => /key/i.test(l.textContent ?? '') && !/budget/i.test(l.textContent ?? ''),
      ),
    ).toBe(false);
    d.destroy();
  });

  it('trusts exactly the hash shown, after a confirmation', async () => {
    const ctx = makeContext({
      answers: { 'GET /policy': POLICY, 'POST /policy/trust': { policy: { ...POLICY.policy, trusted: true } } },
    });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    await flush();
    expect(d.el.querySelector('img')).toBeNull();
    expect(d.el.textContent).toContain(HOSTILE);
    buttonBy(d.el, 'Trust this list').click();
    await flush();
    expect(ctx.confirms[0]?.body).toEqual(expect.arrayContaining([expect.stringContaining('abc123def4567890')]));
    expect(ctx.transport.to('POST', '/policy/trust')[0]?.body).toEqual({ loosening_hash: 'abc123def4567890' });
    expect(d.el.textContent).toContain('trusted here');
    d.destroy();
  });

  it('logs out and reloads the page', async () => {
    const reload = vi.spyOn(pageActions, 'reload').mockImplementation(() => undefined);
    sessionStorage.setItem('friday.ui.session', '{"token":"t","expires_at":"2999-01-01T00:00:00Z","project_id":"p"}');
    const ctx = makeContext({ answers: { 'POST /ui/logout': { ok: true } } });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    buttonBy(d.el, 'Log out').click();
    await flush();
    expect(ctx.transport.to('POST', '/ui/logout')).toHaveLength(1);
    expect(sessionStorage.getItem('friday.ui.session')).toBeNull();
    expect(reload).toHaveBeenCalledOnce();
    d.destroy();
  });

  it('stops Friday only after a confirmation', async () => {
    const ctx = makeContext({ answers: { 'POST /daemon/stop': { ok: true } } });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    ctx.confirmAnswer = false;
    buttonBy(d.el, 'Stop Friday').click();
    await flush();
    expect(ctx.transport.to('POST', '/daemon/stop')).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonBy(d.el, 'Stop Friday').click();
    await flush();
    expect(ctx.confirms.every((c) => c.danger)).toBe(true);
    expect(ctx.transport.to('POST', '/daemon/stop')).toHaveLength(1);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Friday is stopping' });
    d.destroy();
  });

  it('shows the about facts with 127.0.0.1', () => {
    const ctx = makeContext();
    const d = settingsDrawer(ctx, { kind: 'settings' });
    expect(d.el.textContent).toContain('127.0.0.1:4310');
    expect(d.el.textContent).toContain('shop');
    d.destroy();
  });
});
