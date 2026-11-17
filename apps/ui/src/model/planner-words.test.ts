import { describe, expect, it } from 'vitest';
import { fixedInSettings, PLANNER_FAILURES, plannerTrouble, plannerTroubleWords } from './planner-words.js';

describe('why the planner could not plan', () => {
  it('reads the trouble from the kind and from what the provider said', () => {
    const cases: [string, string, string][] = [
      ['planner_unavailable', 'Claude Code said: Not logged in · Please run /login', 'sign_in'],
      ['planner_unavailable', 'OAuth token has expired', 'sign_in'],
      ['planner_unavailable', '401 unauthorized', 'sign_in'],
      ['planner_unavailable', 'Claude AI usage limit reached|1731855600', 'limit'],
      ['planner_unavailable', 'You have hit your limit · resets 5pm', 'limit'],
      ['action_failed', '429 too many requests', 'limit'],
      ['planner_unavailable', 'no planner is configured', 'not_set_up'],
      ['planner_unavailable', 'the Anthropic key is missing', 'not_set_up'],
      ['planner_unavailable', 'this machine has not approved claude-code', 'not_set_up'],
      ['planner_unavailable', 'Claude Code was not found (PATH, CLAUDE_CODE_BIN, the VS Code extension)', 'not_set_up'],
      ['action_failed', 'plan kept failing (4 attempts): boom', 'other'],
      // The kind says it on its own, whatever the words.
      ['budget_exceeded', 'usage limit', 'budget'],
      ['invalid_plan', 'not signed in', 'unreadable'],
    ];
    for (const [kind, why, want] of cases) expect(plannerTrouble(kind, why), `${kind}: ${why}`).toBe(want);
    expect(plannerTrouble('planner_unavailable', null)).toBe('other');
    expect(plannerTrouble(null, undefined)).toBe('other');
    expect(PLANNER_FAILURES).toEqual(['planner_unavailable', 'invalid_plan', 'budget_exceeded', 'action_failed']);
  });

  it('says each in a sentence a person can act on, with the provider’s words only where nothing better is known', () => {
    expect(plannerTroubleWords('sign_in', 'x')).toContain('open Claude Code once and sign in');
    expect(plannerTroubleWords('limit', 'x')).toContain('once the limit resets');
    expect(plannerTroubleWords('not_set_up', 'x')).toContain('Settings → Planner');
    expect(plannerTroubleWords('budget', 'x')).toContain('wait until tomorrow');
    expect(plannerTroubleWords('unreadable', 'x')).toContain('Ask again');
    expect(plannerTroubleWords('other', '  boom  ')).toContain('The planner could not finish: boom');
    expect(plannerTroubleWords('other', null)).toBe('The planner could not finish.');
    expect(plannerTroubleWords('other', 'x'.repeat(900)).length).toBeLessThan(340);
  });

  it('knows which troubles are fixed in the planner settings', () => {
    expect(
      ['sign_in', 'limit', 'not_set_up', 'budget', 'unreadable', 'other'].map((t) => fixedInSettings(t as never)),
    ).toEqual([true, false, true, true, false, false]);
  });
});
