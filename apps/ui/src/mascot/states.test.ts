import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as group, it } from 'vitest';
import { initialState, type Reaction, type RootState } from '../store/state.js';
import { makeApproval, makeEscalation, makeSnapshot, makeTask } from '../test/fixtures.js';
import { EYE_SHAPES } from './eyes.js';
import {
  conditions,
  describe,
  ERROR_MS,
  FINISHED_MS,
  firstPendingApproval,
  MASCOT_STATES,
  nextChangeAt,
  PRIORITY,
  pendingApprovals,
  SLEEP_AFTER_MS,
  STATE_LOOK,
  selectState,
  UNREAD_MS,
  WORKING_MS,
} from './states.js';

const NOW = Date.parse('2026-10-17T10:00:00.000Z');

type Over = {
  board?: Partial<RootState['board'] & object> | null;
  system?: Partial<RootState['system']>;
  activity?: Partial<RootState['activity']>;
  ui?: Partial<RootState['ui']>;
};

function root(o: Over = {}): RootState {
  const s = initialState();
  return {
    ...s,
    board: o.board === null ? null : makeSnapshot(o.board ?? {}),
    system: { ...s.system, connection: 'live', snapshotAt: NOW - 1_000, ...o.system },
    activity: { ...s.activity, lastActivityAt: NOW - 1_000, ...o.activity },
    ui: { ...s.ui, ...o.ui },
  };
}

let rid = 1;
function reaction(kind: Reaction['kind'], at: number): Reaction {
  return { id: rid++, kind, at };
}

function tool(at: number) {
  return {
    current: { at, tool: 'Edit', kind: 'write' as const, target: 'a.ts', decision: 'allow' as const, taskId: null },
    log: [],
    usage: null,
    model: null,
  };
}

const PAUSED = { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null };
const HALTED = { ...PAUSED, halted_at: '2026-10-17T09:59:00.000Z' };

