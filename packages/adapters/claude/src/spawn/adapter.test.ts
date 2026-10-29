import { describe, expect, it } from 'vitest';
import { sessionBudgetUsd } from './adapter.js';

describe('the spawned session’s spending cap (plan M11.5)', () => {
  it('is the smaller of the adapter’s own cap and the task’s, and none when neither is set', () => {
    expect(sessionBudgetUsd(0.5, null)).toBe(0.5);
    expect(sessionBudgetUsd(undefined, 2)).toBe(2);
    expect(sessionBudgetUsd(0.5, 0.25)).toBe(0.25);
    expect(sessionBudgetUsd(0.5, 2)).toBe(0.5);
    expect(sessionBudgetUsd(undefined, null)).toBeUndefined();
    // A `task.start` from a daemon older than the field names no cap at all.
    expect(sessionBudgetUsd(undefined, undefined)).toBeUndefined();
    // A cap that is not a positive number is no cap.
    expect(sessionBudgetUsd(0, -1)).toBeUndefined();
    expect(sessionBudgetUsd(Number.NaN, 1)).toBe(1);
  });
});
