import { describe, expect, it } from 'vitest';
import { createStore } from '../store/state.js';
import {
  makeAgent,
  makeApproval,
  makeEscalation,
  makeGoal,
  makeHarness,
  makeInboxItem,
  makePlan,
  makeRun,
  makeScenario,
  makeSnapshot,
  makeTask,
  makeVerification,
} from '../test/fixtures.js';
import {
  activeTask,
  attentionWords,
  awaitsReply,
  buildModel,
  checksLine,
  completedGoal,
  connectionLook,
  isLiveApproval,
  itemSignature,
  MEMORY_REVIEW_KEY,
  nextExpiryIn,
  POLICY_UNTRUSTED_KEY,
  projectName,
  QUIET_MS,
  runningCount,
  STOPPED_GRACE_MS,
  statsText,
  statusSentence,
  stopWords,
  studioTarget,
  taskTag,
  turnHost,
  turnPrompt,
  waitingCount,
  waitingItems,
} from './derive.js';
import { IslandFsm } from './island-fsm.js';

const NOW = Date.parse('2026-10-17T10:00:00.000Z');
const NO_TIMERS = { set: () => 0, clear: () => undefined };
const HOSTILE = '<img src=x onerror=alert(1)>';

describe('waiting items (the pin source)', () => {
  it('lists approvals, then questions, then waiting agents, oldest first', () => {
    const board = makeSnapshot({
      approvals: [
        makeApproval({ approval_id: 'apr_b', task_id: 't1', created_at: '2026-10-17T09:50:00.000Z' }),
        makeApproval({ approval_id: 'apr_a', task_id: 't1', created_at: '2026-10-17T09:40:00.000Z' }),
      ],
      escalations: [makeEscalation({ escalation_id: 'esc_a', task_id: 't2' })],
      tasks: [
        makeTask({ task_id: 't3', status: 'WAITING', waiting_reason: 'blocked', updated_at: '2026-10-17T09:30:00Z' }),
        makeTask({ task_id: 't4', status: 'WAITING', waiting_reason: 'human_approval' }),
        makeTask({ task_id: 't5', status: 'WAITING', waiting_reason: 'dependency_wait' }),
        makeTask({ task_id: 't6', status: 'RUNNING' }),
      ],
    });
    expect(waitingItems(board, NOW).map((i) => i.key)).toEqual([
      'approval:apr_a',
      'approval:apr_b',
      'question:esc_a',
      'waiting:t3',
      'waiting:t4',
    ]);
    expect(waitingCount(board, NOW)).toBe(5);
  });

  it('counts a blocked agent whose own approval or question waits once', () => {
    const board = makeSnapshot({
      approvals: [makeApproval({ task_id: 't1' })],
      escalations: [makeEscalation({ task_id: 't2' })],
      tasks: [
        makeTask({ task_id: 't1', status: 'WAITING', waiting_reason: 'blocked' }),
        makeTask({ task_id: 't2', status: 'WAITING', waiting_reason: 'blocked' }),
      ],
    });
    expect(waitingItems(board, NOW).map((i) => i.kind)).toEqual(['approval', 'question']);
  });

  it('leaves out decided, expired-flagged and past-expiry approvals, and answered questions', () => {
    const board = makeSnapshot({
      approvals: [
        makeApproval({ approval_id: 'a1', status: 'granted' }),
        makeApproval({ approval_id: 'a2', expired: true }),
        makeApproval({ approval_id: 'a3', expires_at: '2026-10-17T09:59:59.000Z' }),
        makeApproval({ approval_id: 'a4', expires_at: null }),
        makeApproval({ approval_id: 'a5', expires_at: 'not a date' }),
      ],
      escalations: [makeEscalation({ status: 'answered' })],
    });
    expect(waitingItems(board, NOW).map((i) => i.id)).toEqual(['a4', 'a5']);
    expect(isLiveApproval(makeApproval({ expires_at: '2026-10-17T10:00:00.000Z' }), NOW)).toBe(false);
    expect(waitingItems(null, NOW)).toEqual([]);
  });

  it('says when the next listed approval expires', () => {
    const board = makeSnapshot({
      approvals: [
        makeApproval({ approval_id: 'a1', expires_at: '2026-10-17T10:05:00.000Z' }),
        makeApproval({ approval_id: 'a2', expires_at: '2026-10-17T10:01:00.000Z' }),
        makeApproval({ approval_id: 'a3', expires_at: null }),
      ],
    });
    expect(nextExpiryIn(board, NOW)).toBe(60_000);
    expect(nextExpiryIn(makeSnapshot(), NOW)).toBeNull();
    expect(nextExpiryIn(null, NOW)).toBeNull();
  });

  it('changes an item signature when what a human decides on changes', () => {
    const [a] = waitingItems(makeSnapshot({ approvals: [makeApproval()] }), NOW);
    const [b] = waitingItems(makeSnapshot({ approvals: [makeApproval({ target: 'rm -rf /' })] }), NOW);
    const [c] = waitingItems(makeSnapshot({ approvals: [makeApproval({ uses: 3 })] }), NOW);
    if (!a || !b || !c) throw new Error('missing');
    expect(itemSignature(a)).not.toBe(itemSignature(b));
    expect(itemSignature(a)).toBe(itemSignature(c));
    const [q1] = waitingItems(makeSnapshot({ escalations: [makeEscalation()] }), NOW);
    const [q2] = waitingItems(makeSnapshot({ escalations: [makeEscalation({ options: ['x'] })] }), NOW);
    if (!q1 || !q2) throw new Error('missing');
    expect(itemSignature(q1)).not.toBe(itemSignature(q2));
    const t = makeTask({ status: 'WAITING', waiting_reason: 'blocked', waiting_note: 'a' });
    const [w1] = waitingItems(makeSnapshot({ tasks: [t] }), NOW);
    const [w2] = waitingItems(makeSnapshot({ tasks: [{ ...t, waiting_note: 'b' }] }), NOW);
    if (!w1 || !w2) throw new Error('missing');
    expect(itemSignature(w1)).not.toBe(itemSignature(w2));
  });

  it('targets the Studio at the approval and its task, or the task', () => {
    const [a, q] = waitingItems(makeSnapshot({ approvals: [makeApproval()], escalations: [makeEscalation()] }), NOW);
    expect(studioTarget(a ?? null, null)).toEqual({
      task_id: 'task_0000000000000000000000aa01',
      approval_id: 'apr_000000000000000000000ap01',
    });
    expect(studioTarget(q ?? null, 'other')).toEqual({ task_id: 'task_0000000000000000000000aa01' });
    expect(studioTarget(null, 'task_x')).toEqual({ task_id: 'task_x' });
    expect(studioTarget(null, null)).toEqual({});
    const [loose] = waitingItems(makeSnapshot({ approvals: [makeApproval({ task_id: null })] }), NOW);
    expect(studioTarget(loose ?? null, null)).toEqual({ approval_id: 'apr_000000000000000000000ap01' });
  });
});

