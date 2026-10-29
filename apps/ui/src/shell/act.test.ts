import { describe, expect, it, vi } from 'vitest';
import { ApiError, AuthError, OfflineError } from '../platform/transport.js';
import { errorDetail, makeAct, OFFLINE_DETAIL } from './act.js';
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

  it("shows Friday's code and message when the daemon refuses", async () => {
    const { toasts, act } = setup();
    const r = await act('Approve', async () => {
      throw new ApiError(409, 'COS-2002', 'invalid_state_transition', 'approval is already granted');
    });
    expect(r).toBeUndefined();
    expect(toasts).toEqual([{ kind: 'error', text: 'Approve', detail: 'COS-2002: approval is already granted' }]);
  });

  it('says Friday is not reachable when nothing answered', async () => {
    const { toasts, act } = setup();
    await act('Verify', async () => {
      throw new OfflineError('Failed to fetch');
    });
    expect(toasts[0]).toEqual({ kind: 'error', text: 'Verify', detail: OFFLINE_DETAIL });
    expect(OFFLINE_DETAIL).toBe('Friday is not reachable');
  });

  it('formats every kind of failure without throwing', () => {
    expect(errorDetail(new AuthError('COS-3005', 'expired'))).toBe('COS-3005: expired');
    expect(errorDetail(new Error('plain'))).toBe('plain');
    expect(errorDetail('a string')).toBe('something went wrong');
    expect(errorDetail(null)).toBe('something went wrong');
    const hostile = errorDetail(
      new ApiError(400, 'COS-1000', 'x', `<img src=x onerror=alert(1)>‮\u001b[31m${'y'.repeat(5000)}`),
    );
    expect(hostile.startsWith('COS-1000: <img src=x onerror=alert(1)>')).toBe(true);
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

  it('runs the call once', async () => {
    const { act } = setup();
    const call = vi.fn(async () => 'ok');
    await act('Once', call);
    expect(call).toHaveBeenCalledOnce();
  });
});
