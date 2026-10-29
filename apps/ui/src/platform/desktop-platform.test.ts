import { describe, expect, it, vi } from 'vitest';
import { DIALOG_CANCELLED, desktopPlatform, TEST_BODY, TEST_TITLE } from './desktop-platform.js';
import type { TauriCore } from './tauri-transport.js';
import { ApiError } from './transport.js';

/** A shell refusal as the Rust core sends it (`{status, body}`). */
function refusal(status: number, code: string, message: string) {
  return { status, body: { error: { code, name: 'error', message, retryable: false } } };
}

/** The desktop platform over a fake shell answering each command from `answers` (a function may throw). */
function shell(answers: Record<string, (args?: Record<string, unknown>) => unknown> = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const core: Pick<TauriCore, 'invoke'> = {
    invoke: (async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, ...(args ? { args } : {}) });
      const answer = answers[cmd];
      return answer ? answer(args) : null;
    }) as TauriCore['invoke'],
  };
  const platform = desktopPlatform(core, { writeText: async () => undefined });
  const desktop = platform.desktop;
  if (!desktop) throw new Error('the desktop platform offers its commands');
  return { platform, desktop, calls };
}

describe('desktopPlatform', () => {
  it('lets the shell notify, whatever the webview’s own Notification API says (deep review R8)', async () => {
    vi.stubGlobal('Notification', undefined);
    try {
      const { platform, calls } = shell();
      expect(platform.kind).toBe('tauri');
      expect(await platform.requestNotifications()).toBe('granted');
      expect(calls).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('stores a key by its provider name only, and allows spending with the budget (deep review R9)', async () => {
    const { desktop, calls } = shell({
      store_key: (args) => ({ name: args?.name, stored: true, protection: 'dpapi', endpoint: null }),
      allow_spending: () => ({ ok: true }),
    });
    expect(await desktop.storeKey('anthropic')).toBe(true);
    expect(await desktop.allowSpending(12.5)).toBe(true);
    expect(calls).toEqual([
      { cmd: 'store_key', args: { name: 'anthropic' } },
      { cmd: 'allow_spending', args: { budget: 12.5 } },
    ]);
  });

  it('answers false when the human cancels the native dialog, and passes other refusals on as errors', async () => {
    const cancelled = refusal(400, DIALOG_CANCELLED, 'you cancelled it in the confirmation dialog');
    const { desktop } = shell({
      store_key: () => {
        throw cancelled;
      },
      allow_spending: () => {
        throw refusal(500, 'DESKTOP-2006', 'the key was not stored: no install');
      },
    });
    expect(await desktop.storeKey('anthropic')).toBe(false);
    const failed = await desktop.allowSpending(5).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(ApiError);
    expect(failed).toMatchObject({ status: 500, code: 'DESKTOP-2006', message: 'the key was not stored: no install' });
  });

  it('reads and sets starting at sign-in (deep review R11)', async () => {
    let on = false;
    const { desktop, calls } = shell({
      get_autostart: () => on,
      set_autostart: (args) => {
        on = args?.enabled === true;
        return on;
      },
    });
    expect(await desktop.autostart()).toBe(false);
    expect(await desktop.setAutostart(true)).toBe(true);
    expect(await desktop.autostart()).toBe(true);
    expect(await desktop.setAutostart(false)).toBe(false);
    expect(calls).toEqual([
      { cmd: 'get_autostart' },
      { cmd: 'set_autostart', args: { enabled: true } },
      { cmd: 'get_autostart' },
      { cmd: 'set_autostart', args: { enabled: false } },
    ]);
  });

  it('restarts Friday, answering false when the human cancels the native confirmation', async () => {
    let refuse: unknown = null;
    const { desktop, calls } = shell({
      restart_daemon: () => {
        if (refuse) throw refuse;
        return null;
      },
    });
    expect(await desktop.restart()).toBe(true);
    refuse = refusal(400, DIALOG_CANCELLED, 'you cancelled it in the confirmation dialog');
    expect(await desktop.restart()).toBe(false);
    refuse = { status: 0, body: { error: { code: 'DESKTOP-2000', name: 'offline', message: 'Friday did not start' } } };
    await expect(desktop.restart()).rejects.toThrow('Friday did not start');
    expect(calls.map((c) => c.cmd)).toEqual(['restart_daemon', 'restart_daemon', 'restart_daemon']);
  });

  it('sends a test notification and answers whether Windows took it', async () => {
    let taken = true;
    const { desktop, calls } = shell({ notify: () => taken });
    expect(await desktop.testNotification()).toBe(true);
    taken = false;
    expect(await desktop.testNotification()).toBe(false);
    expect(calls).toEqual([
      { cmd: 'notify', args: { title: TEST_TITLE, body: TEST_BODY, test: true } },
      { cmd: 'notify', args: { title: TEST_TITLE, body: TEST_BODY, test: true } },
    ]);
  });

  it('turns any shell refusal into Friday’s error, so a toast can say what failed', async () => {
    const { desktop } = shell({
      set_shortcut: () => {
        throw refusal(400, 'DESKTOP-1007', 'not a shortcut');
      },
    });
    await expect(desktop.setShortcut('studio', 'B')).rejects.toMatchObject({
      code: 'DESKTOP-1007',
      message: 'not a shortcut',
    });
  });
});