describe('waiting items: messages, memories to review and an untrusted policy (review §4, decision 6)', () => {
  it('counts a message that waits for a reply (a request, or one the sender blocks on), not a notification', () => {
    const request = makeInboxItem({ delivery_id: 'dlv_req', mode: 'request', subject: 'Which plan names?' });
    const blocking = makeInboxItem({ delivery_id: 'dlv_blk', mode: 'notification', blocking: true });
    const note = makeInboxItem({ delivery_id: 'dlv_note', mode: 'notification' });
    const reply = makeInboxItem({ delivery_id: 'dlv_resp', mode: 'response' });
    expect(awaitsReply(request)).toBe(true);
    expect(awaitsReply(blocking)).toBe(true);
    expect(awaitsReply(note)).toBe(false);
    expect(awaitsReply(reply)).toBe(false);
    const items = waitingItems(makeSnapshot({ inbox: [note, request, blocking, reply] }), NOW);
    expect(items.map((i) => i.key)).toEqual(['message:dlv_req', 'message:dlv_blk']);
    expect(items[0]).toMatchObject({ kind: 'message', id: 'dlv_req', taskId: 'task_0000000000000000000000aa01' });
    expect(waitingCount(makeSnapshot({ inbox: [note] }), NOW)).toBe(0);
  });

  it('adds one row for the memories that need review, and one for an untrusted policy, after the rest', () => {
    const board = makeSnapshot({
      approvals: [makeApproval()],
      inbox: [makeInboxItem({ mode: 'request' })],
      memories_to_review: 3,
      policy_untrusted: true,
    });
    const items = waitingItems(board, NOW);
    expect(items.map((i) => i.kind)).toEqual(['approval', 'message', 'memory', 'policy']);
    expect(items[2]).toEqual({ kind: 'memory', key: MEMORY_REVIEW_KEY, id: 'review', taskId: null, count: 3 });
    expect(items[3]).toEqual({ kind: 'policy', key: POLICY_UNTRUSTED_KEY, id: 'untrusted', taskId: null });
    // Every kind lights the one count the header, the title, the tray and the chip read.
    expect(waitingCount(board, NOW)).toBe(4);
    expect(waitingCount(makeSnapshot({ memories_to_review: 0, policy_untrusted: false }), NOW)).toBe(0);
    // A snapshot from an older daemon without the fields counts nothing for them.
    const older = makeSnapshot() as unknown as Record<string, unknown>;
    delete older.memories_to_review;
    delete older.policy_untrusted;
    expect(waitingCount(older as never, NOW)).toBe(0);
  });

  it('signs the new rows by what they show, and sends each to its place in the Studio', () => {
    const [m1] = waitingItems(makeSnapshot({ inbox: [makeInboxItem({ mode: 'request', subject: 'a' })] }), NOW);
    const [m2] = waitingItems(makeSnapshot({ inbox: [makeInboxItem({ mode: 'request', subject: 'b' })] }), NOW);
    const [r1] = waitingItems(makeSnapshot({ memories_to_review: 1 }), NOW);
    const [r2] = waitingItems(makeSnapshot({ memories_to_review: 2 }), NOW);
    const [p] = waitingItems(makeSnapshot({ policy_untrusted: true }), NOW);
    if (!m1 || !m2 || !r1 || !r2 || !p) throw new Error('missing');
    expect(itemSignature(m1)).not.toBe(itemSignature(m2));
    expect(itemSignature(r1)).not.toBe(itemSignature(r2));
    expect(itemSignature(p)).toBe(POLICY_UNTRUSTED_KEY);
    // The delivery goes along: the drawer opens on this message, as the rail's row opens it.
    expect(studioTarget(m1, 'task_x')).toEqual({ panel: 'inbox', id: 'dlv_000000000000000000000dl01' });
    expect(studioTarget(r1, 'task_x')).toEqual({ panel: 'memory', tab: 'review' });
    expect(studioTarget(p, 'task_x')).toEqual({ panel: 'settings', tab: 'policy' });
  });
});

