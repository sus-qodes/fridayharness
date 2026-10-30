/**
 * Model routing through the daemon (plan M7a–M7b, ADR-0031; spec Part 12 §9, §11): every run is
 * routed, binding where the harness applies models and advisory where it does not; a human's pin
 * wins; the model that ran is recorded; verified outcomes become evidence.
 */
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
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
  it('passes task facts into deterministic profiles and preserves a pin over the profile default', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const cases = [
      {
        expected: 'short',
        summary: 'Fix one file',
        risk_level: 'low' as const,
        scope: { write: ['src/a.ts'], read: [] },
      },
      {
        expected: 'medium',
        summary: 'Update related modules',
        risk_level: 'low' as const,
        scope: { write: ['src/a.ts', 'src/b.ts', 'src/c.ts'], read: [] },
      },
      {
        expected: 'large',
        summary: 'Refactor the source tree',
        risk_level: 'low' as const,
        scope: { write: ['src/**'], read: [] },
      },
      {
        expected: 'high-risk',
        summary: 'Change payment authorization',
        risk_level: 'high' as const,
        scope: { write: ['src/payments.ts'], read: [] },
      },
      { expected: 'ambiguous', summary: 'Needs clarification', risk_level: 'low' as const, scope: null },
    ];
    for (const [index, facts] of cases.entries()) {
      const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
        summary: facts.summary,
        kind: 'implementation',
        risk_level: facts.risk_level,
        scope: facts.scope ?? undefined,
      });
      const explained = await td.operator.get<{ dry_run: { profile: string; blocked: boolean } }>(
        td.operator.projectPath(`/routing/explain/${task.task_id}`),
      );
      expect(explained.dry_run, `case ${index}`).toMatchObject({
        profile: facts.expected,
        blocked: facts.expected === 'ambiguous',
      });
    }

    await td.operator.post(td.operator.projectPath('/routing/pins'), {
      scope: 'kind',
      target: 'implementation',
      model: 'claude-opus-5-5',
      mode: null,
      sensitive: false,
      needs_vision: false,
      until: null,
      note: 'human precedence test',
    });
    const pinned = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Fix one file',
      kind: 'implementation',
      risk_level: 'low',
      scope: { write: ['src/pinned.ts'], read: [] },
    });
    const explained = await td.operator.get<{ dry_run: { model: string | null; profile: string; source: string } }>(
      td.operator.projectPath(`/routing/explain/${pinned.task_id}`),
    );
    expect(explained.dry_run).toMatchObject({ model: 'claude-opus-5-5', profile: 'short', source: 'pin' });
  }, 120_000);

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
    expect(explained.stdout).toContain('profile: large (scope contains a glob pattern)');
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

  it('starts no work its route forbids, assigned, claimed or delegated, and runs what it allows (review F01)', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: { autoStart: false },
      extensions: [claudeCodeHooks()],
      // Local models only; this project also runs one.
      extraConfig: [
        'routing:',
        '  must_use_local: true',
        '  models:',
        '    - { id: local-coder, provider: local, vendors: [generic], local: true, capabilities: { code_editing: 0.6 } }',
        '',
      ].join('\n'),
    });
    const pid = td.project.project_id;
    const blocked = () =>
      td.daemon.state.store
        .readSince(pid, 0, { types: ['routing.blocked'] })
        .map((e) => e.payload as { task_id: string });
    const asked = (taskId: string) =>
      td.daemon.state.q.escalations(pid, 'pending').filter((e) => e.task_id === taskId && e.kind === 'routing_blocked');

    // 1. A host that applies models but offers only a remote one: a human's assignment is refused.
    const remote = await FakeHarness.connect(td, {
      agentKey: 'remote',
      capabilities: { task_start: true, model_control: 'set', models: ['claude-opus-5-5'] },
    });
    const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Refactor the price formatter',
      kind: 'implementation',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await expect(
      td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'remote' }),
    ).rejects.toMatchObject({ code: 'COS-7003' });
    await new Promise((r) => setTimeout(r, 300));
    expect(remote.received.filter((m) => m.method === 'task.start')).toEqual([]);
    expect((await inspect(td, t.task_id)).task.status).toBe('READY');
    expect((await inspect(td, t.task_id)).runs).toEqual([]);
    expect(blocked().map((b) => b.task_id)).toEqual([t.task_id]);
    expect(asked(t.task_id)).toHaveLength(1);

    // 2. An attached Claude Code session (its hooks reached Friday) chooses its own model, and no
    // model it can run is local: its claim is refused too.
    const cc = new GenericHarnessClient(td.bootstrap, {
      harness_key: `claude-code:${pid}:pid:8701`,
      vendor: 'claude-code',
      name: 'Claude Code',
      version: '2.1.296',
      adapter_version: '0.1.0',
      attach_mode: 'attach',
      project_id: pid,
      capabilities: { hooks: true },
      agent_key: 'cc-1',
      role: 'developer',
      host: { pid: 8701, session_id: 'sess-f01', cwd: ws().projectDir },
    });
    await cc.register();
    await postHook(
      { url: td.url, projectId: pid, token: td.daemon.tokens.bootstrap },
      'SessionStart',
      { session_id: 'sess-f01', cwd: ws().projectDir, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: 8701 },
    );
    const t2 = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Tidy the docs',
      kind: 'docs',
      scope: { write: ['docs/**'], read: [] },
      ready: true,
    });
    await expect(cc.claim({ task_id: t2.task_id })).rejects.toMatchObject({ code: 'COS-7003' });
    expect((await inspect(td, t2.task_id)).task.status).toBe('READY');

    // 3. Automatic delegation does not hand the task to the remote host either.
    const goal = await td.operator.post<{ goal_id: string }>(td.operator.projectPath('/goals'), {
      request: 'Speed up checkout',
      plan: false,
    });
    const v1 = await td.operator.post<{ plan_id: string; version: number }>(
      td.operator.projectPath(`/goals/${goal.goal_id}/plans`),
      {
        draft: {
          objective: 'Speed up checkout',
          summary: 'one task',
          tasks: [
            {
              key: 'cache',
              summary: 'Cache prices',
              acceptance_criteria: ['tests pass'],
              scope: { write: ['src/**'], read: ['**'] },
              depends_on: [],
            },
          ],
        },
      },
    );
    await td.operator.post(td.operator.projectPath(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
    await td.operator.post(td.operator.projectPath('/brain/run-once'), {});
    const planned = td.daemon.state.q.tasks(pid, {}).find((x) => x.goal_id === goal.goal_id) as TaskView;
    expect(planned.status).toBe('READY');
    expect(remote.received.filter((m) => m.method === 'task.start')).toEqual([]);
    expect(asked(planned.task_id)).toHaveLength(1);

    // 4. What the route allows still runs: a host that applies the local model.
    const local = await FakeHarness.connect(td, {
      agentKey: 'local',
      capabilities: { task_start: true, model_control: 'set', models: ['local-coder'] },
    });
    await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'local' });
    const start = (await local.waitFor('task.start', 30_000)).params as TaskStartParams;
    expect(start).toMatchObject({ task_id: t.task_id, model: 'local-coder', model_binding: true });
    // The block's question is answered by the route that allowed the work.
    expect(asked(t.task_id)).toEqual([]);

    // 5. A host that applies models but reports running another one: its attempt ends at once,
    // and a human decides before the task runs again.
    await local.client.emitEvent({
      task_id: t.task_id,
      run_id: start.run_id,
      event_type: 'model.observed',
      data: { model: 'claude-opus-5-5', basis: 'reported' },
    });
    const after = await inspect(td, t.task_id);
    expect(after.task.status).toBe('READY');
    expect(after.runs.at(-1)).toMatchObject({ status: 'ENDED', model_observed: 'claude-opus-5-5' });
    expect(
      td.daemon.state.q
        .escalations(pid, 'pending')
        .filter((e) => e.task_id === t.task_id && e.kind === 'routing_violated'),
    ).toHaveLength(1);
  }, 120_000);
});
