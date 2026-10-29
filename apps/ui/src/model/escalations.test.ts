import { describe, expect, it } from 'vitest';
import { makeEscalation } from '../test/fixtures.js';
import {
  BRAIN_KINDS,
  cardKindOf,
  classifyEscalation,
  composeAnswer,
  LET_AGENT_DECIDE,
  type QuestionCardKind,
} from './escalations.js';

const READY = { plannerAvailable: true };
const NO_PLANNER = { plannerAvailable: false };

describe('escalation kinds → cards (plan FD-21)', () => {
  const table: [string | null, QuestionCardKind][] = [
    [null, 'free'],
    ['ambiguous_intent', 'free'],
    ['recovery_needed', 'recovery'],
    ['routing_blocked', 'routing'],
    ['routing_violated', 'routing'],
    ['integration_conflict', 'integration'],
    ['integration_failed', 'integration'],
    ['unanswered_request', 'unanswered'],
    ['repeated_verification_failures', 'brain'],
    ['repeated_failures', 'brain'],
    ['replan_limit', 'brain'],
    ['planner_unavailable', 'brain'],
    ['invalid_plan', 'brain'],
    ['budget_exceeded', 'brain'],
    ['plan_rejected', 'brain'],
    ['action_failed', 'brain'],
    ['something_new', 'brain'],
  ];
  it.each(table)('%s → %s', (kind, card) => {
    expect(cardKindOf(kind)).toBe(card);
    expect(classifyEscalation(makeEscalation({ kind }), READY).card).toBe(card);
  });

  it('knows every Master Brain kind', () => {
    for (const k of BRAIN_KINDS) expect(cardKindOf(k)).toBe('brain');
  });
});