describe('waiting items: a proposed plan (the one list the header, the rail, the title and the chip read)', () => {
  it('lists a plan proposed for an open goal after the waiting agents, not one of a finished goal', () => {
    const open = makeGoal({ goal_id: 'goal_open', request: 'Add discount codes' });
    const done = makeGoal({ goal_id: 'goal_done', status: 'COMPLETED' });
    const board = makeSnapshot({
      goals: [open, done],
      plans: {
        goal_open: { active: makePlan(), proposed: makePlan({ plan_id: 'plan_2', version: 2, status: 'PROPOSED' }) },
        goal_done: { active: null, proposed: makePlan({ status: 'PROPOSED' }) },
      },
      tasks: [makeTask({ task_id: 't1', status: 'WAITING', waiting_reason: 'blocked' })],
      inbox: [makeInboxItem({ mode: 'request' })],
    });
    const items = waitingItems(board, NOW);
    expect(items.map((i) => i.kind)).toEqual(['waiting', 'plan', 'message']);
    expect(items[1]).toEqual({
      kind: 'plan',
      key: 'plan:goal_open',
      id: 'goal_open',
      taskId: null,
      goalId: 'goal_open',
      planId: 'plan_2',
      version: 2,
      request: 'Add discount codes',
    });
    // It lights the shared count, and signs by the version proposed.
    expect(waitingCount(board, NOW)).toBe(3);
    const [plan] = waitingItems(makeSnapshot({ goals: [open], plans: board.plans }), NOW);
    const [next] = waitingItems(
      makeSnapshot({ goals: [open], plans: { goal_open: { active: null, proposed: makePlan({ version: 3 }) } } }),
      NOW,
    );
    if (!plan || !next) throw new Error('missing');
    expect(itemSignature(plan)).not.toBe(itemSignature(next));
    // Its door is the plan review of the goal.
    expect(studioTarget(plan, 'task_x')).toEqual({ panel: 'plan-review', id: 'goal_open' });
  });
});

