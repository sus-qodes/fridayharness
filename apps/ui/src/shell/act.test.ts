import { describe, expect, it, vi } from 'vitest';
import { ApiError, AuthError, OfflineError } from '../platform/transport.js';
import { errorDetail, isCancelled, makeAct, OFFLINE_DETAIL, withoutCommands } from './act.js';
import type { Toast } from './context.js';

function setup() {
  const toasts: Toast[] = [];
  const act = makeAct((t) => toasts.push(t));
  return { toasts, act };
}

describe('makeAct (plan §6 rule 6)', () => {
  it('returns the result and shows a success toast only when asked', async () => {
    const { toasts, act } = setup();
    expect(await act('Pause Friday', async () => 42)).toBe(42);
    expect(toasts).toEqual([]);
    expect(await act('Pause Friday', async () => 7, 'Friday is paused')).toBe(7);
    expect(toasts).toEqual([{ kind: 'success', text: 'Friday is paused' }]);
    await act(
      'Resume',
      async () => ({ n: 3 }),
      (r) => `${r.n} agents continue`,
    );
    expect(toasts.at(-1)).toEqual({ kind: 'success', text: '3 agents continue' });
  });

  it("shows what went wrong, then Friday's code for it, when the daemon refuses", async () => {
    const { toasts, act } = setup();
    const r = await act('Approve', async () => {
      throw new ApiError(409, 'COS-2002', 'invalid_state_transition', 'approval is already granted');
    });
    expect(r).toBeUndefined();
    expect(toasts).toEqual([{ kind: 'error', text: 'Approve', detail: 'approval is already granted (COS-2002)' }]);
  });

  it('says Friday is not reachable when nothing answered', async () => {
    const { toasts, act } = setup();
    await act('Verify', async () => {
      throw new OfflineError('Failed to fetch');
    });
    expect(toasts[0]).toEqual({ kind: 'error', text: 'Verify', detail: OFFLINE_DETAIL });
    expect(OFFLINE_DETAIL).toBe('Friday is not reachable');
  });

  it('leaves the terminal command in brackets out of a refusal, and keeps the sentence (2026-11-17)', () => {
    expect(
      withoutCommands(
        'plan plan_1 v2 is out of date: task_x no longer exists. Reject it ("friday plan reject") and ask for a new one ("friday goal replan").',
      ),
    ).toBe('plan plan_1 v2 is out of date: task_x no longer exists. Reject it and ask for a new one.');
    // A command that is part of the sentence stays, as does any other bracket.
    expect(withoutCommands('restore it with "friday task worktree t1" (or ask)')).toBe(
      'restore it with "friday task worktree t1" (or ask)',
    );
    expect(withoutCommands('nothing to change')).toBe('nothing to change');
    expect(
      errorDetail(
        new ApiError(409, 'COS-2010', 'invalid_state_transition', 'it is stale. Reject it ("friday plan reject").'),
      ),
    ).toBe('it is stale. Reject it. (COS-2010)');
  });

  it('formats every kind of failure without throwing', () => {
    expect(errorDetail(new AuthError('COS-3005', 'expired'))).toBe('expired (COS-3005)');
    expect(errorDetail(new Error('plain'))).toBe('plain');
    expect(errorDetail('a string')).toBe('something went wrong');
    expect(errorDetail(null)).toBe('something went wrong');
    const hostile = errorDetail(
      new ApiError(400, 'COS-1000', 'x', `<img src=x onerror=alert(1)>‮\u001b[31m${'y'.repeat(5000)}`),
    );
    // What went wrong first, as text; Friday's code for it last.
    expect(hostile.startsWith('<img src=x onerror=alert(1)>')).toBe(true);
    expect(hostile.endsWith(' (COS-1000)')).toBe(true);
    expect(hostile).not.toContain('‮');
    expect(hostile).not.toContain('\u001b');
    expect(Array.from(hostile).length).toBeLessThanOrEqual(400);
  });

  it('keeps the result when the success text cannot be made', async () => {
    const { toasts, act } = setup();
    const r = await act(
      'Do',
      async () => 1,
      () => {
        throw new Error('bad formatter');
      },
    );
    expect(r).toBe(1);
    expect(toasts).toEqual([]);
  });

  it('says nothing when the person cancelled the desktop confirmation: nothing went wrong', async () => {
    const { toasts, act } = setup();
    const cancelled = new ApiError(400, 'DESKTOP-1003', 'cancelled', 'you cancelled it in the confirmation dialog');
    expect(isCancelled(cancelled)).toBe(true);
    expect(isCancelled(new ApiError(409, 'COS-2002', 'invalid_state_transition', 'no'))).toBe(false);
    expect(isCancelled(new Error('DESKTOP-1003'))).toBe(false);
    const r = await act(
      'Land the goal',
      async () => {
        throw cancelled;
      },
      'Landed',
    );
    expect(r).toBeUndefined();
    expect(toasts).toEqual([]);
  });

  it('runs the call once', async () => {
    const { act } = setup();
    const call = vi.fn(async () => 'ok');
    await act('Once', call);
    expect(call).toHaveBeenCalledOnce();
  });
});
