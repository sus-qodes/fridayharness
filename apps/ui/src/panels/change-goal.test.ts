import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeGoal, makePlan, makeSnapshot } from '../test/fixtures.js';
import { changeGoalModal, replanToast } from './change-goal.js';
import { buttonBy, controlBy, flush, HOSTILE, type } from './test-support.js';

const GID = 'goal_0000000000000000000000gg01';

function open(o: { planner?: boolean; proposed?: boolean; active?: boolean; answers?: Record<string, unknown> } = {}) {
  const ctx = makeContext({
    snapshot: makeSnapshot({
      goals: [makeGoal({ status: 'ACTIVE', request: `Ship the checkout ${HOSTILE}` })],
      plans: {
        [GID]: {
          active: o.active === false ? null : makePlan(),
          proposed: o.proposed ? makePlan({ version: 2, status: 'PROPOSED' }) : null,
        },
      },
      brain: { planner_available: o.planner !== false, reason: null } as never,
    }),
    answers: o.answers ?? {},
  });
  let closed = 0;
  const m = changeGoalModal(ctx, { kind: 'change-goal', id: GID }, () => {
    closed += 1;
  });
  return { ctx, m, closed: () => closed };
}

describe('change this goal', () => {
  it('asks the planner for a new version from what the person wrote', async () => {
    const { ctx, m, closed } = open({ answers: { [`POST /goals/${GID}/replan`]: { result: 'proposed plan_1 v2' } } });
    expect(m.title).toBe('Change this goal');
    expect(m.el.textContent).toContain(`Goal: Ship the checkout ${HOSTILE}`);
    expect(m.el.querySelector('img')).toBeNull();
    // What happens to the work in hand is said before anything is asked.
    expect(m.el.textContent).toContain('you review before anything starts. Tasks that are finished stay as they are.');
    const ask = buttonBy(m.el, 'Ask the planner');
    expect(ask.disabled).toBe(true);
    type(controlBy<HTMLTextAreaElement>(m.el, 'What should be different?'), '  also test the empty cart  ');
    expect(ask.disabled).toBe(false);
    ask.click();
    expect(m.el.textContent).toContain('Asking the planner… (a model call can take a minute)');
    await flush();
    expect(ctx.transport.to('POST', `/goals/${GID}/replan`)[0]?.body).toEqual({ note: 'also test the empty cart' });
    expect(ctx.toasts.at(-1)).toEqual({
      kind: 'success',
      text: 'The planner proposed a change: review it on the board',
    });
    expect(ctx.refreshes).toBe(1);
    expect(closed()).toBe(1);
    m.destroy();
  });

  it('says so when the planner proposed nothing, and stays open with the error when it could not be asked', async () => {
    const none = open({ answers: { [`POST /goals/${GID}/replan`]: { result: 'skipped: the budget is spent' } } });
    type(controlBy<HTMLTextAreaElement>(none.m.el, 'What should be different?'), 'x');
    buttonBy(none.m.el, 'Ask the planner').click();
    await flush();
    expect(none.ctx.toasts.at(-1)).toEqual({
      kind: 'warn',
      text: 'The planner proposed no change',
      detail: 'skipped: the budget is spent',
    });
    none.m.destroy();
    const failing = open({
      answers: {
        [`POST /goals/${GID}/replan`]: () => {
          throw new Error(`offline ${HOSTILE}`);
        },
      },
    });
    type(controlBy<HTMLTextAreaElement>(failing.m.el, 'What should be different?'), 'x');
    buttonBy(failing.m.el, 'Ask the planner').click();
    await flush();
    expect(failing.m.el.querySelector('.pn-server-error')?.textContent).toBe(`offline ${HOSTILE}`);
    expect(failing.m.el.querySelector('img')).toBeNull();
    expect(failing.closed()).toBe(0);
    // What was typed is still there to send again.
    expect(controlBy<HTMLTextAreaElement>(failing.m.el, 'What should be different?').value).toBe('x');
    expect(buttonBy(failing.m.el, 'Ask the planner').disabled).toBe(false);
    failing.m.destroy();
  });

  it('opens the editor to write the change, which is the only way while no planner is ready', () => {
    const ready = open();
    buttonBy(ready.m.el, 'Write the change myself').click();
    expect(ready.ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: GID, mode: 'revision' });
    ready.m.destroy();
    const without = open({ planner: false });
    expect(buttonBy(without.m.el, 'Ask the planner').hidden).toBe(true);
    expect(without.m.el.textContent).toContain('No planner is ready, so the change is yours to write');
    expect(buttonBy(without.m.el, 'Write the change myself').classList.contains('btn-primary')).toBe(true);
    without.m.destroy();
  });

  it('says when a version already waits, and when there is nothing to change', () => {
    const waiting = open({ proposed: true });
    expect(waiting.m.el.textContent).toContain(
      'Version 2 is already proposed and waits for your review; a new one replaces it.',
    );
    waiting.m.destroy();
    const none = open({ active: false });
    expect(none.m.el.textContent).toContain('This goal has no running plan to change.');
    expect(none.m.el.querySelector('button')).toBeNull();
    none.m.destroy();
    const gone = changeGoalModal(makeContext(), { kind: 'change-goal', id: 'goal_missing' }, () => undefined);
    expect(gone.el.textContent).toContain('This goal is not on the board.');
    gone.destroy();
  });

  it('reads the planner’s answer as a toast', () => {
    expect(replanToast('proposed plan_1 v3 with 2 task(s)').kind).toBe('success');
    expect(replanToast(undefined)).toEqual({ kind: 'warn', text: 'The planner proposed no change' });
    expect(replanToast('x'.repeat(900)).detail?.length).toBeLessThanOrEqual(301);
  });
});