describe('waiting items: work to verify and goals to land (review of 2026-11-16)', () => {
  const claimed = (over = {}) =>
    makeTask({
      task_id: 't1',
      status: 'READY_FOR_VERIFICATION',
      agent_key: 'claude-1',
      summary: 'Add the API',
      updated_at: new Date(NOW - 5_000).toISOString(),
      ...over,
    });

  it('lists claimed work a person verifies: always with automatic checks off, only when stuck with them on', () => {
    const manual = makeSnapshot({ tasks: [claimed()] });
    const items = waitingItems(manual, NOW);
    expect(items.map((i) => i.kind)).toEqual(['verify']);
    expect(items[0]).toMatchObject({ key: 'verify:t1', id: 't1', taskId: 't1' });
    expect(waitingCount(manual, NOW)).toBe(1);
    // Its door is the task's verification dialog.
    expect(studioTarget(items[0] ?? null, null)).toEqual({ task_id: 't1', panel: 'verify', id: 't1' });
    // Being verified, or verified: nothing waits for the person.
    expect(waitingItems(makeSnapshot({ tasks: [claimed({ status: 'VERIFYING' })] }), NOW)).toEqual([]);
    // Automatic checks on: Friday is about to check it itself...
    const auto = { checks: [], auto_on_completion: true };
    expect(waitingItems(makeSnapshot({ verification: auto, tasks: [claimed()] }), NOW)).toEqual([]);
    // ...unless it has sat there for over a minute (a check that was interrupted): then it is the person's.
    const stuck = claimed({ updated_at: new Date(NOW - 61_000).toISOString() });
    expect(waitingItems(makeSnapshot({ verification: auto, tasks: [stuck] }), NOW).map((i) => i.kind)).toEqual([
      'verify',
    ]);
  });

  it('lists a completed goal until a person landed it, and never work that is already in the folder', () => {
    const done = makeGoal({ goal_id: 'goal_done', status: 'COMPLETED', request: 'Add discount codes' });
    const land = (landing: unknown) =>
      waitingItems(
        makeSnapshot({ goals: [done], ...(landing ? { goal_landing: { goal_done: landing as never } } : {}) }),
        NOW,
      );
    expect(land({ work: 'branch', landed: null })).toEqual([
      {
        kind: 'land',
        key: 'land:goal_done',
        id: 'goal_done',
        taskId: null,
        goalId: 'goal_done',
        request: 'Add discount codes',
      },
    ]);
    expect(land({ work: 'mixed', landed: null }).map((i) => i.kind)).toEqual(['land']);
    expect(land({ work: 'folder', landed: null })).toEqual([]);
    expect(land({ work: 'branch', landed: { into: 'main', at: '2026-10-17T09:00:00.000Z' } })).toEqual([]);
    // A daemon that does not say (older): nothing is guessed.
    expect(land(null)).toEqual([]);
    const [item] = land({ work: 'branch', landed: null });
    expect(studioTarget(item ?? null, 'task_x')).toEqual({ panel: 'land', id: 'goal_done' });
    // An active goal with the same record is not listed.
    expect(
      waitingItems(
        makeSnapshot({
          goals: [makeGoal({ goal_id: 'g2', status: 'ACTIVE' })],
          goal_landing: { g2: { work: 'branch', landed: null } },
        }),
        NOW,
      ),
    ).toEqual([]);
  });

  it('says them in the status sentence, each task counted once', () => {
    const board = makeSnapshot({
      tasks: [claimed(), claimed({ task_id: 't2', status: 'VERIFYING' })],
      counts: { READY_FOR_VERIFICATION: 1, VERIFYING: 1 },
      goals: [makeGoal({ goal_id: 'goal_done', status: 'COMPLETED' })],
      goal_landing: { goal_done: { work: 'branch', landed: null } },
    });
    const sentence = statusSentence(board, NOW);
    expect(sentence).toContain('2 waiting for you: 1 task to verify, 1 goal to land; 1 to verify');
  });
});

