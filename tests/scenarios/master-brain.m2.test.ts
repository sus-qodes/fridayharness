/**
 * The M2 gate (plan M2) on fixture-shop, as a script: a real `friday run` daemon with the fake
 * planner configured in `.friday/config.yaml`, two FakeHarness agents, and only CLI commands for
 * the human's part. The same steps with Claude as the planner run once an API key is available.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { materializeFixtureShop } from '@friday/cli';
import type { GoalView, TaskView } from '@friday/protocol';
import { DaemonClient, loadProject } from '@friday/sdk';
import { useTestWorkspace, waitForExit } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT, spawnFridayRun } from '../helpers/cli.js';
import type { TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'planner', 'stripe-subscriptions');
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

interface Detail {
  goal: GoalView;
  active: {
    version: number;
    status: string;
    tasks: { key: string; task_id: string | null; status: string | null; agent_key: string | null }[];
  } | null;
  proposed: {
    version: number;
    tasks: { key: string; change: string }[];
    needs_human: { question: string } | null;
  } | null;
  escalations: { kind: string | null; question: string }[];
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 500)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('M2 gate on fixture-shop', () => {
  it('goal → plan v1 (4 tasks) → approve → two agents in parallel → a failed verification → plan v2 with a rework → a question for the human', async () => {
    const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
    appendFileSync(
      path.join(root, '.friday', 'config.yaml'),
      `\nmaster_brain:\n  provider: fake\n  fake_responses: ${JSON.stringify(FIXTURES)}\n`,
    );
    const daemon = await spawnFridayRun(ws(), 30_000, root);
    const ref = loadProject(root);
    const operator = DaemonClient.forProject(ref, 'operator', { clientName: 'gate' });
    const td = {
      url: daemon.url,
      project: ref,
      bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'gate' }),
    } as unknown as TestDaemon;
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const fe = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    ws().track({ close: () => Promise.all([be.close(), fe.close()]) });
    const friday = (...args: string[]) => cli(['--project', root, ...args]);

    // 1. The goal: the Master Brain proposes plan v1 with four tasks.
    const created = await friday(
      'goal',
      'create',
      'Add Stripe subscriptions, keep one-time checkout working, add tests',
      '--wait',
      '20',
    );
    expect(created.code, created.stderr).toBe(0);
    expect(created.stdout).toContain('Waiting for your decision:');
    const goalId = (await operator.get<{ goals: GoalView[] }>(operator.projectPath('/goals'))).goals[0]
      ?.goal_id as string;
    const detail = () => operator.get<Detail>(operator.projectPath(`/goals/${goalId}`));
    expect((await detail()).proposed?.tasks.map((t) => t.key)).toEqual([
      'billing-service',
      'subscribe-page',
      'stripe-webhooks',
      'lifecycle-tests',
    ]);

    // 2. Approve: the two independent tasks start at once, one per agent.
    expect((await friday('plan', 'approve')).code).toBe(0);
    const running = await until(
      detail,
      (d) => d.active?.tasks.filter((t) => t.status === 'RUNNING').length === 2,
      'two running tasks',
    );
    const task = (key: string) =>
      running.active?.tasks.find((t) => t.key === key) as { task_id: string; agent_key: string };
    expect([task('billing-service').agent_key, task('subscribe-page').agent_key]).toEqual(['be-1', 'fe-1']);

    // 3. Both agents claim completion; verification passes the backend and fails the frontend.
    for (const [agent, key] of [
      [be, 'billing-service'],
      [fe, 'subscribe-page'],
    ] as const) {
      const t = (await operator.get<{ task: TaskView }>(operator.projectPath(`/tasks/${task(key).task_id}`))).task;
      await agent.client.reportResult({
        task_id: t.task_id,
        run_id: t.current_run_id as string,
        status: 'completed_claim',
        summary: `${key} done`,
        changed_paths: [],
      });
    }
    expect((await friday('verify', task('billing-service').task_id, '--result', 'passed')).code).toBe(0);
    expect(
      (await friday('verify', task('subscribe-page').task_id, '--result', 'failed', '--note', 'price test expects VAT'))
        .code,
    ).toBe(0);

    // 4. The Master Brain revises: plan v2 reworks the failed task and asks the human a question.
    const revised = await until(
      detail,
      (d) => d.proposed?.version === 2 && d.escalations.length > 0,
      'plan v2 and an escalation',
    );
    expect(revised.proposed?.tasks.find((t) => t.key === 'subscribe-page')?.change).toBe('rework');
    expect(revised.escalations[0]).toMatchObject({
      kind: 'ambiguous_intent',
      question: 'Should subscription prices on the subscribe page include VAT?',
    });
    const shown = await friday('goal', 'show');
    for (const s of ['plan', 'v2 PROPOSED', 'rework subscribe-page', 'Question for a human', 'friday answer'])
      expect(shown.stdout).toContain(s);
    // Meanwhile the backend line continues: webhooks became READY and went to be-1.
    expect((await detail()).active?.tasks.find((t) => t.key === 'stripe-webhooks')).toMatchObject({
      agent_key: 'be-1',
    });

    const stop = await friday('daemon', 'stop');
    expect(stop.code).toBe(0);
    expect((await waitForExit(daemon.child, 15_000)).code).toBe(0);
  });
});
