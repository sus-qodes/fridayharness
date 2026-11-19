import { describe, expect, it } from 'vitest';
import { makeAgent, makeApproval, makeGoal, makeRun, makeSnapshot, makeTask } from '../test/fixtures.js';
import { goalCardHeight, NODE_SIZE } from './board.js';
import { goalStory, STORY_MAX, storyHeight, storyOfGoal } from './story.js';

const GOAL = 'goal_0000000000000000000000gg01';
const HOSTILE = '<img src=x onerror=alert(1)>';

/** One goal, three screens planned side by side and a closing documents task, part-way through. */
function board() {
  return makeSnapshot({
    goals: [makeGoal({ goal_id: GOAL })],
    agents: [
      makeAgent({ agent_id: 'a_claude', agent_key: 'claude-1' }),
      makeAgent({ agent_id: 'a_codex', agent_key: 'codex-1' }),
    ],
    tasks: [
      makeTask({ task_id: 't_wizard', goal_id: GOAL, summary: 'Wizard screens', status: 'COMPLETED' }),
      makeTask({
        task_id: 't_settings',
        goal_id: GOAL,
        summary: 'Settings screens',
        status: 'RUNNING',
        agent_key: 'codex-1',
      }),
      makeTask({
        task_id: 't_menu',
        goal_id: GOAL,
        summary: 'Menu screens',
        status: 'WAITING',
        waiting_reason: 'human_approval',
        agent_key: 'claude-1',
      }),
      makeTask({
        task_id: 't_docs',
        goal_id: GOAL,
        summary: 'Update the documents',
        status: 'PROPOSED',
        delegation_note: 'waits for “Settings screens” (codex-1 is working on it)',
        waits_for: 'dependencies',
      }),
      makeTask({ task_id: 't_other', goal_id: 'goal_other', summary: 'Another goal’s task', status: 'RUNNING' }),
    ],
    runs: { t_wizard: makeRun({ task_id: 't_wizard', agent_id: 'a_claude' }) },
  });
}

describe("a goal's story (2026-11-18)", () => {
  it('says what needs the person first, then who works on what, what waits and why, and what is finished', () => {
    const lines = storyOfGoal(board(), GOAL);
    expect(lines.map((l) => [l.tone, l.text])).toEqual([
      ['you', 'claude-1 needs you for “Menu screens”'],
      ['work', 'codex-1 is working on “Settings screens”'],
      ['wait', '“Update the documents” waits for “Settings screens” (codex-1 is working on it)'],
      ['done', 'claude-1 finished “Wizard screens”'],
    ]);
    expect(lines.map((l) => l.taskId)).toEqual(['t_menu', 't_settings', 't_docs', 't_wizard']);
  });

  it('counts what does not fit instead of dropping it, the unfinished before the finished', () => {
    const b = board();
    const many = makeSnapshot({
      ...b,
      tasks: [
        ...b.tasks,
        makeTask({ task_id: 't_a', goal_id: GOAL, summary: 'Reports', status: 'READY' }),
        makeTask({ task_id: 't_b', goal_id: GOAL, summary: 'Exports', status: 'COMPLETED' }),
      ],
    });
    const lines = storyOfGoal(many, GOAL);
    expect(lines).toHaveLength(STORY_MAX);
    expect(lines.at(-1)).toMatchObject({ taskId: null, text: 'and 1 more not finished, 2 finished' });
    expect(lines.slice(0, 3).map((l) => l.tone)).toEqual(['you', 'work', 'wait']);
  });

  it('names no task when the goal has one, and says nothing for a question or a goal without tasks', () => {
    const one = makeSnapshot({
      goals: [makeGoal({ goal_id: GOAL })],
      tasks: [
        makeTask({ task_id: 't1', goal_id: GOAL, summary: 'Fix the footer', status: 'RUNNING', agent_key: 'claude-1' }),
      ],
    });
    expect(storyOfGoal(one, GOAL).map((l) => l.text)).toEqual(['claude-1 is working on it']);
    const asked = makeSnapshot({ ...one, goals: [makeGoal({ goal_id: GOAL, mode: 'ask' })] });
    expect(storyOfGoal(asked, GOAL)).toEqual([]);
    expect(storyOfGoal(makeSnapshot({ goals: [makeGoal({ goal_id: GOAL })], tasks: [] }), GOAL)).toEqual([]);
    expect(storyOfGoal(null, GOAL)).toEqual([]);
  });

  it('tells each stage of a task in words of its own', () => {
    const say = (task: Parameters<typeof makeTask>[0], extra: Partial<Parameters<typeof goalStory>[0]> = {}) =>
      goalStory({
        tasks: [
          makeTask({ task_id: 't1', summary: 'Wizard', agent_key: 'claude-1', ...task }),
          makeTask({ task_id: 't2' }),
        ],
        runs: {},
        integrations: {},
        agentKeyOf: () => null,
        asked: new Set(),
        ...extra,
      })
        .filter((l) => l.taskId === 't1')
        .map((l) => [l.tone, l.text])[0];
    expect(say({ status: 'VERIFYING' })).toEqual(['work', 'Friday is checking “Wizard”']);
    expect(say({ status: 'REWORK' })).toEqual(['work', '“Wizard” goes back to claude-1']);
    expect(say({ status: 'HARNESS_LOST' })).toEqual(['you', 'claude-1 stopped on “Wizard”']);
    expect(say({ status: 'RUNNING' }, { asked: new Set(['t1']) })).toEqual(['you', 'claude-1 needs you for “Wizard”']);
    expect(say({ status: 'CANCELLED' })).toBeUndefined();
    // Kept for an agent the person runs: that is theirs to start.
    expect(
      say({
        status: 'READY',
        agent_key: null,
        delegation_note: 'kept for antigravity-1, which takes it when you prompt it in its window',
        waits_for: 'your_turn',
      }),
    ).toEqual(['you', '“Wizard”: kept for antigravity-1, which takes it when you prompt it in its window']);
    expect(say({ status: 'READY', agent_key: null })).toEqual(['wait', '“Wizard” has not started']);
    // Finished, but its work does not fit the other tasks' yet and went back as often as it may.
    const unfit = { t1: { status: 'conflicted' } } as unknown as Parameters<typeof goalStory>[0]['integrations'];
    expect(say({ status: 'COMPLETED' }, { integrations: unfit })?.[0]).toBe('you');
  });

  it('takes a pending approval of a task as needing the person, and shows names as text', () => {
    const b = makeSnapshot({
      goals: [makeGoal({ goal_id: GOAL })],
      tasks: [
        makeTask({ task_id: 't1', goal_id: GOAL, summary: HOSTILE, status: 'RUNNING', agent_key: 'claude-1' }),
        makeTask({ task_id: 't2', goal_id: GOAL, summary: 'Other', status: 'READY' }),
      ],
      approvals: [makeApproval({ task_id: 't1' })],
    });
    const [first] = storyOfGoal(b, GOAL);
    expect(first).toMatchObject({ tone: 'you' });
    expect(first?.text).toContain(HOSTILE);
  });

  it('adds exactly its lines to the height the layout reserves for the goal card', () => {
    const goal = makeGoal({ constraints: [], inferred_constraints: [] });
    expect(storyHeight(0)).toBe(0);
    expect(goalCardHeight(goal)).toBe(NODE_SIZE.goal.h);
    expect(goalCardHeight(goal, 3)).toBe(NODE_SIZE.goal.h + 6 + 3 * 18);
  });
});