describe('classifyEscalation', () => {
  it('an agent question offers its options as chips, with send, let the agent decide and later', () => {
    const s = classifyEscalation(makeEscalation(), READY);
    expect(s.card).toBe('free');
    expect(s.asker).toBe('agent');
    expect(s.choices).toEqual(['Yes, stack them', 'No, one code per order']);
    expect(s.cliHints).toEqual([]);
    expect(s.actions).toEqual(['send', 'let-agent-decide', 'later']);
    expect(s.why).toBe('The spec does not say');
    expect(s.proposedAction).toBe('one code per order');
    expect(s.title).toBe('A question from the agent');
  });

  it('cleans chips: strings only, no blanks, no repeats, at most 20', () => {
    const options = ['a', '', '  ', 'a', 'b', 7, null, ...Array.from({ length: 30 }, (_, i) => `o${i}`)];
    const s = classifyEscalation(makeEscalation({ options: options as string[] }), READY);
    expect(s.choices[0]).toBe('a');
    expect(s.choices[1]).toBe('b');
    expect(s.choices).toHaveLength(20);
    expect(new Set(s.choices).size).toBe(20);
  });

  it('ambiguous_intent from the Master Brain is a free question', () => {
    const s = classifyEscalation(
      makeEscalation({ kind: 'ambiguous_intent', requested_by_kind: 'master_brain', options: ['Monthly', 'Yearly'] }),
      READY,
    );
    expect(s.card).toBe('free');
    expect(s.asker).toBe('master_brain');
    expect(s.choices).toEqual(['Monthly', 'Yearly']);
  });

  it('never offers the CLI instructions of a system kind as choices', () => {
    const kinds = [
      'recovery_needed',
      'routing_blocked',
      'routing_violated',
      'integration_conflict',
      'integration_failed',
      'unanswered_request',
      ...BRAIN_KINDS,
    ];
    for (const kind of kinds) {
      const options = [`friday recover task_1 --action reassign`, 'friday routing explain task_1'];
      const s = classifyEscalation(
        makeEscalation({ kind, options, requested_by_kind: 'system', goal_id: 'goal_1' }),
        READY,
      );
      expect(s.choices, kind).toEqual([]);
      expect(s.cliHints, kind).toEqual(options);
      expect(s.actions, kind).not.toContain('send');
      expect(s.asker, kind).toBe('friday');
    }
  });

  it('recovery_needed opens the recovery dialog for its task', () => {
    expect(classifyEscalation(makeEscalation({ kind: 'recovery_needed' }), READY).actions).toEqual([
      'recover',
      'later',
    ]);
    expect(classifyEscalation(makeEscalation({ kind: 'recovery_needed', task_id: null }), READY).actions).toEqual([
      'later',
    ]);
  });

  it('routing kinds explain, pin a model and cancel the task', () => {
    for (const kind of ['routing_blocked', 'routing_violated']) {
      expect(classifyEscalation(makeEscalation({ kind }), READY).actions).toEqual([
        'routing-why',
        'pin-model',
        'cancel-task',
        'later',
      ]);
    }
  });

  it('integration kinds integrate again, integrate a repair, open the worktree and cancel the goal', () => {
    const s = classifyEscalation(makeEscalation({ kind: 'integration_conflict', goal_id: 'goal_1' }), READY);
    expect(s.actions).toEqual(['open-worktree', 'integrate-again', 'integrate-repair', 'cancel-goal', 'later']);
    const noGoal = classifyEscalation(makeEscalation({ kind: 'integration_failed', goal_id: null }), READY);
    expect(noGoal.actions).not.toContain('cancel-goal');
  });

  it('unanswered_request is a reply box', () => {
    const s = classifyEscalation(
      makeEscalation({
        kind: 'unanswered_request',
        details: { evidence: ['What currency?'], requested_by: 'claude-1' },
      }),
      READY,
    );
    expect(s.actions).toEqual(['reply', 'later']);
    expect(s.evidence).toEqual(['What currency?']);
  });

  it('Master Brain kinds revise with a note when a planner is ready, else open the plan editor', () => {
    const e = makeEscalation({ kind: 'replan_limit', goal_id: 'goal_1', requested_by_kind: 'master_brain' });
    expect(classifyEscalation(e, READY).actions).toEqual(['revise-note', 'rework-task', 'cancel-task', 'later']);
    expect(classifyEscalation(e, NO_PLANNER).actions).toEqual([
      'write-revision',
      'rework-task',
      'cancel-task',
      'later',
    ]);
    const goalOnly = makeEscalation({ kind: 'invalid_plan', goal_id: 'goal_1', task_id: null });
    expect(classifyEscalation(goalOnly, READY).actions).toEqual(['revise-note', 'later']);
  });

  it('planner and budget kinds link to the planner settings; with nothing to act on, a reply is recorded', () => {
    const s = classifyEscalation(makeEscalation({ kind: 'planner_unavailable', goal_id: null, task_id: null }), READY);
    expect(s.actions).toEqual(['planner-settings', 'reply', 'later']);
    const b = classifyEscalation(makeEscalation({ kind: 'budget_exceeded', goal_id: 'g', task_id: null }), NO_PLANNER);
    expect(b.actions).toEqual(['write-revision', 'planner-settings', 'later']);
  });

  it('titles every known kind and humanizes unknown ones', () => {
    expect(classifyEscalation(makeEscalation({ kind: 'integration_conflict' }), READY).title).toBe(
      'Integration conflict',
    );
    expect(classifyEscalation(makeEscalation({ kind: 'brand_new.kind' }), READY).title).toBe('Brand new kind');
  });

  it('reads evidence as a list or one string, and ignores other shapes', () => {
    expect(classifyEscalation(makeEscalation({ details: { evidence: 'one line' } }), READY).evidence).toEqual([
      'one line',
    ]);
    expect(classifyEscalation(makeEscalation({ details: { evidence: [1, 'x', null] } }), READY).evidence).toEqual([
      'x',
    ]);
    expect(classifyEscalation(makeEscalation({ details: null }), READY)).toMatchObject({
      why: null,
      proposedAction: null,
      evidence: [],
    });
  });
});

describe('composeAnswer', () => {
  it('composes "Selected:" and "Note:" lines, each only when present', () => {
    expect(composeAnswer('RS256', '')).toBe('Selected: RS256');
    expect(composeAnswer(null, 'use JWKS')).toBe('Note: use JWKS');
    expect(composeAnswer('RS256', '  rotate keys monthly  ')).toBe('Selected: RS256\nNote: rotate keys monthly');
    expect(composeAnswer(null, '   ')).toBe('');
    expect(composeAnswer('  ', '')).toBe('');
    expect(composeAnswer(null, 'line one\nline two')).toBe('Note: line one\nline two');
  });

  it('lets the agent decide with a fixed sentence', () => {
    expect(LET_AGENT_DECIDE).toBe('No preference; use your judgement');
  });
});
