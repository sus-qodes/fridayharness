import type { BrainStatusView } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { desktopPlatform, TEST_BODY, TEST_TITLE } from '../platform/desktop-platform.js';
import type { TauriCore } from '../platform/tauri-transport.js';
import { UI_VERSION } from '../shell/version.js';
import { makeContext } from '../test/context.js';
import { makeRun, makeSnapshot, makeTask } from '../test/fixtures.js';
import { routingModeOf } from './routing-pins.js';
import {
  clampNumber,
  pageActions,
  plannerSteps,
  readLoosening,
  SETTINGS_SECTIONS,
  settingsDrawer,
  worktreesInUse,
} from './settings.js';
import { BIDI, buttonBy, check, choose, controlBy, flush, HOSTILE, type } from './test-support.js';

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

const MODELS = { models: [{ id: 'claude-sonnet-5' }, { id: 'gpt-5.6' }], evidence: [], settings: { mode: 'hybrid' } };

const PIN = {
  pin_id: 'pin1',
  scope: 'kind',
  target: 'docs',
  model: 'gpt-5.6',
  mode: null,
  sensitive: false,
  needs_vision: false,
  until: null,
  source: 'human',
  note: null,
  created_at: 'x',
  revoked_at: null,
};

function findCheckbox(root: HTMLElement, text: string): HTMLInputElement {
  const label = Array.from(root.querySelectorAll('label.check')).find((l) => l.textContent?.includes(text));
  return label?.querySelector('input') as HTMLInputElement;
}

/** The section titled `title` (its `<section>`), or null. */
function section(root: HTMLElement, title: string): HTMLElement | null {
  return (
    (Array.from(root.querySelectorAll('section.pn-section')).find(
      (s) => s.querySelector('.section-title')?.textContent === title,
    ) as HTMLElement | undefined) ?? null
  );
}

