import type { GoalSummary } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { goalSummaryLines } from './goals.js';

/** A goal with tasks and nothing else on record; each test changes what it needs. */
function summary(o: Partial<GoalSummary> = {}): GoalSummary {
  return {
    tasks: { total: 3, verified: 0 },
    claims_refused: 0,
    reworked: 0,
    held_for_human: 0,
    refused_by_policy: 0,
    sessions_lost: 0,
    sessions_recovered: 0,
    hosts: { attempts: 0, reported: 0, tokens: null, tokens_reporters: 0, cost_usd: null, cost_reporters: 0 },
    planning: { calls: 0, cost_usd: null, unknown_cost_calls: 0 },
    ...o,
  };
}

describe('what Friday did for a goal (goal show, plan M12.7)', () => {
  it('prints one row per fact, in words a person reads', () => {
    expect(
      goalSummaryLines(
        summary({
          tasks: { total: 3, verified: 3 },
          claims_refused: 1,
          reworked: 1,
          held_for_human: 2,
          sessions_lost: 1,
          sessions_recovered: 1,
          hosts: { attempts: 2, reported: 2, tokens: 184_321, tokens_reporters: 2, cost_usd: 0.42, cost_reporters: 2 },
          planning: { calls: 2, cost_usd: 0.12, unknown_cost_calls: 0 },
        }),
      ),
    ).toEqual([
      '  tasks verified: 3 of 3',
      '  claims refused by the checks: 1, reworked',
      '  actions held for you: 2',
      '  actions refused by policy: none',
      '  sessions lost: 1, recovered',
      '  hosts reported: 184k tokens, $0.42 (2 of 2 attempts)',
      "  Friday's planning: 2 calls, $0.12",
    ]);
  });

  it('leaves out what nobody reported: a token figure, a cost, a planning row', () => {
    // One host of three counted its tokens and named no cost: the figure says so, and no cost appears.
    expect(
      goalSummaryLines(
        summary({
          tasks: { total: 3, verified: 3 },
          hosts: { attempts: 3, reported: 1, tokens: 1234, tokens_reporters: 1, cost_usd: null, cost_reporters: 0 },
        }),
      ),
    ).toEqual([
      '  tasks verified: 3 of 3',
      '  claims refused by the checks: none',
      '  actions held for you: none',
      '  actions refused by policy: none',
      '  sessions lost: none',
      '  hosts reported: 1.2k tokens (1 of 3 attempts)',
    ]);
    // No host reported: nothing is written as 0.
    expect(
      goalSummaryLines(
        summary({
          hosts: { attempts: 3, reported: 0, tokens: null, tokens_reporters: 0, cost_usd: null, cost_reporters: 0 },
        }),
      ),
    ).toContain('  hosts reported: nothing (0 of 3 attempts)');
    // Fewer hosts named a cost than counted tokens: each figure says how many attempts it comes from.
    expect(
      goalSummaryLines(
        summary({
          hosts: { attempts: 2, reported: 2, tokens: 5000, tokens_reporters: 2, cost_usd: 0.1, cost_reporters: 1 },
        }),
      ),
    ).toContain('  hosts reported: 5.0k tokens (2 of 2 attempts), $0.10 (1 of 2 attempts)');
    // A planning call whose cost is unknown shows the call and no cost.
    expect(goalSummaryLines(summary({ planning: { calls: 1, cost_usd: null, unknown_cost_calls: 1 } })).at(-1)).toBe(
      "  Friday's planning: 1 call",
    );
  });

  it('says less when fewer were reworked or recovered than refused or lost', () => {
    const lines = goalSummaryLines(
      summary({ claims_refused: 2, reworked: 1, sessions_lost: 2, sessions_recovered: 0 }),
    );
    expect(lines).toContain('  claims refused by the checks: 2, 1 reworked');
    expect(lines).toContain('  sessions lost: 2');
  });

  it('prints nothing for a goal without work on record', () => {
    expect(goalSummaryLines(summary({ tasks: { total: 0, verified: 0 } }))).toEqual([]);
  });
});