group('selectState: each condition', () => {
  it('is idle when connected and nothing happens', () => {
    expect(selectState(root(), NOW)).toBe('idle');
    expect(selectState(root({ board: null, system: { connection: 'starting', snapshotAt: 0 } }), NOW)).toBe('idle');
  });

  it('works while an agent tool ran in the last 3 s', () => {
    expect(selectState(root({ activity: { agents: { a: tool(NOW - 1_000) } } }), NOW)).toBe('working');
    expect(selectState(root({ activity: { agents: { a: tool(NOW - WORKING_MS + 1) } } }), NOW)).toBe('working');
    expect(selectState(root({ activity: { agents: { a: tool(NOW - WORKING_MS) } } }), NOW)).toBe('idle');
    expect(selectState(root({ activity: { agents: { a: { ...tool(0), current: null } } } }), NOW)).toBe('idle');
  });

  it('thinks while a Master Brain job is calling', () => {
    const calling = { job_id: 'j1', kind: 'plan', status: 'calling', goal_id: null };
    expect(selectState(root({ board: { brain_jobs: [calling] } }), NOW)).toBe('thinking');
    expect(selectState(root({ board: { brain_jobs: [{ ...calling, status: 'pending' }] } }), NOW)).toBe('idle');
  });

  it('searches while the reindex the user started runs (ERRATA F28)', () => {
    expect(selectState(root({ ui: { indexing: true } }), NOW)).toBe('searching');
  });

  it('shows approval for a pending, unexpired approval only', () => {
    expect(selectState(root({ board: { approvals: [makeApproval()] } }), NOW)).toBe('approval');
    expect(selectState(root({ board: { approvals: [makeApproval({ expired: true })] } }), NOW)).toBe('idle');
    const past = makeApproval({ expires_at: '2026-10-17T09:59:59.000Z' });
    expect(selectState(root({ board: { approvals: [past] } }), NOW)).toBe('idle');
    expect(selectState(root({ board: { approvals: [makeApproval({ status: 'granted' })] } }), NOW)).toBe('idle');
    expect(selectState(root({ board: { approvals: [makeApproval({ expires_at: null })] } }), NOW)).toBe('approval');
    expect(pendingApprovals(null, NOW)).toBe(0);
    const expired = makeApproval({ approval_id: 'apr_old', expires_at: '2026-10-17T09:00:00.000Z' });
    const waiting = makeApproval({ approval_id: 'apr_new' });
    expect(firstPendingApproval(makeSnapshot({ approvals: [expired, waiting] }), NOW)?.approval_id).toBe('apr_new');
    expect(firstPendingApproval(makeSnapshot({ approvals: [expired] }), NOW)).toBeNull();
    expect(firstPendingApproval(null, NOW)).toBeNull();
  });

  it('shows approval at once for an approval the snapshot has not caught up with', () => {
    const fresh = root({ activity: { reactions: [reaction('approval', NOW - 100)] } });
    expect(selectState(fresh, NOW)).toBe('approval');
    // Older than the last snapshot: the board decides.
    const seen = root({ activity: { reactions: [reaction('approval', NOW - 2_000)] } });
    expect(selectState(seen, NOW)).toBe('idle');
    // Never read: it still stops after a while.
    const stale = root({
      system: { snapshotAt: NOW - 60_000 },
      activity: { reactions: [reaction('approval', NOW - UNREAD_MS)] },
    });
    expect(selectState(stale, NOW)).toBe('idle');
  });

  it('asks a question for a pending escalation, a task waiting for a human, or an unread question', () => {
    expect(selectState(root({ board: { escalations: [makeEscalation()] } }), NOW)).toBe('question');
    expect(selectState(root({ board: { escalations: [makeEscalation({ status: 'answered' })] } }), NOW)).toBe('idle');
    const blocked = makeTask({ status: 'WAITING', waiting_reason: 'blocked' });
    expect(selectState(root({ board: { tasks: [blocked] } }), NOW)).toBe('question');
    const human = makeTask({ status: 'WAITING', waiting_reason: 'human_approval' });
    expect(selectState(root({ board: { tasks: [human] } }), NOW)).toBe('question');
    const dep = makeTask({ status: 'WAITING', waiting_reason: 'dependency_wait' });
    expect(selectState(root({ board: { tasks: [dep] } }), NOW)).toBe('idle');
    expect(selectState(root({ activity: { reactions: [reaction('question', NOW - 10)] } }), NOW)).toBe('question');
    expect(selectState(root({ activity: { reactions: [reaction('plan', NOW - 10)] } }), NOW)).toBe('question');
  });

  it('shows error for a failure in the last 8 s or a lost connection', () => {
    expect(selectState(root({ activity: { reactions: [reaction('failed', NOW - 1_000)] } }), NOW)).toBe('error');
    expect(selectState(root({ activity: { reactions: [reaction('lost', NOW - ERROR_MS + 1)] } }), NOW)).toBe('error');
    expect(selectState(root({ activity: { reactions: [reaction('failed', NOW - ERROR_MS)] } }), NOW)).toBe('idle');
    expect(selectState(root({ system: { connection: 'reconnecting' } }), NOW)).toBe('error');
  });

  it('is finished for a completion in the last 4 s', () => {
    expect(selectState(root({ activity: { reactions: [reaction('completed', NOW - 500)] } }), NOW)).toBe('finished');
    const goal = root({ activity: { reactions: [reaction('goal-completed', NOW - FINISHED_MS + 1)] } });
    expect(selectState(goal, NOW)).toBe('finished');
    const old = root({ activity: { reactions: [reaction('completed', NOW - FINISHED_MS)] } });
    expect(selectState(old, NOW)).toBe('idle');
  });

  it('is halted after a halt, and asleep while merely paused', () => {
    expect(selectState(root({ board: { control: HALTED } }), NOW)).toBe('halted');
    expect(selectState(root({ board: { control: PAUSED } }), NOW)).toBe('sleeping');
    // A halt that was resumed is not halted.
    expect(selectState(root({ board: { control: { ...HALTED, paused: false } } }), NOW)).toBe('idle');
  });

  it('sleeps after 10 minutes without activity, or when Friday stopped', () => {
    const quiet = root({ system: { snapshotAt: NOW - SLEEP_AFTER_MS }, activity: { lastActivityAt: 0 } });
    expect(selectState(quiet, NOW)).toBe('sleeping');
    const almost = root({ system: { snapshotAt: NOW - SLEEP_AFTER_MS + 1 }, activity: { lastActivityAt: 0 } });
    expect(selectState(almost, NOW)).toBe('idle');
    expect(selectState(root({ system: { connection: 'stopped' } }), NOW)).toBe('sleeping');
    expect(selectState(root({ system: { connection: 'signed-out' } }), NOW)).toBe('sleeping');
    // Nothing known yet: not asleep.
    expect(selectState(root({ system: { snapshotAt: 0 }, activity: { lastActivityAt: 0 } }), NOW)).toBe('idle');
  });

  it('ignores reactions stamped far in the future', () => {
    expect(selectState(root({ activity: { reactions: [reaction('failed', NOW + 60_000)] } }), NOW)).toBe('idle');
  });
});