describe('the status sentence (the Running count’s tooltip and the tray’s line)', () => {
  it('counts what runs and what waits for you, then what is ready and who is connected', () => {
    expect(statusSentence(makeScenario(), NOW)).toBe(
      '1 running, 3 waiting for you: 1 approval, 1 question, 1 blocked agent; 1 ready; 2 agents connected',
    );
    expect(runningCount(makeScenario())).toBe(1);
    expect(runningCount(null)).toBe(0);
  });

  it('says when Friday is paused and counts failures and checks to run', () => {
    const board = makeSnapshot({
      control: { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null },
      counts: { READY_FOR_VERIFICATION: 2, VERIFYING: 1, FAILED: 1, HARNESS_LOST: 1 },
      tasks: [makeTask({ status: 'FAILED' })],
      escalations: [makeEscalation({ status: 'answered' })],
    });
    expect(statusSentence(board, NOW)).toBe(
      'Paused. 0 running, 0 waiting for you: 3 to verify; 2 failed or lost; 0 agents connected',
    );
    expect(statusSentence(null, NOW)).toBe('Friday is not connected');
  });

  it('names every kind the shared rule counts, one decision once, and never an empty clause (review §4, decision 6)', () => {
    const t = makeTask({ task_id: 't1', status: 'WAITING', waiting_reason: 'blocked' });
    const goal = makeGoal({ goal_id: 'goal_1' });
    const board = makeSnapshot({
      tasks: [t, makeTask({ task_id: 't2', status: 'RUNNING' }), makeTask({ task_id: 't3', status: 'RUNNING' })],
      goals: [goal],
      plans: { goal_1: { active: null, proposed: makePlan({ status: 'PROPOSED' }) } },
      approvals: [makeApproval({ task_id: 't1' })],
      inbox: [
        makeInboxItem({ delivery_id: 'd1', mode: 'request' }),
        makeInboxItem({ delivery_id: 'd2', mode: 'request' }),
        makeInboxItem({ delivery_id: 'd3', mode: 'notification' }),
      ],
      memories_to_review: 2,
      policy_untrusted: true,
    });
    // The approval covers the blocked agent; the memory row counts once in the total.
    expect(statusSentence(board, NOW)).toBe(
      '2 running, 6 waiting for you: 1 approval, 1 proposed plan, 2 messages to reply to, 2 memories to review, 1 policy change to trust; 0 agents connected',
    );
    // Only a kind the old sentence left unnamed: no "waiting for you: ;" any more.
    expect(statusSentence(makeSnapshot({ memories_to_review: 1 }), NOW)).toBe(
      '0 running, 1 waiting for you: 1 memory to review; 0 agents connected',
    );
  });
});

describe('the active task', () => {
  it('follows the latest tool activity on a live task', () => {
    const board = makeScenario();
    const store = createStore();
    const activity = {
      ...store.select('activity'),
      agents: {
        'codex-1': {
          current: {
            at: 5,
            tool: 'Edit',
            kind: 'write' as const,
            target: 'a',
            decision: 'done' as const,
            taskId: 'task_00000000000000000000ui0001',
          },
          log: [],
          usage: null,
          model: null,
        },
      },
    };
    expect(activeTask(board, activity)?.task_id).toBe('task_00000000000000000000ui0001');
    // A newer changed file wins.
    const withFile = {
      ...activity,
      files: { task_00000000000000000000api001: [{ path: 'backend/a.ts', at: 9 }] },
    };
    expect(activeTask(board, withFile)?.task_id).toBe('task_00000000000000000000api001');
  });

  it('falls back to running, then waiting, verifying, claimed, assigned; ignores finished tasks', () => {
    const empty = createStore().select('activity');
    const t = (id: string, status: string, updated = '2026-10-17T09:00:00Z') =>
      makeTask({ task_id: id, status: status as never, updated_at: updated });
    expect(activeTask(makeSnapshot({ tasks: [t('a', 'ASSIGNED'), t('b', 'WAITING')] }), empty)?.task_id).toBe('b');
    expect(
      activeTask(
        makeSnapshot({ tasks: [t('a', 'RUNNING'), t('b', 'RUNNING', '2026-10-17T09:30:00Z'), t('c', 'WAITING')] }),
        empty,
      )?.task_id,
    ).toBe('b');
    expect(activeTask(makeSnapshot({ tasks: [t('a', 'COMPLETED'), t('b', 'READY')] }), empty)).toBeNull();
    const done = {
      ...empty,
      files: { a: [{ path: 'x', at: 1 }] },
    };
    expect(activeTask(makeSnapshot({ tasks: [t('a', 'COMPLETED'), t('b', 'VERIFYING')] }), done)?.task_id).toBe('b');
    expect(activeTask(null, empty)).toBeNull();
  });
});

