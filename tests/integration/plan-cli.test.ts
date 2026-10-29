/**
 * `friday plan` subcommands with `--goal` and `--version` (LESSONS D-47). The parent `plan` command
 * has the same options and took them for itself: `plan propose --goal X` failed with "required option
 * '--goal <goal>' not specified", and `plan approve --goal X` acted on the newest goal instead of X.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GoalView } from '@friday/protocol';
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

const planFile = (name: string, summary: string) => {
  const file = path.join(ws().root, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      objective: `${summary} for the shop`,
      summary: `${summary}, in one task`,
      tasks: [
        { key: 'only', summary, acceptance_criteria: ['node --test passes'], scope: { write: ['src/**'], read: [] } },
      ],
    }),
  );
  return file;
};

interface Detail {
  goal: GoalView;
  active: { version: number } | null;
  proposed: { version: number } | null;
}

describe('friday plan with --goal', () => {
  it('proposes and approves the plan of the goal named, not of the newest goal', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const goal = (request: string) =>
      td.operator.post<GoalView>(td.operator.projectPath('/goals'), {
        request,
        constraints: [],
        outcomes: [],
        priority: 'normal',
        plan: false,
      });
    const detail = (id: string) => td.operator.get<Detail>(td.operator.projectPath(`/goals/${id}`));
    const first = await goal('Add the first feature');
    const second = await goal('Add the second feature');

    const proposed = await cli([
      '--project',
      dir,
      'plan',
      'propose',
      '--goal',
      first.goal_id,
      '--file',
      planFile('first', 'First feature'),
    ]);
    expect(proposed.code, proposed.stderr).toBe(0);
    expect((await detail(first.goal_id)).proposed?.version).toBe(1);

    // The second goal is the newest: a plan for it, then approving the first by name.
    await cli(['--project', dir, 'plan', 'propose', '--goal', second.goal_id, '--file', planFile('second', 'Second')]);
    const approved = await cli(['--project', dir, 'plan', 'approve', '--goal', first.goal_id]);
    expect(approved.code, approved.stderr).toBe(0);
    expect((await detail(first.goal_id)).active?.version).toBe(1);
    expect((await detail(second.goal_id)).active).toBeNull();
    expect((await detail(second.goal_id)).proposed?.version).toBe(1);

    // The option before the subcommand works too.
    const before = await cli(['--project', dir, 'plan', '--goal', second.goal_id, 'reject', '--note', 'not now']);
    expect(before.code, before.stderr).toBe(0);
    expect((await detail(second.goal_id)).proposed).toBeNull();
  });
});
