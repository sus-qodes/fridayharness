import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeGoal, makePlan, makePlanTask, makeSnapshot } from '../test/fixtures.js';
import { planReview, readPlanDiff } from './plan-review.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const GOAL = 'goal_0000000000000000000000gg01';
const PLAN = 'plan_0000000000000000000000pp01';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function arm(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5, movementX: 1 }));
  vi.advanceTimersByTime(700);
}

function buttonNamed(root: Element, name: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

describe('plan review', () => {
  let ctx: TestContext;
  let closed: number;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    closed = 0;
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const proposed = makePlan({
    version: 2,
    status: 'PROPOSED',
    summary: `Split the API ${HOSTILE}`,
    proposed_by: { kind: 'master_brain', id: 'master-brain' },
    tasks: [
      makePlanTask({ key: 'api', change: 'keep', position: 0 }),
      makePlanTask({
        key: 'api-tests',
        change: 'new',
        position: 1,
        summary: `Test the API ${HOSTILE}`,
        scope: { write: ['backend/test/**‮'], read: [] },
      }),
      makePlanTask({ key: 'ui', change: 'rework', position: 2, note: `the page broke ${HOSTILE}` }),
      makePlanTask({ key: 'docs', change: 'drop', position: 3, note: 'not needed' }),
    ],
  });

  function open(withActive = true, answers: Record<string, unknown> = {}) {
    ctx = makeContext({
      snapshot: makeSnapshot({
        goals: [makeGoal()],
        plans: { [GOAL]: { active: withActive ? makePlan() : null, proposed } },
      }),
      answers: {
        [`GET /plans/${PLAN}/diff`]: {
          plan_id: PLAN,
          from: 1,
          to: 2,
          diff: {
            added: [{ key: 'api-tests' }],
            dropped: [{ key: 'docs' }],
            reworked: [{ key: 'ui' }],
            changed: [{ task: { key: 'api' }, fields: ['summary'] }],
            unchanged: 0,
          },
        },
        [`POST /plans/${PLAN}/versions/2/approve`]: { plan: proposed },
        [`POST /plans/${PLAN}/versions/2/reject`]: proposed,
        ...answers,
      },
    });
    const m = planReview(ctx, { kind: 'plan-review', id: GOAL }, () => {
      closed += 1;
    });
    document.body.appendChild(m.el);
    vi.advanceTimersByTime(0);
    return m;
  }

  it('shows the proposed version task by task with change badges and notes, as text', async () => {
    const m = open();
    await flush();
    expect(m.el.querySelector('img')).toBeNull();
    const rows = [...m.el.querySelectorAll<HTMLElement>('.gv-plan-task')];
    expect(rows.map((r) => r.dataset.key)).toEqual(['api', 'api-tests', 'ui', 'docs']);
    expect(rows.map((r) => r.querySelector('.badge')?.textContent)).toEqual(['keep', 'new', 'rework', 'drop']);
    expect(rows[1]?.textContent).toContain(`Test the API ${HOSTILE}`);
    expect(rows[1]?.querySelector('.gv-plan-scope')?.textContent).toContain('backend/test/**⟨U+202E⟩');
    expect(rows[2]?.textContent).toContain(`the page broke ${HOSTILE}`);
    expect(m.el.textContent).toContain(`Split the API ${HOSTILE}`);
    expect(m.el.textContent).toContain('Proposed plan v2');
    m.destroy();
  });

  it('diffs against the active version', async () => {
    const m = open();
    await flush();
    const [call] = ctx.transport.to('GET', `/plans/${PLAN}/diff`);
    expect(call?.path).toContain('from=1&to=2');
    const diff = m.el.querySelector('.gv-plan-diff')?.textContent ?? '';
    expect(diff).toContain('Added (1): api-tests');
    expect(diff).toContain('Dropped (1): docs');
    expect(diff).toContain('Reworked (1): ui');
    expect(diff).toContain('api (summary)');
    m.destroy();
  });

  it('a first plan has nothing to diff', async () => {
    const m = open(false);
    await flush();
    expect(ctx.transport.to('GET', `/plans/${PLAN}/diff`)).toHaveLength(0);
    expect(m.el.textContent).toContain('first plan');
    m.destroy();
  });

  it('Approve approves that version, once the review armed', async () => {
    const m = open();
    buttonNamed(m.el, 'Approve plan').click();
    await flush();
    expect(ctx.transport.to('POST', `/plans/${PLAN}/versions/2/approve`)).toHaveLength(0);
    arm(m.el);
    buttonNamed(m.el, 'Approve plan').click();
    await flush();
    expect(ctx.transport.to('POST', `/plans/${PLAN}/versions/2/approve`)).toHaveLength(1);
    expect(closed).toBe(1);
    m.destroy();
  });

  it('Reject sends the note', async () => {
    const m = open();
    arm(m.el);
    (m.el.querySelector('textarea') as HTMLTextAreaElement).value = 'keep the docs task';
    buttonNamed(m.el, 'Reject with note').click();
    await flush();
    expect(ctx.transport.to('POST', `/plans/${PLAN}/versions/2/reject`)[0]?.body).toEqual({
      note: 'keep the docs task',
    });
    m.destroy();
  });

  it('says when the proposal was decided elsewhere', () => {
    const m = open();
    ctx.board(makeSnapshot({ goals: [makeGoal()], plans: { [GOAL]: { active: makePlan(), proposed: null } } }));
    expect(m.el.querySelector('.gv-gone')?.hasAttribute('hidden')).toBe(false);
    expect(buttonNamed(m.el, 'Approve plan').disabled).toBe(true);
    m.destroy();
  });

  it('with no proposed plan it says so', () => {
    ctx = makeContext({ snapshot: makeSnapshot({ goals: [makeGoal()] }) });
    const m = planReview(ctx, { kind: 'plan-review', id: GOAL }, () => undefined);
    expect(m.el.textContent).toContain('No proposed plan');
    m.destroy();
  });

  it('reads the diff defensively', () => {
    expect(readPlanDiff(null)).toBeNull();
    expect(readPlanDiff({ added: 'x', changed: [null, { task: { key: 'a' }, fields: ['kind', 3] }] })).toEqual({
      added: [],
      dropped: [],
      reworked: [],
      changed: [{ task: { key: 'a' }, fields: ['kind'] }],
      unchanged: 0,
    });
  });
});
