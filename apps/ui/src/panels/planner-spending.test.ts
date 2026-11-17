/**
 * What planning may spend, after it was allowed: the limit that holds, a new limit through the
 * desktop's own dialog, the project's limit said and raised, and spending turned off.
 */
import type { BrainStatusView } from '@friday/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopCommands } from '../shell/context.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { Teardown } from './common.js';
import { limitInForce, plannerSpendingCard, type Spending } from './planner-spending.js';
import { buttonBy, flush, type } from './test-support.js';

const spending = (over: Partial<Spending> = {}): Spending => ({
  provider: 'anthropic',
  approved: true,
  yours_usd: 2,
  project_usd: 5,
  ...over,
});

const brain = (over: Partial<BrainStatusView> = {}): BrainStatusView => ({
  provider: 'anthropic',
  model: 'claude-opus-5-5',
  remote: true,
  allow_remote: true,
  approved_here: true,
  endpoint: null,
  ignored_base_url: null,
  key: 'stored',
  planner_available: true,
  reason: null,
  auto_approve: false,
  escalate_after_failures: 2,
  max_replans: 3,
  daily_budget_usd: 2,
  spent_today_usd: 0.4,
  cursor: 0,
  head: 0,
  spending: spending(),
  ...over,
});

function onDesktop(ctx: ReturnType<typeof makeContext>, over: Partial<DesktopCommands> = {}) {
  const shell = {
    shortcuts: async () => [],
    setShortcut: async () => [],
    restart: vi.fn(async () => true),
    storeKey: async () => true,
    allowSpending: vi.fn(async () => true),
    autostart: async () => false,
    setAutostart: async (on: boolean) => on,
    testNotification: async () => true,
    ...over,
  };
  (ctx as { platform: unknown }).platform = { ...ctx.platform, kind: 'tauri', desktop: shell };
  return shell;
}

function mount(b: BrainStatusView, desktop = true, over: Partial<DesktopCommands> = {}) {
  const ctx = makeContext({ snapshot: makeSnapshot({ brain: b }) });
  const shell = desktop ? onDesktop(ctx, over) : null;
  const td = new Teardown();
  const el = plannerSpendingCard(ctx, td, b);
  return { ctx, shell, td, el: el as HTMLElement };
}

const sent = (ctx: ReturnType<typeof makeContext>, path: string) => ctx.transport.to('POST', path).map((c) => c.body);

describe('the limit that holds', () => {
  it('is the lower of this computer’s and the project’s', () => {
    expect(limitInForce(spending({ yours_usd: 2, project_usd: 5 }))).toBe(2);
    expect(limitInForce(spending({ yours_usd: 20, project_usd: 5 }))).toBe(5);
    expect(limitInForce(spending({ yours_usd: null, project_usd: 5 }))).toBe(5);
  });
});