function titles(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('section.pn-section > .section-title')).map((t) => t.textContent ?? '');
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

  it('offers a planner on this machine its server and model, never an Anthropic key (plan M12.1)', () => {
    const local = brain({ provider: 'local', model: 'qwen2.5:7b', remote: false, key: 'not needed' });
    expect(plannerSteps(local, 7).map((s) => s.command ?? s.text)).toEqual(['friday doctor']);
    expect(JSON.stringify(plannerSteps(local, 7))).not.toMatch(/anthropic|allow-remote/i);
  });

  it('counts the worktrees in use once per folder, for live runs with a ready workspace outside the checkout', () => {
    const board = makeSnapshot({
      runs: {
        a: makeRun({ run_id: 'a', execution_root: 'C:/wt/a' }),
        a2: makeRun({ run_id: 'a2', status: 'SUSPENDED', execution_root: 'C:\\wt\\A\\' }),
        b: makeRun({ run_id: 'b', status: 'STARTING', execution_root: 'C:/wt/b' }),
        ended: makeRun({ run_id: 'ended', status: 'ENDED', execution_root: 'C:/wt/c' }),
        pending: makeRun({ run_id: 'pending', workspace: 'pending' as never, execution_root: 'C:/wt/d' }),
        main: makeRun({ run_id: 'main', execution_root: 'C:/demo/shop' }),
      },
    });
    expect(worktreesInUse(board)).toBe(2);
    expect(worktreesInUse(null)).toBe(0);
    expect(worktreesInUse(makeSnapshot())).toBe(0);
  });

  it('reads the routing mode word the daemon reports, and nothing else', () => {
    expect(routingModeOf({ mode: 'hybrid' })).toBe('hybrid');
    expect(routingModeOf({ mode: '' })).toBeNull();
    expect(routingModeOf({})).toBeNull();
    expect(routingModeOf(undefined)).toBeNull();
    expect(routingModeOf({ mode: 42 })).toBeNull();
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
    // The Notch timings sit under an Advanced fold in Look and Notch, closed until opened.
    const advanced = section(d.el, 'Look and Notch')?.querySelector('details.pn-fold') as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    expect(advanced.querySelector('summary')?.textContent).toBe('Advanced');
    advanced.open = true;
    const collapse = controlBy(advanced, 'Fold the Notch after (seconds)');
    collapse.value = '500';
    collapse.dispatchEvent(new Event('change'));
    expect(ctx.store.select('prefs').notchAutoCollapseS).toBe(120);
    const hide = controlBy(advanced, 'Hide the Notch after (seconds)');
    hide.value = 'x';
    hide.dispatchEvent(new Event('change'));
    expect(ctx.store.select('prefs').notchHideS).toBe(60);
    expect(hide.value).toBe('60');
    check(findCheckbox(d.el, 'Show finished goals'), false);
    expect(ctx.store.select('prefs').showFinished).toBe(false);
    d.destroy();
  });

  it('puts the sections in the review’s order, Notifications first, and opens at each by name', async () => {
    const browser = settingsDrawer(makeContext(), { kind: 'settings' });
    expect(titles(browser.el)).toEqual([
      'Notifications',
      'Sound',
      'Look and Notch',
      'Planner',
      'Routing',
      'Policy',
      'Friday',
      'About',
    ]);
    browser.destroy();
    const { ctx } = desktopContext();
    const desktop = settingsDrawer(ctx, { kind: 'settings' });
    expect(titles(desktop.el)).toEqual([
      'Notifications',
      'Sound',
      'Look and Notch',
      'Planner',
      'Routing',
      'Policy',
      'Friday',
      'Desktop app',
      'About',
    ]);
    desktop.destroy();
    // `tab` names a section: the drawer scrolls to it once mounted.
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.id);
    };
    try {
      for (const tab of SETTINGS_SECTIONS) {
        const d = settingsDrawer(ctx, { kind: 'settings', tab });
        await flush();
        expect(scrolled.at(-1)).toBe(`pn-settings-${tab}`);
        d.destroy();
      }
      const none = settingsDrawer(ctx, { kind: 'settings', tab: 'nowhere' });
      await flush();
      expect(scrolled).toHaveLength(SETTINGS_SECTIONS.length);
      none.destroy();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
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

  it('puts the test notification under Notifications and Restart under Friday, no longer under Desktop app', async () => {
    const { ctx } = desktopContext();
    const d = settingsDrawer(ctx, { kind: 'settings' });
    await flush();
    const notifications = section(d.el, 'Notifications') as HTMLElement;
    const friday = section(d.el, 'Friday') as HTMLElement;
    const desktop = section(d.el, 'Desktop app') as HTMLElement;
    expect(buttonBy(notifications, 'Send a test notification')).toBeTruthy();
    expect(buttonBy(friday, 'Restart Friday')).toBeTruthy();
    expect(buttonBy(friday, 'Stop Friday')).toBeTruthy();
    expect(() => buttonBy(desktop, 'Send a test notification')).toThrow();
    expect(() => buttonBy(desktop, 'Restart Friday')).toThrow();
    expect(desktop.textContent).toContain('Start Friday when I sign in');
    // In the desktop app there is no session to log out of.
    expect(() => buttonBy(d.el, 'Log out')).toThrow();
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
      // The hint points at the test button in the same section, not at another one.
      expect(d.el.textContent).toContain('Send a test notification (below)');
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
    expect(() => buttonBy(d.el, 'Restart Friday')).toThrow();
    expect(() => buttonBy(d.el, 'Send a test notification')).toThrow();
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

  // ---- Routing: the pins' home, as they worked from the Agents drawer before (review decision 2)

  it('shows the routing mode word beside the pins, and "unknown" when the daemon did not say', async () => {
    const ctx = makeContext({ answers: { 'GET /models': MODELS, 'GET /routing/pins': { pins: [] } } });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'routing' });
    await flush();
    const routing = section(d.el, 'Routing') as HTMLElement;
    expect(routing.querySelector('.pn-routing-mode')?.textContent).toBe('hybrid');
    expect(routing.textContent).toContain('Routing mode');
    expect(routing.textContent).toContain('No pins');
    expect(() => buttonBy(routing, 'Open routing pins')).toThrow();
    d.destroy();
    const bare = settingsDrawer(makeContext({ answers: { 'GET /models': { models: [] } } }), { kind: 'settings' });
    await flush();
    expect(bare.el.querySelector('.pn-routing-mode')?.textContent).toBe('unknown');
    expect(bare.el.textContent).toContain('No models known');
    bare.destroy();
  });

  it('pins a model to a role and unpins, from Settings', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ tasks: [makeTask()] }),
      answers: {
        'GET /models': MODELS,
        'GET /routing/pins': { pins: [PIN] },
        'POST /routing/pins': { pin: {} },
        'POST /routing/pins/pin1/revoke': { pin: {} },
      },
    });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'routing' });
    await flush();
    const routing = section(d.el, 'Routing') as HTMLElement;
    choose(controlBy<HTMLSelectElement>(routing, 'Model'), 'gpt-5.6');
    buttonBy(routing, /^Pin$/).click();
    await flush();
    expect(ctx.transport.to('POST', '/routing/pins')[0]?.body).toEqual({
      scope: 'role',
      target: 'developer',
      model: 'gpt-5.6',
    });
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Pinned gpt-5.6' });
    choose(controlBy<HTMLSelectElement>(routing, 'Pin for'), 'kind');
    choose(controlBy<HTMLSelectElement>(routing, 'Which'), 'review');
    buttonBy(routing, /^Pin$/).click();
    await flush();
    expect(ctx.transport.to('POST', '/routing/pins')[1]?.body).toMatchObject({ scope: 'kind', target: 'review' });
    // A task pin offers the open tasks of the board.
    choose(controlBy<HTMLSelectElement>(routing, 'Pin for'), 'task');
    expect(controlBy<HTMLSelectElement>(routing, 'Which').value).toBe('task_0000000000000000000000aa01');
    buttonBy(routing, 'Unpin the kind pin for docs').click();
    await flush();
    expect(ctx.transport.to('POST', '/routing/pins/pin1/revoke')).toHaveLength(1);
    expect(ctx.transport.to('GET', '/routing/pins').length).toBeGreaterThanOrEqual(2);
    d.destroy();
  });

  it('shows hostile pin text as text and says when the pins could not be read', async () => {
    const ctx = makeContext({
      answers: {
        'GET /models': MODELS,
        'GET /routing/pins': { pins: [{ ...PIN, scope: 'role', target: BIDI, model: HOSTILE, note: HOSTILE }] },
      },
    });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'routing' });
    await flush();
    expect(d.el.querySelector('img')).toBeNull();
    const text = section(d.el, 'Routing')?.textContent ?? '';
    expect(text).toContain(HOSTILE);
    expect(text).toContain('⟨U+202E⟩');
    expect(text).not.toContain('\u202E');
    d.destroy();
    const failing = settingsDrawer(
      makeContext({
        answers: {
          'GET /models': MODELS,
          'GET /routing/pins': () => {
            throw new Error('offline');
          },
        },
      }),
      { kind: 'settings' },
    );
    await flush();
    expect(failing.el.textContent).toContain('Could not read the pins: offline');
    failing.destroy();
  });

  // ---- Friday: the worktrees in use and their clean-up, log out, stop

  it('counts the worktrees in use and cleans up released ones with the palette’s prune', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        runs: {
          a: makeRun({ run_id: 'a', execution_root: 'C:/wt/a' }),
          b: makeRun({ run_id: 'b', execution_root: 'C:/wt/b' }),
        },
      }),
      answers: { 'POST /worktrees/prune': { removed: ['C:/wt/old'], kept: [{ path: 'C:/wt/b', reason: 'dirty' }] } },
    });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'friday' });
    const friday = section(d.el, 'Friday') as HTMLElement;
    expect(friday.textContent).toContain('Worktrees in use: 2');
    expect(section(d.el, 'About')?.textContent).toContain('Worktrees in use2');
    ctx.board(makeSnapshot({ runs: { a: makeRun({ run_id: 'a', execution_root: 'C:/wt/a' }) } }));
    expect(friday.textContent).toContain('Worktrees in use: 1');
    const clean = buttonBy(friday, 'Clean up released worktrees');
    clean.click();
    await flush();
    expect(ctx.transport.to('POST', '/worktrees/prune')).toHaveLength(1);
    expect(ctx.toasts.at(-1)).toMatchObject({
      kind: 'success',
      text: 'Removed 1 clean worktree; kept 1',
      detail: expect.stringContaining('Kept C:/wt/b: dirty'),
    });
    expect(clean.disabled).toBe(false);
    d.destroy();
  });

  it('logs out from the Friday section and reloads the page', async () => {
    const reload = vi.spyOn(pageActions, 'reload').mockImplementation(() => undefined);
    sessionStorage.setItem('friday.ui.session', '{"token":"t","expires_at":"2999-01-01T00:00:00Z","project_id":"p"}');
    const ctx = makeContext({ answers: { 'POST /ui/logout': { ok: true } } });
    const d = settingsDrawer(ctx, { kind: 'settings' });
    const friday = section(d.el, 'Friday') as HTMLElement;
    expect(friday.textContent).toContain('one-time link');
    buttonBy(friday, 'Log out').click();
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

  // ---- About: what left the header (the address, the folder) and the versions (M9k.3)

  it('shows the address, the folder and the versions in About, with 127.0.0.1', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ project: { ...makeSnapshot().project, name: HOSTILE } }) });
    const d = settingsDrawer(ctx, { kind: 'settings', tab: 'about' });
    const about = section(d.el, 'About') as HTMLElement;
    const text = about.textContent ?? '';
    expect(text).toContain('127.0.0.1:4310');
    expect(text).toContain('C:/demo/shop');
    expect(text).toContain(HOSTILE);
    expect(about.querySelector('img')).toBeNull();
    expect(text).toContain('0.0.0');
    expect(text).toContain(`${UI_VERSION} · API 1`);
    d.destroy();
  });
});
