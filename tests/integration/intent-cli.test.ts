/**
 * `friday intent` and the goal intent flags end to end (ADR-0034 §1–§3; plan Phase 3.2): a real
 * daemon, a scripted Master Brain and the CLI as a person types it.
 */
import { FakePlannerModel } from '@friday/planner';
import type { GoalView, ProjectIntentView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

interface IntentState {
  approved: ProjectIntentView | null;
  proposed: ProjectIntentView | null;
}

const DRAFT = {
  objective: 'A small test project that proves Friday works.',
  constraints: [{ text: 'Keep the README accurate.', from_paths: ['README.md'] }],
  outcomes: [],
  non_goals: [],
  definition_of_done: [],
};

describe('friday intent', () => {
  it('drafts from the README, takes your edit, and counts only once you approve', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: { model: new FakePlannerModel([{ purpose: 'intent', output: DRAFT }]), autoStart: false },
    });
    const dir = ws().projectDir;
    const state = () => td.operator.get<IntentState>(td.operator.projectPath('/intent'));

    const empty = await cli(['--project', dir, 'intent']);
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stdout).toContain('No approved project intent yet');
    expect(empty.stdout).toContain('friday intent draft');

    const drafted = await cli(['--project', dir, 'intent', 'draft']);
    expect(drafted.code, drafted.stderr).toBe(0);
    expect(drafted.stdout).toContain('Project intent v1  proposed  (drafted by Friday');
    expect(drafted.stdout).toContain('Keep the README accurate. (Friday, from README.md)');
    expect((await state()).approved).toBeNull();

    // Your change becomes a new proposal; the planner's line you kept stays marked as Friday's.
    const edited = await cli(['--project', dir, 'intent', 'edit', '--non-goal', 'No hosted service.']);
    expect(edited.code, edited.stderr).toBe(0);
    const v2 = (await state()).proposed;
    expect(v2?.version).toBe(2);
    expect(v2?.constraints[0]).toMatchObject({ source: 'planner', from_paths: ['README.md'] });
    expect(v2?.non_goals).toEqual([{ text: 'No hosted service.', source: 'human', from_paths: [] }]);

    const same = await cli(['--project', dir, 'intent', 'edit', '--non-goal', 'No hosted service.']);
    expect(same.stdout).toContain('Nothing changed');

    const approved = await cli(['--project', dir, 'intent', 'approve', '--note', 'right']);
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.stdout).toContain('Approved project intent v2.');
    const s = await state();
    expect(s.approved?.version).toBe(2);
    expect(s.proposed).toBeNull();

    const history = await cli(['--project', dir, '--json', 'intent', 'history']);
    const { versions } = JSON.parse(history.stdout) as { versions: ProjectIntentView[] };
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'approved'],
      [1, 'superseded'],
    ]);

    // Nothing waits: approve has nothing to act on.
    const nothing = await cli(['--project', dir, 'intent', 'approve']);
    expect(nothing.code).not.toBe(0);
    expect(nothing.stderr).toContain('no project intent is waiting');
  });

  it('works without a Master Brain: drafting says why, editing still proposes', async () => {
    await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const draft = await cli(['--project', dir, 'intent', 'draft']);
    expect(draft.code).not.toBe(0);
    expect(draft.stderr).toContain('Master Brain is not running');

    const noBase = await cli(['--project', dir, 'intent', 'edit', '--non-goal', 'x']);
    expect(noBase.code).not.toBe(0);
    expect(noBase.stderr).toContain('give --objective');

    const written = await cli([
      '--project',
      dir,
      'intent',
      'edit',
      '--objective',
      'Prove Friday works.',
      '--done',
      'Tests pass.',
      '--approve',
    ]);
    expect(written.code, written.stderr).toBe(0);
    expect(written.stdout).toContain('Project intent v1  approved');
    expect(written.stdout).toContain('done when: Tests pass.');
  });
});

describe('goal intent from the CLI', () => {
  it('creates a goal with non-goals and a definition of done, and edits them by revision', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const created = await cli([
      '--project',
      dir,
      '--json',
      'goal',
      'create',
      'Refactor the video cards',
      '--non-goal',
      'No new npm packages.',
      '--done',
      'The dashboard builds.',
      '--no-plan',
    ]);
    expect(created.code, created.stderr).toBe(0);
    const { goal } = JSON.parse(created.stdout) as { goal: GoalView };
    expect(goal).toMatchObject({
      non_goals: ['No new npm packages.'],
      definition_of_done: ['The dashboard builds.'],
      intent_revision: 1,
    });

    const edited = await cli([
      '--project',
      dir,
      'goal',
      'edit',
      goal.goal_id,
      '--done',
      'The dashboard builds and lints.',
    ]);
    expect(edited.code, edited.stderr).toBe(0);
    expect(edited.stdout).toContain('Intent revision 2.');
    expect(edited.stdout).toContain('done when: The dashboard builds and lints.');
    expect(edited.stdout).toContain('non-goal: No new npm packages.');

    const again = await cli([
      '--project',
      dir,
      'goal',
      'edit',
      goal.goal_id,
      '--done',
      'The dashboard builds and lints.',
    ]);
    expect(again.stdout).toContain('Nothing changed');

    const cleared = await cli(['--project', dir, 'goal', 'edit', goal.goal_id, '--clear', 'non-goals']);
    expect(cleared.code, cleared.stderr).toBe(0);
    const after = await td.operator.get<{ goal: GoalView }>(td.operator.projectPath(`/goals/${goal.goal_id}`));
    expect(after.goal.non_goals).toEqual([]);
    expect(after.goal.intent_revision).toBe(3);

    const nothing = await cli(['--project', dir, 'goal', 'edit', goal.goal_id]);
    expect(nothing.code).not.toBe(0);
    expect(nothing.stderr).toContain('nothing to change');
  });
});