describe('labels', () => {
  it('shows checks as "passed of run"', () => {
    expect(checksLine(null).text).toBe('No checks run yet');
    expect(checksLine(makeVerification()).text).toBe('1 of 1 check passed');
    const base = makeVerification().checks;
    const check = base[0];
    if (!check) throw new Error('missing check');
    const v = makeVerification({
      status: 'FAILED',
      checks: [
        ...base,
        { ...check, name: 'tests', status: 'FAILED' },
        { ...check, name: 'lint', status: 'NOT_REQUESTED' },
      ],
    });
    expect(checksLine(v)).toEqual({ passed: 1, run: 2, text: '1 of 2 checks passed' });
    expect(checksLine(makeVerification({ status: 'RUNNING' })).text).toBe('Checks running…');
    expect(checksLine(makeVerification({ checks: [] })).text).toBe('No checks run yet');
  });

  it('formats line counts, connection and names', () => {
    expect(statsText(null)).toBe('—');
    expect(statsText({ added: 14, removed: 2 })).toBe('+14 −2');
    expect(connectionLook('live')).toEqual({ label: 'Connected', tone: 'good' });
    expect(connectionLook('reconnecting').tone).toBe('warn');
    expect(connectionLook('connecting').tone).toBe('warn');
    expect(connectionLook('starting').tone).toBe('warn');
    expect(connectionLook('stopped').tone).toBe('danger');
    expect(connectionLook('signed-out').tone).toBe('muted');
    expect(projectName(null)).toBe('Friday');
    expect(taskTag(makeTask({ plan_key: null }))).toBe('task_00000000');
    expect(taskTag(makeTask({ plan_key: 'api‮exe' }))).toBe('api⟨U+202E⟩exe');
  });

  it('names the newest completed goal for the celebration', () => {
    const board = makeSnapshot({
      goals: [
        makeGoal({ goal_id: 'g1', status: 'COMPLETED', request: 'old', completed_at: '2026-10-17T08:00:00Z' }),
        makeGoal({ goal_id: 'g2', status: 'COMPLETED', request: 'new\u0007', completed_at: '2026-10-17T09:00:00Z' }),
        makeGoal({ goal_id: 'g3', status: 'ACTIVE', request: 'active' }),
      ],
    });
    expect(completedGoal(board)).toBe('new');
    expect(completedGoal(makeSnapshot())).toBeNull();
  });
});

describe('the notch model', () => {
  it('builds the active view with visible escapes in names a human reads', () => {
    const store = createStore();
    const task = makeTask({
      task_id: 't1',
      status: 'RUNNING',
      plan_key: 'k​',
      summary: `${HOSTILE}${'x'.repeat(5000)}`,
      agent_key: 'claude-1',
    });
    store.setState({
      board: makeSnapshot({
        tasks: [task],
        runs: { t1: makeRun({ task_id: 't1', branch_ref: 'friday/‮task' }) },
        project: { ...makeSnapshot().project, name: `shop‮${HOSTILE}` },
      }),
    });
    store.patch('activity', { files: { t1: [{ path: 'src/​evil.ts', at: 1 }] } });
    store.patch('ui', { stats: { t1: { added: 3, removed: 1, at: 2 } } });
    const m = buildModel(store.getState(), new IslandFsm({ timers: NO_TIMERS }).snapshot, NOW);
    expect(m.active?.tag).toBe('k⟨U+200B⟩');
    expect(m.active?.branch).toBe('friday/⟨U+202E⟩task');
    expect(m.active?.file).toEqual({ name: '⟨U+200B⟩evil.ts', path: 'src/​evil.ts' });
    expect(m.active?.stats).toEqual({ added: 3, removed: 1 });
    expect(m.active?.summary.length).toBeLessThanOrEqual(140);
    expect(m.project).not.toContain('‮');
    expect(m.running).toBe(1);
    expect(m.celebration).toBeNull();
  });

  it('has no active view without a board', () => {
    const m = buildModel(createStore().getState(), new IslandFsm({ timers: NO_TIMERS }).snapshot, NOW);
    expect(m).toMatchObject({ active: null, items: [], project: 'Friday', running: 0 });
  });
});

