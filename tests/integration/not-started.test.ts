/**
 * Why a task that has not started is not at work (2026-11-18): the board says it for every such
 * task, from the state as it is now, and "Your turn" is said only when prompting the agent would
 * start the task.
 */
import type { TaskStartParams, UiSnapshot } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

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

const runOnce = (td: TestDaemon) => td.operator.post(td.operator.projectPath('/brain/run-once'), {});

async function goal(td: TestDaemon) {
  const op = td.operator;
  const g = await op.post<{ goal_id: string }>(op.projectPath('/goals'), { request: 'Three screens', plan: false });
  const task = (key: string, write: string[], depends_on: string[] = []) => ({
    key,
    summary: `The ${key} screens`,
    acceptance_criteria: ['it works'],
    scope: { write, read: ['**'] },
    depends_on,
  });
  const v = await op.post<{ plan_id: string; version: number }>(op.projectPath(`/goals/${g.goal_id}/plans`), {
    draft: {
      objective: 'Three screens',
      summary: 'two side by side, then the documents',
      tasks: [
        task('wizard', ['web/wizard/**', 'web/routes.ts']),
        task('settings', ['web/settings/**', 'web/routes.ts']),
        task('documents', ['docs/**'], ['wizard', 'settings']),
      ],
    },
  });
  await op.post(op.projectPath(`/plans/${v.plan_id}/versions/${v.version}/approve`), {});
  return g.goal_id;
}

describe('a task that has not started says why', () => {
  it('names what it waits for, who has it next, and when it is the person’s turn', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: { autoStart: false } });
    const goalId = await goal(td);
    const board = async () => {
      const s = await td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));
      const of = (key: string) => {
        const t = s.tasks.find((x) => x.goal_id === goalId && x.summary === `The ${key} screens`);
        return { status: t?.status, why: t?.delegation_note ?? null, code: t?.waits_for ?? null, id: t?.task_id };
      };
      return { wizard: of('wizard'), settings: of('settings'), documents: of('documents') };
    };

    // Nobody is connected: the two that can start say so; the third names what it waits for.
    await runOnce(td);
    let b = await board();
    expect(b.wizard).toMatchObject({ status: 'READY', code: 'no_agent' });
    expect(b.wizard.why).toBe('no agent is connected. Start one under Agents');
    expect(b.documents).toMatchObject({ status: 'PROPOSED', code: 'dependencies' });
    expect(b.documents.why).toMatch(/^waits for “The (wizard|settings) screens” \(not started\), “The /);
    expect(b.documents.why).toContain('“The wizard screens” (not started)');
    expect(b.documents.why).toContain('“The settings screens” (not started)');

    // One agent Friday starts: it takes one, and the other waits for an agent, not for a file.
    const claude = await FakeHarness.connect(td, { agentKey: 'claude-1' });
    await runOnce(td);
    const start = (await claude.waitFor('task.start', 20_000)).params as TaskStartParams;
    for (
      let i = 0;
      i < 200 && td.daemon.state.q.task(td.project.project_id, start.task_id).status !== 'RUNNING';
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await runOnce(td);
    b = await board();
    const [running, waiting] =
      b.wizard.status === 'RUNNING' ? (['wizard', 'settings'] as const) : (['settings', 'wizard'] as const);
    expect(b[running]).toMatchObject({ status: 'RUNNING', why: null, code: null });
    expect(b[waiting]).toMatchObject({ status: 'READY', code: 'no_agent', why: 'no agent is free right now' });
    expect(b.documents.why).toContain(`“The ${running} screens” (claude-1 is working on it)`);

    // A person keeps the waiting one for an agent they run themselves: now it is their turn.
    const editor = await FakeHarness.connect(td, { agentKey: 'antigravity-1', mode: 'attach' });
    await td.operator.post(td.operator.projectPath(`/tasks/${b[waiting].id}/assign`), { agent_key: 'antigravity-1' });
    b = await board();
    expect(b[waiting]).toMatchObject({
      status: 'READY',
      code: 'your_turn',
      why: 'kept for antigravity-1, which takes it when you prompt it in its window',
    });

    // Paused, nothing starts, whoever is prompted: it says that instead.
    await td.operator.post(td.operator.projectPath('/control/pause'), { reason: 'lunch' });
    b = await board();
    expect(b[waiting]).toMatchObject({
      code: 'paused',
      why: 'Friday is paused: nothing new starts until you resume it',
    });
    await td.operator.post(td.operator.projectPath('/control/resume'), {});

    // Its agent's window is closed: no "your turn" for a window that is not there.
    await editor.close();
    b = await board();
    expect(b[waiting].code).toBe('agent_away');
    expect(b[waiting].why).toContain('kept for antigravity-1, which is not connected');
    await claude.close();
  }, 90_000);
});
