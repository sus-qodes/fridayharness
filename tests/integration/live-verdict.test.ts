/**
 * The verdicts of the live checks (review M8-R07), from the results a scripted run records: a host
 * that blocks or fails is not a pass, a case the budget does not cover is incomplete, and a failed
 * case keeps the rest of the budget.
 */
import { describe, expect, it } from 'vitest';
import { incomplete, LiveBudget, verdict } from '../helpers/live-verdict.js';

describe('live check verdicts (review M8-R07)', () => {
  it('passes only when every required behaviour was observed', () => {
    const blocked = { task_status: 'WAITING', waiting_reason: 'blocked', verification: null, report: null };
    expect(
      verdict({
        'the turn ended with a claim': blocked.task_status === 'READY_FOR_VERIFICATION',
        'the claim was verified': blocked.verification === 'COMPLETED',
        'the report holds its line': Boolean(blocked.report),
      }),
    ).toEqual({
      status: 'failed',
      missing: ['the turn ended with a claim', 'the claim was verified', 'the report holds its line'],
    });
    expect(verdict({ 'the turn ended with a claim': true, 'the claim was verified': true })).toEqual({
      status: 'passed',
      missing: [],
    });
  });

  it('keeps the budget after a failure, and calls a case the budget cannot cover incomplete', () => {
    const budget = new LiveBudget(3);
    expect(budget.refuse(1)).toBeNull();
    budget.settle('work', 1, verdict({ 'the turn ended with a claim': false }));
    // The restart case would need two more turns: it does not start, and says why.
    const why = budget.refuse(2);
    expect(why).toMatch(/the work case did not pass/);
    expect(incomplete(why as string)).toMatchObject({ status: 'incomplete' });
    expect(budget.spent).toBe(1);

    const short = new LiveBudget(2);
    short.settle('work', 1, verdict({ ok: true }));
    expect(short.refuse(2)).toMatch(/needs 2 turn\(s\), and 1 of the 2 approved are left/);
  });
});