describe('your turn: a task kept for an agent its person runs (2026-11-17)', () => {
  const NOW = Date.parse('2026-10-17T10:00:00.000Z');
  const board = (attach: 'attach' | 'spawn', status: 'READY' | 'RUNNING' = 'READY') =>
    makeSnapshot({
      harnesses: [makeHarness({ harness_id: 'h_ag', vendor: 'antigravity', attach_mode: attach })],
      agents: [makeAgent({ agent_key: 'antigravity-1', harness_id: 'h_ag' })],
      tasks: [
        makeTask({ task_id: 't1', status, reserved_for_agent_key: 'antigravity-1', summary: 'Write the README' }),
        makeTask({ task_id: 't2', status: 'READY', reserved_for_agent_key: null }),
      ],
    });

  it('lists it as waiting for the person, with the app and the agent', () => {
    const items = waitingItems(board('attach'), NOW);
    expect(items.map((i) => i.key)).toEqual(['turn:t1']);
    expect(items[0]).toMatchObject({ kind: 'turn', taskId: 't1', agentKey: 'antigravity-1', host: 'antigravity' });
    expect(statusSentence(board('attach'), NOW)).toContain('1 task for an agent you run');
    expect(studioTarget(items[0] ?? null, null)).toEqual({ task_id: 't1' });
  });

  it('lists nothing for an agent Friday starts, nor for a task that is not waiting to be taken', () => {
    expect(waitingItems(board('spawn'), NOW)).toEqual([]);
    expect(waitingItems(board('attach', 'RUNNING'), NOW)).toEqual([]);
  });

  it('names the app and what to type there', () => {
    expect([turnHost('antigravity'), turnPrompt('antigravity')]).toEqual(['Antigravity', '/friday']);
    expect([turnHost('claude-code'), turnPrompt('claude-code')]).toEqual(['Claude Code', '/friday start']);
    expect(turnHost('something-new')).toBe('your editor');
  });
});

describe('gone quiet: a running task of an agent its person runs (2026-11-17)', () => {
  const NOW = Date.parse('2026-10-17T10:00:00.000Z');
  const board = (attach: 'attach' | 'spawn', updated: string) =>
    makeSnapshot({
      harnesses: [makeHarness({ harness_id: 'h_ag', vendor: 'antigravity', attach_mode: attach })],
      agents: [makeAgent({ agent_key: 'antigravity-1', harness_id: 'h_ag' })],
      tasks: [
        makeTask({
          task_id: 't1',
          status: 'RUNNING',
          agent_key: 'antigravity-1',
          started_at: '2026-10-17T09:00:00.000Z',
          updated_at: updated,
          summary: 'Write the README',
        }),
      ],
    });
  const longAgo = new Date(NOW - QUIET_MS - 1000).toISOString();
  const justNow = new Date(NOW - 60_000).toISOString();

  it('is listed once nothing was reported for a quarter of an hour, and opens the task', () => {
    const items = waitingItems(board('attach', longAgo), NOW);
    expect(items.map((i) => i.key)).toEqual(['quiet:t1']);
    expect(statusSentence(board('attach', longAgo), NOW)).toContain('1 agent that has gone quiet');
    expect(studioTarget(items[0] ?? null, null)).toEqual({ task_id: 't1' });
  });

  it('is not listed while it reports, nor for an agent Friday starts', () => {
    expect(waitingItems(board('attach', justNow), NOW)).toEqual([]);
    expect(waitingItems(board('spawn', longAgo), NOW)).toEqual([]);
  });
});