group('selectState: priorities', () => {
  it('walks the priority list as conditions are removed one by one', () => {
    const all: Over = {
      board: {
        approvals: [makeApproval()],
        escalations: [makeEscalation()],
        control: HALTED,
        brain_jobs: [{ job_id: 'j', kind: 'plan', status: 'calling', goal_id: null }],
      },
      activity: {
        reactions: [reaction('failed', NOW - 100), reaction('completed', NOW - 100)],
        agents: { a: tool(NOW - 100) },
      },
      ui: { indexing: true },
    };
    const seen: string[] = [];
    const steps: ((o: Over) => void)[] = [
      (o) => {
        o.board = { ...o.board, approvals: [] };
      },
      (o) => {
        o.board = { ...o.board, escalations: [] };
      },
      (o) => {
        o.activity = { ...o.activity, reactions: [reaction('completed', NOW - 100)] };
      },
      (o) => {
        o.activity = { ...o.activity, reactions: [] };
      },
      (o) => {
        o.board = { ...o.board, control: PAUSED };
      },
      (o) => {
        o.board = { ...o.board, control: { ...PAUSED, paused: false } };
      },
      (o) => {
        o.activity = { ...o.activity, agents: {} };
      },
      (o) => {
        o.board = { ...o.board, brain_jobs: [] };
      },
      (o) => {
        o.ui = { indexing: false };
      },
      (o) => {
        o.system = { connection: 'stopped' };
      },
    ];
    const o: Over = { ...all };
    seen.push(selectState(root(o), NOW));
    for (const step of steps) {
      step(o);
      seen.push(selectState(root(o), NOW));
    }
    expect(seen).toEqual([
      'approval',
      'question',
      'error',
      'finished',
      'halted',
      'sleeping',
      'working',
      'thinking',
      'searching',
      'idle',
      'sleeping',
    ]);
  });

  it('keeps the documented order, and lists every condition that holds', () => {
    expect(PRIORITY).toEqual([
      'approval',
      'question',
      'error',
      'finished',
      'halted',
      'paused',
      'working',
      'thinking',
      'searching',
      'idle',
      'sleeping',
    ]);
    const held = conditions(
      root({ board: { control: PAUSED }, activity: { agents: { a: tool(NOW) } }, ui: { indexing: true } }),
      NOW,
    );
    expect(held).toEqual(['paused', 'working', 'searching', 'idle']);
  });

  it('lets an approval win over a lost connection, and a pause win over work', () => {
    expect(
      selectState(root({ board: { approvals: [makeApproval()] }, system: { connection: 'reconnecting' } }), NOW),
    ).toBe('approval');
    expect(selectState(root({ board: { control: PAUSED }, activity: { agents: { a: tool(NOW) } } }), NOW)).toBe(
      'sleeping',
    );
  });
});

group('nextChangeAt', () => {
  it('returns the earliest moment a time-bound condition runs out', () => {
    const s = root({
      activity: { agents: { a: tool(NOW - 1_000) }, reactions: [reaction('failed', NOW - 1_000)] },
    });
    expect(nextChangeAt(s, NOW)).toBe(NOW + 2_000);
    const r = root({ activity: { reactions: [reaction('completed', NOW - 1_000)] } });
    expect(nextChangeAt(r, NOW)).toBe(NOW + 3_000);
  });

  it('includes approval expiry and the slide into sleep', () => {
    const exp = Date.parse('2026-10-17T10:00:30.000Z');
    const s = root({ board: { approvals: [makeApproval({ expires_at: '2026-10-17T10:00:30.000Z' })] } });
    expect(nextChangeAt(s, NOW)).toBe(exp);
    expect(nextChangeAt(root(), NOW)).toBe(NOW - 1_000 + SLEEP_AFTER_MS);
  });

  it('is null when nothing is due', () => {
    expect(nextChangeAt(root({ system: { snapshotAt: 0 }, activity: { lastActivityAt: 0 } }), NOW)).toBeNull();
  });
});

group('state looks', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const tokens = readFileSync(path.join(here, '../styles/tokens.css'), 'utf8');

  it('map every state to known eyes, a token tint and motion', () => {
    for (const state of MASCOT_STATES) {
      const look = STATE_LOOK[state];
      expect(EYE_SHAPES).toContain(look.eyes);
      expect(tokens).toContain(`${look.tint}:`);
      expect(look.motion.ambientS).toBeGreaterThanOrEqual(0);
      expect(look.description.length).toBeGreaterThan(0);
    }
    expect(STATE_LOOK.approval.eyes).toBe('wide');
    expect(STATE_LOOK.finished.eyes).toBe('happy');
    expect(STATE_LOOK.sleeping.eyes).toBe('closed');
    expect(STATE_LOOK.halted.eyes).toBe('x');
    expect(STATE_LOOK.halted.motion.scaleY).toBeLessThan(0.8);
    expect(STATE_LOOK.error.motion.emit?.type).toBe('sweat');
    expect(STATE_LOOK.sleeping.motion.emit?.type).toBe('z');
  });

  it('describes a pause as a pause', () => {
    expect(describe('sleeping', root({ board: { control: PAUSED } }))).toBe('Friday is paused');
    expect(describe('sleeping', root())).toBe('Friday is resting');
    expect(describe('approval', root())).toBe('An approval waits for you');
  });
});
