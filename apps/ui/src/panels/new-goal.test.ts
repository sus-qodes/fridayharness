import type { BrainStatusView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeGoal, makeSnapshot } from '../test/fixtures.js';
import { goalBody, goalFormState, newGoalModal } from './new-goal.js';
import { buttonBy, flush, HOSTILE, type } from './test-support.js';

function brain(over: Partial<BrainStatusView> = {}): BrainStatusView {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-5',
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
    daily_budget_usd: 5,
    spent_today_usd: 0,
    cursor: 0,
    head: 0,
    ...over,
  };
}

const form = (request: string, over = {}) => ({
  request,
  constraints: [],
  outcomes: [],
  priority: 'normal' as const,
  ...over,
});

describe('new goal enabling rules', () => {
  it('needs a request of 3 to 4000 characters', () => {
    expect(goalFormState(form('ab'), brain()).valid).toBe(false);
    expect(goalFormState(form('   abc  '), brain()).valid).toBe(true);
    expect(goalFormState(form('x'.repeat(4001)), brain()).errors.request).toMatch(/4000/);
  });

  it('lets the Master Brain plan only when the planner is ready', () => {
    expect(goalFormState(form('Add billing'), brain()).canPlan).toBe(true);
    const off = goalFormState(
      form('Add billing'),
      brain({ planner_available: false, key: 'missing', reason: 'no key: run "friday secrets set"' }),
    );
    expect(off.canPlan).toBe(false);
    expect(off.valid).toBe(true);
    expect(off.plannerText).toBe('Friday cannot write plans yet: store your API key.');
    expect(goalFormState(form('Add billing'), null).plannerText).toMatch(/not running/);
    expect(goalFormState(form('ab'), brain()).canPlan).toBe(false);
  });

  it('turns the planner reasons into interface words', () => {
    const text = (b: Partial<BrainStatusView>) =>
      goalFormState(form('Add billing'), brain({ planner_available: false, ...b })).plannerText;
    expect(text({ approved_here: false })).toBe(
      'Friday cannot write plans yet: allow planning to spend on this computer.',
    );
    expect(text({ allow_remote: false })).toBe('Friday cannot write plans yet: allow it for this project.');
    expect(text({ key: 'missing', approved_here: false, allow_remote: false })).toMatch(
      /store your API key; allow planning to spend on this computer; allow it for this project/,
    );
    expect(text({ remote: false, reason: 'the provider "none" cannot plan' })).toBe(
      'Friday cannot write plans: the provider "none" cannot plan.',
    );
  });

  /**
   * Nobody chose a planner on this computer and the project's own is not ready (2026-11-23): the
   * steps of an Anthropic key were named to people who have Codex, another key, or nothing yet.
   */
  it('says to choose who writes the plans, where nobody chose yet', () => {
    const fresh = goalFormState(
      form('Add billing'),
      brain({
        planner_available: false,
        key: 'missing',
        approved_here: false,
        allow_remote: false,
        planners: [],
        choice: { here: null, project: 'anthropic', wanted: 'anthropic' },
      }),
    );
    expect(fresh.plannerText).toBe(
      'Friday cannot write plans yet: choose who writes your plans (Claude Code, Codex, a key of your own, or a model on this computer).',
    );
    // A person who chose one is told its own next step, as before.
    const chosen = goalFormState(
      form('Add billing'),
      brain({
        planner_available: false,
        key: 'missing',
        planners: [],
        choice: { here: 'anthropic', project: 'anthropic', wanted: 'anthropic' },
      }),
    );
    expect(chosen.plannerText).toBe('Friday cannot write plans yet: store your API key.');
  });

  it('limits constraints and outcomes and drops empty lines from the body', () => {
    expect(
      goalFormState(form('Add billing', { constraints: Array(13).fill('c') }), brain()).errors.constraints,
    ).toMatch(/12/);
    expect(goalFormState(form('Add billing', { outcomes: ['y'.repeat(301)] }), brain()).errors.outcomes).toMatch(/300/);
    expect(goalBody(form(' Add billing ', { constraints: [' keep checkout ', ''], outcomes: ['  '] }), false)).toEqual({
      request: 'Add billing',
      constraints: ['keep checkout'],
      outcomes: [],
      priority: 'normal',
      plan: false,
    });
  });
});

