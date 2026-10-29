import type { BrainStatusView } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    const restart = vi.fn(async () => undefined);
    (ctx as { platform: unknown }).platform = {
      kind: 'tauri',
      openInEditor: () => undefined,
      copy: async () => true,
      desktop: {
        shortcuts: async () => [
          { id: 'studio', accel: 'Ctrl+Alt+Shift+F', state: 'registered' },
          { id: 'notch', accel: 'Ctrl+Alt+Shift+N', state: 'in_use' },
        ],
        setShortcut,
        restart,
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
