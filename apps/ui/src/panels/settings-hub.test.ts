/**
 * The Settings Hub keeps what the Settings drawer offered: the desktop's native planner steps, the
 * daily budget and the config file in the Planner, the shortcuts by name with why one is not active,
 * and starting at sign-in that always shows the shell's answer.
 */
import type { BrainStatusView } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DesktopCommands, DesktopShortcut } from '../shell/context.js';
import { makeContext } from '../test/context.js';
import { makeRun, makeSnapshot } from '../test/fixtures.js';
import { mountSettingsHub } from './settings-hub.js';
import { buttonBy, flush, type } from './test-support.js';

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

/** A context on the desktop platform, its shell commands faked. */
function desktopContext(over: Partial<BrainStatusView> = {}, desktop: Partial<DesktopCommands> = {}) {
  const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain(over) }) });
  const opened: string[] = [];
  const shell = {
    shortcuts: async (): Promise<DesktopShortcut[]> => [],
    setShortcut: vi.fn(async () => [] as DesktopShortcut[]),
    restart: async () => true,
    storeKey: vi.fn(async () => true),
    allowSpending: vi.fn(async () => true),
    autostart: async () => false,
    setAutostart: vi.fn(async (on: boolean) => on),
    testNotification: async () => true,
    ...desktop,
  };
  (ctx as { platform: unknown }).platform = {
    kind: 'tauri',
    openInEditor: (p: string) => opened.push(p),
    copy: async () => true,
    requestNotifications: async () => 'granted',
    desktop: shell,
  };
  return { ctx, shell, opened };
}

function hubAt(ctx: ReturnType<typeof makeContext>, tab: string) {
  ctx.store.patch('ui', { settingsTab: tab });
  const hub = mountSettingsHub(ctx);
  document.body.append(hub.el);
  return hub;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('the Settings Hub, Planner', () => {
  it("offers the desktop's own dialogs, the daily budget and the config file while the planner is not ready", async () => {
    const { ctx, shell, opened } = desktopContext();
    const hub = hubAt(ctx, 'planner');
    const el = hub.el;
    expect(el.textContent).toContain('You can always write plans yourself');
    const budget = el.querySelector('input[type="number"]') as HTMLInputElement;
    type(budget, '7');
    expect(el.textContent).toContain('friday brain allow-remote --budget 7');
    buttonBy(el, 'Store the key…').click();
    await flush();
    expect(shell.storeKey).toHaveBeenCalledWith('anthropic');
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'The key is stored' });
    buttonBy(el, 'Allow spending up to $7.00 a day…').click();
    await flush();
    expect(shell.allowSpending).toHaveBeenCalledWith(7);
    buttonBy(el, 'Open config.yaml in VS Code').click();
    expect(opened.at(-1)).toMatch(/\.friday[\\/]config\.yaml$/);
    hub.destroy();
  });

  it('offers a planner on this machine no key, no spending and no budget', () => {
    const { ctx } = desktopContext({ provider: 'local', model: 'qwen2.5:7b', remote: false, key: 'not needed' });
    const hub = hubAt(ctx, 'planner');
    expect(() => buttonBy(hub.el, 'Store the key…')).toThrow();
    expect(hub.el.querySelector('input[type="number"]')).toBeNull();
    expect(hub.el.textContent).toContain('friday doctor');
    expect(hub.el.textContent).not.toContain('Allow spending');
    hub.destroy();
  });

  it("follows the planner's state: once it can plan, the steps go", () => {
    const { ctx } = desktopContext();
    const hub = hubAt(ctx, 'planner');
    expect(hub.el.textContent).toContain('Store the key…');
    const board = ctx.store.select('board');
    ctx.store.setState({ board: board && { ...board, brain: brain({ key: 'stored', planner_available: true }) } });
    expect(hub.el.textContent).not.toContain('Store the key…');
    expect(hub.el.textContent).toContain('ready');
    hub.destroy();
  });
});