describe('new goal modal', () => {
  it('disables "Let Friday plan" without a planner and links to Settings → Planner', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain({ planner_available: false, key: 'missing' }) }) });
    const m = newGoalModal(ctx, { kind: 'new-goal' }, () => undefined);
    type(m.el.querySelector('textarea') as HTMLTextAreaElement, 'Add billing');
    expect(buttonBy(m.el, 'Let Friday plan').disabled).toBe(true);
    expect(buttonBy(m.el, 'Write the plan myself').disabled).toBe(false);
    expect(m.el.textContent).toContain('store your API key');
    expect(m.el.textContent).toContain('You can always write the plan yourself');
    buttonBy(m.el, 'Settings → Planner').click();
    expect(ctx.store.select('ui')).toMatchObject({ activeView: 'settings', settingsTab: 'planner', drawer: null });
    m.destroy();
  });

  it('creates a planned goal and closes', async () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ brain: brain() }), answers: { 'POST /goals': makeGoal() } });
    let closed = 0;
    const m = newGoalModal(ctx, { kind: 'new-goal' }, () => {
      closed += 1;
    });
    const plan = buttonBy(m.el, 'Let Friday plan');
    expect(plan.disabled).toBe(true);
    type(m.el.querySelector('textarea') as HTMLTextAreaElement, 'Add billing');
    buttonBy(m.el, 'Add constraint').click();
    type(m.el.querySelector('.pn-lines input') as HTMLInputElement, 'keep checkout');
    expect(plan.disabled).toBe(false);
    plan.click();
    await flush();
    const call = ctx.transport.to('POST', '/goals')[0];
    expect(call?.body).toEqual({
      request: 'Add billing',
      constraints: ['keep checkout'],
      outcomes: [],
      priority: 'normal',
      plan: true,
    });
    expect(call?.opts?.idempotencyKey).toBeTruthy();
    expect(closed).toBe(1);
    expect(ctx.refreshes).toBe(1);
    m.destroy();
  });

  it('"Write the plan myself" creates the goal without a plan and opens the plan editor', async () => {
    const goal = makeGoal({ goal_id: 'goal_new' });
    const ctx = makeContext({ answers: { 'POST /goals': goal } });
    const m = newGoalModal(ctx, { kind: 'new-goal' }, () => undefined);
    type(m.el.querySelector('textarea') as HTMLTextAreaElement, `Fix ${HOSTILE}`);
    buttonBy(m.el, 'Write the plan myself').click();
    await flush();
    expect(ctx.transport.to('POST', '/goals')[0]?.body).toMatchObject({ plan: false });
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: 'goal_new', mode: 'first' });
    expect(m.el.querySelector('img')).toBeNull();
    m.destroy();
  });

  it('keeps the form open when the daemon refuses', async () => {
    const ctx = makeContext({
      answers: {
        'POST /goals': () => {
          throw new Error('COS-1000 invalid');
        },
      },
    });
    let closed = false;
    const m = newGoalModal(ctx, { kind: 'new-goal' }, () => {
      closed = true;
    });
    type(m.el.querySelector('textarea') as HTMLTextAreaElement, 'Add billing');
    buttonBy(m.el, 'Write the plan myself').click();
    await flush();
    expect(closed).toBe(false);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Create the goal' });
    expect(buttonBy(m.el, 'Write the plan myself').disabled).toBe(false);
    m.destroy();
  });
});

describe('a question, or one task, from the dialog (2026-11-18)', () => {
  it('offers both without a planner, and sends each as its own mode, with no plan editor', async () => {
    for (const [label, mode, toast] of [
      ['Just answer this', 'ask', 'Asked: the answer appears here when it is ready'],
      ['Do it now, one agent', 'do', 'Started: one agent takes it now'],
    ] as const) {
      const ctx = makeContext({
        snapshot: makeSnapshot({ brain: brain({ planner_available: false, key: 'missing' }) }),
        answers: { 'POST /goals': makeGoal() },
      });
      let closed = 0;
      const m = newGoalModal(ctx, { kind: 'new-goal' }, () => {
        closed += 1;
      });
      expect(buttonBy(m.el, label).disabled).toBe(true);
      type(m.el.querySelector('textarea') as HTMLTextAreaElement, 'How does checkout work?');
      expect(buttonBy(m.el, label).disabled).toBe(false);
      buttonBy(m.el, label).click();
      await flush();
      expect(ctx.transport.to('POST', '/goals')[0]?.body).toEqual({
        request: 'How does checkout work?',
        constraints: [],
        outcomes: [],
        priority: 'normal',
        plan: false,
        mode,
      });
      expect(ctx.toasts.at(-1)?.text).toBe(toast);
      expect(closed).toBe(1);
      expect(ctx.store.select('ui').modal?.kind).not.toBe('plan-editor');
      m.destroy();
    }
  });

  it('keeps a planned goal as it was: no mode is sent', () => {
    expect(goalBody({ request: ' Add billing ', constraints: [], outcomes: [], priority: 'normal' }, true)).toEqual({
      request: 'Add billing',
      constraints: [],
      outcomes: [],
      priority: 'normal',
      plan: true,
    });
    expect(
      goalBody({ request: 'x y z', constraints: [], outcomes: [], priority: 'normal' }, true, 'ask'),
    ).toMatchObject({
      plan: false,
      mode: 'ask',
    });
  });
});