describe('an agent its person runs that stopped, or asks in its own window (2026-11-18)', () => {
  const NOW = Date.parse('2026-11-18T07:02:30.000Z');
  const board = (attention: Record<string, unknown> | null, attach: 'attach' | 'spawn' = 'attach') =>
    makeSnapshot({
      harnesses: [makeHarness({ harness_id: 'h_ag', vendor: 'antigravity', attach_mode: attach })],
      agents: [makeAgent({ agent_key: 'antigravity-1', harness_id: 'h_ag' })],
      tasks: [
        makeTask({
          task_id: 't1',
          status: 'RUNNING',
          agent_key: 'antigravity-1',
          started_at: '2026-11-18T06:55:11.000Z',
          updated_at: '2026-11-18T06:55:11.000Z',
          summary: 'Scaffold the owner app',
          attention: attention as never,
        }),
      ],
    });

  it('says at once that it stopped on an error of its host, and what the error means', () => {
    const items = waitingItems(
      board({
        kind: 'stopped',
        at: '2026-11-18T07:02:04.000Z',
        reason: 'error',
        error: 'Individual quota reached. Resets in 165h29m45s.',
      }),
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['stopped']);
    const item = items[0] as Extract<(typeof items)[number], { kind: 'stopped' }>;
    expect(stopWords(item.error)).toBe('quota');
    const w = attentionWords(item, 'Antigravity');
    expect(w.title).toBe('Antigravity is out of quota');
    expect(w.line).toContain('Resets in 165h29m45s');
    expect(w.line).toContain('give it to another agent');
    expect(studioTarget(item, null)).toEqual({ task_id: 't1' });
    expect(statusSentence(board({ kind: 'stopped', at: '2026-11-18T07:02:04.000Z', error: 'x' }), NOW)).toContain(
      '1 agent that has stopped',
    );
    // Its servers being busy is another thing to do.
    expect(stopWords('UNAVAILABLE (code 503): No capacity available for model gemini-3.8-flash-high')).toBe('busy');
    expect(stopWords('something else broke')).toBeNull();
  });

  it('waits a moment for a turn that ended without an error, says it once, and never for an agent Friday starts', () => {
    const justNow = new Date(NOW - 5_000).toISOString();
    const earlier = new Date(NOW - STOPPED_GRACE_MS - 1_000).toISOString();
    expect(waitingItems(board({ kind: 'stopped', at: justNow }), NOW)).toEqual([]);
    const items = waitingItems(board({ kind: 'stopped', at: earlier }), NOW);
    expect(items.map((i) => i.kind)).toEqual(['stopped']);
    expect(attentionWords(items[0] as never, 'Antigravity').line).toContain('waiting for you in its own window');
    // Twenty minutes on it is still said once: not also as "gone quiet".
    const late = waitingItems(board({ kind: 'stopped', at: earlier }), NOW + 20 * 60_000);
    expect(late.map((i) => i.kind)).toEqual(['stopped']);
    expect(waitingItems(board({ kind: 'stopped', at: earlier }, 'spawn'), NOW)).toEqual([]);
  });

  it('says that its host asks the person in its own window, for a rule of Friday', () => {
    const items = waitingItems(
      board({
        kind: 'asking',
        at: '2026-11-18T07:09:00.000Z',
        tool: 'Bash',
        target: 'npm install',
        rule: 'package.install commands need a human decision.',
      }),
      NOW,
    );
    expect(items.map((i) => i.kind)).toEqual(['asking']);
    const w = attentionWords(items[0] as never, 'Antigravity');
    expect(w.title).toBe('Antigravity is asking you something');
    expect(w.line).toContain('“npm install”');
    expect(w.line).toContain('own window');
  });
});

describe('an answer that waits to be read (2026-11-18)', () => {
  const GID = 'goal_0000000000000000000000gg01';
  const board = (a: Record<string, unknown> | null) =>
    makeSnapshot({
      goals: [makeGoal({ mode: 'ask', status: 'COMPLETED', request: 'How do price revisions work?' })],
      ...(a
        ? {
            answers: {
              [GID]: {
                goal_id: GID,
                question: 'How do price revisions work?',
                state: 'ready',
                task_id: 't1',
                agent_key: 'claude-1',
                summary: 'Each change is a new row',
                preview: 'A price is kept per outlet.',
                note: null,
                at: '2026-11-18T07:00:00.000Z',
                read: false,
                ...a,
              } as never,
            },
          }
        : {}),
    });
  const NOW = Date.parse('2026-11-18T07:02:30.000Z');

  it('is listed with how it begins until its person opens it, and opens the answer', () => {
    const items = waitingItems(board({}), NOW);
    expect(items.map((i) => i.kind)).toEqual(['answer']);
    const item = items[0] as Extract<(typeof items)[number], { kind: 'answer' }>;
    expect(item).toMatchObject({
      goalId: GID,
      preview: 'A price is kept per outlet.',
      agentKey: 'claude-1',
      failed: false,
    });
    expect(studioTarget(item, null)).toEqual({ panel: 'answer', id: GID });
    expect(statusSentence(board({}), NOW)).toContain('1 answer to read');
    // Opened: it no longer waits. And a question has nothing to land.
    expect(waitingItems(board({ read: true }), NOW)).toEqual([]);
  });

  it('is not listed while the agent is still at it, and is listed when it ended without one', () => {
    expect(waitingItems(board({ state: 'answering', preview: null, summary: null }), NOW)).toEqual([]);
    expect(waitingItems(board({ state: 'waiting' }), NOW)).toEqual([]);
    const failed = waitingItems(board({ state: 'failed', preview: null, summary: null }), NOW);
    expect(failed).toMatchObject([{ kind: 'answer', failed: true, preview: null }]);
    // A board from an older daemon has no answers: nothing is listed, nothing breaks.
    expect(waitingItems(board(null), NOW)).toEqual([]);
  });
});