describe('the Settings Hub, Desktop', () => {
  it('names each shortcut by what it does, says why one is not active, and redraws from the answer to Set', async () => {
    const setShortcut = vi.fn(
      async (): Promise<DesktopShortcut[]> => [
        { id: 'studio', accel: 'Ctrl+Alt+Shift+B', state: 'skipped', note: 'the keyboard layout types a letter' },
      ],
    );
    const { ctx } = desktopContext(
      {},
      {
        shortcuts: async () => [
          { id: 'studio', accel: 'Ctrl+Alt+Shift+F', state: 'registered' },
          { id: 'notch', accel: 'Ctrl+Alt+Shift+N', state: 'in_use' },
        ],
        setShortcut,
      },
    );
    const hub = hubAt(ctx, 'desktop');
    await flush();
    expect(hub.el.textContent).toContain('Show the Studio');
    expect(hub.el.textContent).toContain('Not active: in use');
    expect(hub.el.textContent).not.toContain('Not active: registered');
    const keys = hub.el.querySelector('input[aria-label="Keys for: Show the Studio"]') as HTMLInputElement;
    type(keys, 'Ctrl+Alt+Shift+B');
    buttonBy(hub.el, 'Set').click();
    await flush();
    expect(setShortcut).toHaveBeenCalledWith('studio', 'Ctrl+Alt+Shift+B');
    expect(hub.el.textContent).toContain('Not active: skipped. the keyboard layout types a letter');
    hub.destroy();
  });

  it('shows the shell’s answer for starting at sign-in, and puts a refused change back', async () => {
    let answer: boolean | Error = true;
    const { ctx } = desktopContext(
      {},
      {
        autostart: async () => false,
        setAutostart: vi.fn(async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        }),
      },
    );
    const hub = hubAt(ctx, 'desktop');
    const box = [...hub.el.querySelectorAll('input[type="checkbox"]')].at(-1) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    await flush();
    expect(box.disabled).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(box.checked).toBe(true);
    expect(ctx.toasts.at(-1)?.text).toBe('Friday starts when you sign in to Windows');
    answer = new Error('refused');
    box.checked = false;
    box.dispatchEvent(new Event('change'));
    await flush();
    expect(box.checked).toBe(true);
    hub.destroy();
  });

  it('says so when the desktop app does not answer whether it starts at sign-in', async () => {
    const { ctx } = desktopContext(
      {},
      {
        autostart: async () => {
          throw new Error('no answer');
        },
      },
    );
    const hub = hubAt(ctx, 'desktop');
    await flush();
    expect(hub.el.textContent).toContain('The desktop app did not say whether it starts when you sign in.');
    hub.destroy();
  });
});

describe('the Settings Hub, Policy and Friday', () => {
  it('names exactly what is trusted, with its hash, before trusting it', async () => {
    const policy = {
      policy: {
        version: 'v1',
        loosening: [{ source: '.friday/policy.yaml', setting: 'autonomy.git.push', from: 'manual', to: 'auto' }],
        loosening_hash: 'abc123def4567890',
        trusted: false,
      },
    };
    const ctx = makeContext({
      answers: { 'GET /policy': policy, 'POST /policy/trust': { policy: { ...policy.policy, trusted: true } } },
    });
    ctx.confirmAnswer = true;
    const hub = hubAt(ctx, 'policy');
    await flush();
    buttonBy(hub.el, 'Trust this list').click();
    await flush();
    expect(ctx.confirms.at(-1)?.body).toEqual([
      'autonomy.git.push: manual → auto (.friday/policy.yaml)',
      expect.stringContaining('exactly this list (hash abc123def4567890)'),
    ]);
    hub.destroy();
  });

  it('says how to start Friday again before stopping it, and follows the worktrees in use', async () => {
    const ctx = makeContext();
    ctx.confirmAnswer = false;
    const hub = hubAt(ctx, 'friday');
    expect(hub.el.textContent).toContain('Active Worktrees (0)');
    buttonBy(hub.el, 'Stop Friday').click();
    await flush();
    expect(ctx.confirms.at(-1)?.body).toContain(
      'Work in worktrees is kept. Start it again from its shortcut, the desktop app, or friday run.',
    );
    const board = ctx.store.select('board');
    ctx.store.setState({
      board: board && {
        ...board,
        runs: { r1: makeRun({ run_id: 'r1', status: 'ACTIVE', workspace: 'ready', execution_root: 'C:/wt/a' }) },
      },
    });
    expect(hub.el.textContent).toContain('Active Worktrees (1)');
    hub.destroy();
  });
});
