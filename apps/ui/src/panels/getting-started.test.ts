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
    expect(items.map((i) => [i.id, i.done])).toEqual([
      ['running', true],
      ['agent', false],
      ['planner', false],
      ['checks', false],
      ['commit', false],
    ]);
    expect(items[2]?.detail).toBe('To let it plan: allow this clone to spend. You can always write plans yourself.');
    expect(items[3]?.detail).toMatch(/Verification will run Friday's scope and credential checks only/);
    expect(items[4]?.detail).toMatch(/every agent works in the main checkout until you commit once/i);
  });

  it('counts only harnesses that are not terminated', () => {
    expect(checklist(makeSnapshot({ harnesses: [makeHarness({ status: 'TERMINATED' })] }))[1]?.done).toBe(false);
    expect(checklist(makeSnapshot({ harnesses: [makeHarness(), makeHarness({ harness_id: 'h2' })] }))[1]?.title).toBe(
      '2 agents are connected',
    );
    expect(checklist(makeSnapshot({ brain: brain() }))[2]?.done).toBe(true);
    expect(checklist(makeSnapshot({ brain: null }))[2]?.detail).toMatch(/not running/);
  });

  it('links each open item to where to fix it, and dismisses', () => {
    const opened: string[] = [];
    const ctx = makeContext({ snapshot: makeSnapshot({ verification: { checks: [], auto_on_completion: false } }) });
    (ctx.platform as { openInEditor: (p: string) => void }).openInEditor = (p) => opened.push(p);
    const c = gettingStarted(ctx);
    expect(c.el.hidden).toBe(false);
    expect(c.el.textContent).toContain('3 of 5 to do');
    buttonBy(c.el, 'Open Agents').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'agents' });
    buttonBy(c.el, 'Settings → Planner').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'planner' });
    buttonBy(c.el, 'Open config.yaml').click();
    expect(opened).toEqual(['C:/demo/shop/.friday/config.yaml']);
    ctx.board(makeSnapshot({ harnesses: [makeHarness()], brain: brain() }));
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
      'claude-setup',
      'land',
      'new-goal',
      'plan-editor',
      'start-agent',
      'verify',
    ]);
    expect([...registry.drawers.keys()].sort()).toEqual(['agents', 'settings']);
  });
});
