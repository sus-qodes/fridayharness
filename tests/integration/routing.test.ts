/**
 * Model routing through the daemon (plan M7a–M7b, ADR-0031; spec Part 12 §9, §11): every run is
 * routed, binding where the harness applies models and advisory where it does not; a human's pin
 * wins; the model that ran is recorded; verified outcomes become evidence.
 */
import { claudeCodeHooks } from '@friday/adapter-claude';
import type { RunView, TaskStartParams, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSession } from '../helpers/claude-session.js';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { postHook } from '../helpers/hooks.js';

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

const inspect = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView; runs: RunView[] }>(td.operator.projectPath(`/tasks/${id}`));

describe('model routing', () => {
  it('binds a harness that applies models, advises one that does not, and follows a human pin', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const dir = ws().projectDir;
    // A spawn adapter that applies the model it is given, and can run two models.
    const fake = await FakeHarness.connect(td, {
      agentKey: 'spawned',
      capabilities: { task_start: true, model_control: 'set', models: ['claude-opus-5-5', 'claude-haiku-5-5'] },
    });
    const t1 = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Fix a difficult TypeScript generic inference bug',
      kind: 'implementation',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await td.operator.post(td.operator.projectPath(`/tasks/${t1.task_id}/assign`), { agent_key: 'spawned' });
    const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
    expect(start).toMatchObject({ model: 'claude-opus-5-5', model_binding: true });
    // What was recorded (Part 12 §9): the model, the reason, the evidence and the fallback.
    const explained = await cli(['--project', dir, 'routing', 'explain', t1.task_id]);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.stdout).toContain('claude-opus-5-5 (score, mode hybrid, class implementation, binding)');
    expect(explained.stdout).toContain('no measured outcomes yet');
    expect(explained.stdout).toContain('fallback: claude-haiku-5-5 -> a human');
    expect(explained.stdout).toContain('excluded claude-sonnet-5-5: harness.cannot_run');
    // The adapter reports what actually ran.
    await fake.client.emitEvent({
      task_id: t1.task_id,
      run_id: start.run_id,
      event_type: 'model.observed',
      data: { model: 'claude-opus-5-5', basis: 'reported' },
    });
    expect((await inspect(td, t1.task_id)).runs.at(-1)).toMatchObject({
      model_requested: 'claude-opus-5-5',
      model_observed: 'claude-opus-5-5',
      model_basis: 'reported',
    });

    // An attached Claude Code session gets advice, and says which model it runs.
    const pinned = await cli([
      '--project',
      dir,
      'routing',
      'pin',
      '--kind',
      'docs',
      '--model',
      'claude-haiku-5-5',
      '--until',
      '7d',
      '--note',
      'docs are cheap this week',
    ]);
    expect(pinned.code, pinned.stderr).toBe(0);
    const s = await claudeSession(td, ws(), { write: ['docs/**'] });
    const t2 = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Document the checkout flow',
      kind: 'docs',
      scope: { write: ['docs/**'], read: [] },
      assign_agent_key: s.agent,
    });
    await s.client.call('task.release', {
      task_id: s.task.task_id,
      run_id: s.run_id,
      reason: 'handoff',
      note: 'docs first',
    });
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    await postHook(daemon, 'SessionStart', {
      session_id: (s.client.descriptor.host as { session_id: string }).session_id,
      cwd: dir,
      hook_event_name: 'SessionStart',
      source: 'resume',
      model: 'claude-sonnet-5-5',
    });
    const claimed = await s.client.claim({ task_id: t2.task_id });
    expect(claimed.routing).toMatchObject({ model: 'claude-haiku-5-5', binding: false });
    expect(claimed.routing?.reason).toContain('pinned by human:local-operator');
    expect(claimed.routing?.reason).toContain('advisory');
    const run = (await inspect(td, t2.task_id)).runs.at(-1);
    expect(run).toMatchObject({
      model_requested: 'claude-haiku-5-5',
      model_binding: false,
      model_observed: 'claude-sonnet-5-5',
    });

    // A verified outcome is evidence for the model that ran, not the one suggested.
    await s.client.reportResult({
      task_id: t2.task_id,
      run_id: claimed.run_id,
      status: 'completed_claim',
      summary: 'documented',
      changed_paths: [],
      checks: [],
    });
    expect((await cli(['--project', dir, 'verify', t2.task_id, '--result', 'passed'])).code).toBe(0);
    const models = await cli(['--project', dir, 'models']);
    expect(models.stdout).toMatch(/claude-sonnet-5-5\s+docs\s+1\s+100% \(too few\)/);
    const pins = await cli(['--project', dir, 'routing', 'pins']);
    expect(pins.stdout).toContain('model claude-haiku-5-5 for kind docs, by human:local-operator until');
  }, 120_000);
});
