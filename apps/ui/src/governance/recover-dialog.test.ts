import type { RecoveryAssessment } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeSnapshot, makeTask } from '../test/fixtures.js';
import { recoverDialog } from './recover-dialog.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const TASK = 'task_0000000000000000000000aa01';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function arm(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5, movementX: 1 }));
  vi.advanceTimersByTime(700);
}

function assessment(over: Partial<RecoveryAssessment> = {}): RecoveryAssessment {
  return {
    task_id: TASK,
    task_status: 'HARNESS_LOST',
    waiting_reason: null,
    attempts: 2,
    run: null,
    harness: {
      harness_id: 'h1',
      status: 'DISCONNECTED',
      agent_key: 'claude-1',
      last_heartbeat_at: null,
      reconnect_until: null,
      host_pid: null,
      process_alive: false,
    },
    last_activity: null,
    worktree: {
      path: `C:/wt/${HOSTILE}`,
      branch: 'friday/task',
      exists: true,
      base_commit: null,
      head: null,
      commits_since_base: 3,
      uncommitted: ['a.ts'],
      elsewhere: false,
      branch_here: null,
      restored_here: null,
    },
    missing_code: null,
    errors: { total: 1, same_as_last: 1, last: `crash ${HOSTILE}` },
    preserved: ['refs/friday/preserved/t/attempt-1'],
    options: [
      { action: 'reconnect', available: false, recommended: false, reason: 'its process ended' },
      { action: 'reassign', available: true, recommended: true, reason: `another agent can continue ${HOSTILE}` },
      { action: 'restart', available: true, recommended: false, reason: 'same agent, new attempt' },
      { action: 'rebind', available: false, recommended: false, reason: 'no new session' },
      { action: 'cancel', available: true, recommended: false, reason: 'stop the task' },
    ],
    ...over,
  } as RecoveryAssessment;
}

describe('recovery dialog', () => {
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

  async function open(answers: Record<string, unknown> = {}) {
    ctx = makeContext({
      snapshot: makeSnapshot({ tasks: [makeTask()] }),
      answers: {
        [`GET /tasks/${TASK}/recovery`]: { assessment: assessment() },
        [`POST /tasks/${TASK}/recover`]: { task: makeTask(), preserved_ref: 'refs/friday/preserved/t/attempt-2' },
        ...answers,
      },
    });
    const d = recoverDialog(ctx, { kind: 'recover', id: TASK }, () => {
      closed += 1;
    });
    document.body.appendChild(d.el);
    vi.advanceTimersByTime(0);
    await flush();
    return d;
  }

  it('lists every option with available, recommended and its reason, as text', async () => {
    const d = await open();
    expect(d.el.querySelector('img')).toBeNull();
    const rows = [...d.el.querySelectorAll<HTMLElement>('.gv-option')];
    expect(rows.map((r) => r.dataset.action)).toEqual(['reconnect', 'reassign', 'restart', 'rebind', 'cancel']);
    expect(rows[1]?.textContent).toContain('recommended');
    expect(rows[1]?.textContent).toContain(`another agent can continue ${HOSTILE}`);
    expect(rows[0]?.textContent).toContain('not available');
    // Unavailable options and reconnect (Friday waits for it) have no button.
    expect(rows[0]?.querySelector('button')).toBeNull();
    expect(rows[3]?.querySelector('button')).toBeNull();
    expect(rows[1]?.querySelector('button')).not.toBeNull();
    expect(d.el.textContent).toContain(`crash ${HOSTILE}`);
    d.destroy();
  });

  it('performs an option with the reason, after the dialog armed', async () => {
    const d = await open();
    const reason = d.el.querySelector('input') as HTMLInputElement;
    reason.value = 'its laptop slept';
    const perform = d.el.querySelector('[data-action="reassign"] button') as HTMLButtonElement;
    perform.click();
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${TASK}/recover`)).toHaveLength(0);
    arm(d.el);
    perform.click();
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${TASK}/recover`)[0]?.body).toEqual({
      action: 'reassign',
      reason: 'its laptop slept',
    });
    expect(closed).toBe(1);
    expect(ctx.refreshes).toBe(1);
    d.destroy();
  });

  it('Cancel asks first', async () => {
    const d = await open();
    arm(d.el);
    ctx.confirmAnswer = false;
    (d.el.querySelector('[data-action="cancel"] button') as HTMLButtonElement).click();
    await flush();
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.transport.to('POST', `/tasks/${TASK}/recover`)).toHaveLength(0);
    d.destroy();
  });

  it('a failed assessment offers to try again', async () => {
    const d = await open({
      [`GET /tasks/${TASK}/recovery`]: () => {
        throw new ApiError(409, 'COS-2002', 'invalid_state_transition', 'nothing to recover');
      },
    });
    expect(d.el.textContent).toContain('COS-2002: nothing to recover');
    expect([...d.el.querySelectorAll('button')].some((b) => b.textContent === 'Try again')).toBe(true);
    d.destroy();
  });
});
