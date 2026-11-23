import type { BrainStatusView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { Registry } from '../shell/context.js';
import { makeContext } from '../test/context.js';
import { makeHarness, makeSnapshot } from '../test/fixtures.js';
import { checklist, gettingStarted } from './getting-started.js';
import { registerPanels } from './index.js';
import { buttonBy } from './test-support.js';

const brain = (over: Partial<BrainStatusView> = {}): BrainStatusView =>
  ({
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    remote: true,
    allow_remote: true,
    approved_here: true,
    key: 'stored',
    planner_available: true,
    reason: null,
    ...over,
  }) as BrainStatusView;

describe('getting started', () => {
  it('lists every item from the board', () => {
    const items = checklist(
      makeSnapshot({
        brain: brain({ planner_available: false, approved_here: false }),
        verification: { checks: [], auto_on_completion: false },
        project: { ...makeSnapshot().project, has_commit: false },
      }),
    );
    // What there is to do; "Friday is running" no longer stands first, always ticked (2026-11-17).
    expect(items.map((i) => [i.id, i.done])).toEqual([
      ['agent', false],
      ['planner', false],
      ['checks', false],
      ['commit', false],
      ['notify', false],
    ]);
    expect(items[1]?.detail).toBe(
      'To let Friday plan: allow planning to spend on this computer. You can always write plans yourself.',
    );
    expect(items[2]?.detail).toMatch(/Verification runs only Friday's own checks/);
    // The way to fix it is the page that suggests them, not a file to write by hand (2026-11-17).
    expect(items[2]?.fix).toEqual({ label: 'Settings → Checks', action: 'checks' });
    expect(items[3]?.detail).toMatch(/every agent works in your own project folder instead of a folder of its task/i);
  });

  it('counts only harnesses that are not terminated', () => {
    expect(checklist(makeSnapshot({ harnesses: [makeHarness({ status: 'TERMINATED' })] }))[0]?.done).toBe(false);
    // A session that left, or is trying to come back, is not a connected agent.
    for (const status of ['DISCONNECTED', 'RECONNECTING'] as const) {
      expect(checklist(makeSnapshot({ harnesses: [makeHarness({ status })] }))[0]?.done, status).toBe(false);
    }
    for (const status of ['REGISTERED', 'READY', 'BUSY'] as const) {
      expect(checklist(makeSnapshot({ harnesses: [makeHarness({ status })] }))[0]?.done, status).toBe(true);
    }
    expect(checklist(makeSnapshot({ harnesses: [makeHarness(), makeHarness({ harness_id: 'h2' })] }))[0]?.title).toBe(
      '2 agents are connected',
    );
    expect(checklist(makeSnapshot({ brain: brain() }))[1]?.done).toBe(true);
    expect(checklist(makeSnapshot({ brain: null }))[1]?.detail).toMatch(/not running/);
  });

  it('asks to be notified while the tab is hidden, in the words of the platform that notifies', () => {
    const off = checklist(makeSnapshot()).find((i) => i.id === 'notify');
    expect(off).toMatchObject({
      done: false,
      title: 'Get notified while this tab is hidden',
      fix: { label: 'Settings → Notifications', action: 'notifications' },
    });
    expect(off?.detail).toMatch(/approvals, questions, plans, blocked agents and failures while this tab is hidden/);
    const on = checklist(makeSnapshot(), { notifications: true }).find((i) => i.id === 'notify');
    expect(on).toMatchObject({ done: true, title: 'You are notified while this tab is hidden' });
    const desktop = checklist(makeSnapshot(), { native: true }).find((i) => i.id === 'notify');
    expect(desktop?.title).toBe('Get notified while the Notch is hidden or the screen is locked');
  });

  it('asks to trust the project’s policy only while its loosening is not trusted', () => {
    expect(checklist(makeSnapshot()).some((i) => i.id === 'policy')).toBe(false);
    const items = checklist(makeSnapshot({ policy_untrusted: true }));
    expect(items.map((i) => i.id)).toEqual(['policy', 'agent', 'planner', 'checks', 'commit', 'notify']);
    expect(items[0]).toMatchObject({
      done: false,
      title: 'Trust this project’s settings',
      fix: { label: 'Settings → Permissions', action: 'policy' },
    });
    expect(items[0]?.detail).toMatch(/None of it applies on this computer until you trust it/);
  });

  it('links each open item to where to fix it, and dismisses', () => {
    const opened: string[] = [];
    const ctx = makeContext({
      snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false }, policy_untrusted: true }),
    });
    (ctx.platform as { openInEditor: (p: string) => void }).openInEditor = (p) => opened.push(p);
    const c = gettingStarted(ctx);
    expect(c.el.hidden).toBe(false);
    expect(c.el.textContent).toContain('5 of 6 to do');
    buttonBy(c.el, 'Open Agents').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents' });
    buttonBy(c.el, 'Settings → Planner').click();
    expect(ctx.store.select('ui')).toMatchObject({ activeView: 'settings', settingsTab: 'planner', drawer: null });
    buttonBy(c.el, 'Settings → Notifications').click();
    expect(ctx.store.select('ui')).toMatchObject({
      activeView: 'settings',
      settingsTab: 'notifications',
      drawer: null,
    });
    buttonBy(c.el, 'Settings → Permissions').click();
    expect(ctx.store.select('ui')).toMatchObject({ activeView: 'settings', settingsTab: 'policy', drawer: null });
    buttonBy(c.el, 'Settings → Checks').click();
    expect(ctx.store.select('ui')).toMatchObject({ activeView: 'settings', settingsTab: 'checks', drawer: null });
    expect(opened).toEqual([]);
    // Trusted, connected, planning, notifying: all set, and the policy item is gone.
    ctx.board(makeSnapshot({ harnesses: [makeHarness()], brain: brain() }));
    ctx.store.patch('prefs', { notifications: true });
    expect(c.el.querySelector('[data-item="policy"]')).toBeNull();
    expect(c.el.textContent).toContain('All set.');
    buttonBy(c.el, 'Dismiss').click();
    expect(ctx.store.select('prefs').gettingStartedDismissed).toBe(true);
    expect(c.el.hidden).toBe(true);
    c.destroy();
  });
});

describe('registerPanels', () => {
  it('registers the modals and drawers of this area', () => {
    const ctx = makeContext();
    const registry = new Registry();
    registerPanels({ ...ctx, registry });
    expect([...registry.modals.keys()].sort()).toEqual([
      'answer',
      'antigravity-setup',
      'change-goal',
      'claude-setup',
      'edit-agent',
      'land',
      'new-goal',
      'plan-editor',
      'raise-limit',
      'start-agent',
      'verify',
    ]);
    // Settings is a view of its own, not a drawer.
    expect([...registry.drawers.keys()].sort()).toEqual(['agents']);
  });
});