describe('what planning may spend (2026-11-17)', () => {
  it('is no card where nothing spends, or where spending was not allowed here yet', () => {
    const td = new Teardown();
    const ctx = makeContext();
    expect(plannerSpendingCard(ctx, td, null)).toBeNull();
    expect(plannerSpendingCard(ctx, td, brain({ spending: undefined }))).toBeNull();
    expect(plannerSpendingCard(ctx, td, brain({ spending: spending({ approved: false }) }))).toBeNull();
    // A model on this machine, or plans written by hand: nothing is spent.
    expect(plannerSpendingCard(ctx, td, brain({ remote: false }))).toBeNull();
    expect(plannerSpendingCard(ctx, td, brain({ spending: spending({ provider: 'local' }) }))).toBeNull();
  });

  it('says the limit that holds, whose spending it is, and what was spent today', () => {
    const { el, td } = mount(brain());
    expect(el.querySelector('[data-role="limit"]')?.textContent).toBe(
      'Up to $2.00 a day with your Anthropic key, on this computer.',
    );
    expect((el.querySelector('input') as HTMLInputElement).value).toBe('2');
    td.run();
    const cc = mount(
      brain({ provider: 'claude-code', spending: spending({ provider: 'claude-code', yours_usd: 20 }) }),
    );
    expect(cc.el.textContent).toContain('Up to $5.00 a day through your Claude Code sign-in');
    expect(cc.el.textContent).toContain('You allowed $20.00; the project’s own limit of $5.00 holds.');
    cc.td.run();
  });

  it('changes the limit through the desktop’s own dialog, for the planner that spends', async () => {
    const { el, ctx, shell, td } = mount(brain());
    // Nothing to change while the amount is the one allowed.
    expect(buttonBy(el, 'Change the limit').disabled).toBe(true);
    type(el.querySelector('input') as HTMLInputElement, '4');
    expect(buttonBy(el, 'Change the limit').disabled).toBe(false);
    buttonBy(el, 'Change the limit').click();
    await flush();
    expect(shell?.allowSpending).toHaveBeenCalledWith(4, 'anthropic');
    expect(ctx.toasts.at(-1)).toEqual({
      kind: 'success',
      text: 'Planning may spend up to $4.00 a day on this computer',
    });
    expect(ctx.refreshes).toBe(1);
    // Nothing of it goes through the daemon: allowing is this computer's own act.
    expect(ctx.transport.calls.filter((c) => c.method === 'POST')).toEqual([]);
    td.run();
  });

  it('says nothing when the dialog is cancelled', async () => {
    const { el, ctx, td } = mount(brain(), true, { allowSpending: vi.fn(async () => false) });
    type(el.querySelector('input') as HTMLInputElement, '4');
    buttonBy(el, 'Change the limit').click();
    await flush();
    expect(ctx.toasts).toEqual([]);
    expect(ctx.refreshes).toBe(0);
    td.run();
  });

  it('says that the project’s limit holds when more is asked, and raises it only when asked to', async () => {
    const { el, ctx, shell, td } = mount(brain());
    expect(el.querySelector('[data-role="project-limit"]')).toBeNull();
    type(el.querySelector('input') as HTMLInputElement, '20');
    const over = el.querySelector('[data-role="project-limit"]') as HTMLElement;
    expect(over.textContent).toContain('The project’s own limit is $5.00 a day: Friday holds planning to that');
    buttonBy(el, 'Change the limit').click();
    await flush();
    expect(ctx.toasts.at(-1)).toEqual({
      kind: 'success',
      text: 'You allow $20.00 a day; the project’s limit of $5.00 holds',
    });
    expect(sent(ctx, '/config/settings')).toEqual([]);
    // Raising the project's is the team's setting: asked, written, and read at a restart.
    buttonBy(el, 'Raise the project’s limit to $20.00').click();
    await flush();
    expect(ctx.confirms.at(-1)?.title).toBe('Raise the project’s limit to $20.00 a day?');
    expect([ctx.confirms.at(-1)?.body].flat().join(' ')).toContain('which your team shares');
    expect(sent(ctx, '/config/settings')).toEqual([{ set: { 'providers.anthropic.daily_budget_usd': 20 } }]);
    expect(shell?.restart).toHaveBeenCalledOnce();
    td.run();
  });

  it('leaves the project’s limit alone when the person says no', async () => {
    const { el, ctx, shell, td } = mount(brain());
    ctx.confirmAnswer = false;
    type(el.querySelector('input') as HTMLInputElement, '9');
    buttonBy(el, 'Raise the project’s limit to $9.00').click();
    await flush();
    expect(sent(ctx, '/config/settings')).toEqual([]);
    expect(shell?.restart).not.toHaveBeenCalled();
    td.run();
  });

  it('turns spending off after a confirmation that says what stops', async () => {
    const b = brain({ provider: 'claude-code', spending: spending({ provider: 'claude-code' }) });
    const { el, ctx, td } = mount(b);
    ctx.confirmAnswer = false;
    buttonBy(el, 'Turn spending off').click();
    await flush();
    expect(sent(ctx, '/brain/deny-remote')).toEqual([]);
    ctx.confirmAnswer = true;
    buttonBy(el, 'Turn spending off').click();
    await flush();
    expect(ctx.confirms.at(-1)?.body[0]).toContain('Friday stops planning through your Claude Code sign-in');
    expect(sent(ctx, '/brain/deny-remote')).toEqual([{ provider: 'claude-code' }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Planning may no longer spend on this computer' });
    expect(ctx.refreshes).toBe(1);
    td.run();
  });

  it('in a browser gives the command for a new limit, and still turns spending off', async () => {
    const { el, ctx, td } = mount(brain(), false);
    expect(buttonBy(el, 'Change the limit').hidden).toBe(true);
    type(el.querySelector('input') as HTMLInputElement, '3');
    expect(el.querySelector('.pn-spend-terminal')?.textContent).toContain(
      'friday brain allow-remote --provider anthropic --budget 3',
    );
    buttonBy(el, 'Turn spending off').click();
    await flush();
    expect(sent(ctx, '/brain/deny-remote')).toEqual([{ provider: 'anthropic' }]);
    td.run();
  });
});
