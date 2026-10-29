/**
 * Recovering lost and failed attempts (plan M5d, ADR-0026; spec Part 12 §8).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { RecoveryAssessment, TaskStartParams, TaskView } from '@friday/protocol';
import { deterministicGit, FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { decisionOf, postHook, toolHook } from '../helpers/hooks.js';

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

async function project(extraConfig?: string) {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), {
    git: true,
    clock,
    extensions: [claudeCodeHooks()],
    ...(extraConfig ? { extraConfig } : {}),
  });
  const dir = ws().projectDir;
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('source');
  return { td, clock, dir };
}

async function eventually<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);
const assessment = (td: TestDaemon, id: string) =>
  td.operator
    .get<{ assessment: RecoveryAssessment }>(td.operator.projectPath(`/tasks/${id}/recovery`))
    .then((r) => r.assessment);
const recommended = (a: RecoveryAssessment) => a.options.filter((o) => o.recommended).map((o) => o.action);
const escalationsOf = (td: TestDaemon, taskId: string) =>
  td.daemon.state.q.escalations(td.project.project_id).filter((e) => e.task_id === taskId);

/** An agent takes a new task and starts it in its worktree. */
async function take(td: TestDaemon, agent: string, opts: { sessionId?: string; taskId?: string } = {}) {
  const fake = await FakeHarness.connect(td, {
    agentKey: agent,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  const taskId =
    opts.taskId ??
    (
      await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
        summary: `work of ${agent}`,
        scope: { write: ['src/**'], read: [] },
        ready: true,
      })
    ).task_id;
  await td.operator.post(td.operator.projectPath(`/tasks/${taskId}/assign`), { agent_key: agent });
  const start = (await fake.waitFor('task.start', 20_000)).params as TaskStartParams;
  await eventually(
    () => taskOf(td, taskId),
    (t) => t.status === 'RUNNING',
    `${taskId} to run`,
  );
  return { fake, start, taskId };
}

/** The harness stops reporting; its lease expires, then its reconnect window. */
async function lose(td: TestDaemon, clock: FakeClock, fake: FakeHarness, past: 'lease' | 'window' = 'window') {
  await fake.crash();
  clock.advance(31_000);
  td.daemon.tick();
  if (past === 'window') {
    clock.advance(121_000);
    td.daemon.tick();
  }
}

describe('a harness dies after changing files (Part 12 §8)', () => {
  it('inspects the worktree, waits for a reconnect, then fences, preserves and reassigns without a second branch', async () => {
    const { td, clock, dir } = await project();
    const first = await take(td, 'be-1');
    const wt = first.start.working_directory;
    // Part of the work is committed, part is not; then the process dies.
    writeFileSync(path.join(wt, 'src', 'done.ts'), 'export const done = true;\n');
    await deterministicGit(wt, { startEpoch: 1_767_225_800 }).commitAll('first half');
    writeFileSync(path.join(wt, 'src', 'half.ts'), 'export const half = true;\n');
    await lose(td, clock, first.fake, 'lease');

    const waiting = await assessment(td, first.taskId);
    expect(waiting).toMatchObject({
      task_status: 'HARNESS_LOST',
      attempts: 1,
      harness: { status: 'DISCONNECTED', agent_key: 'be-1' },
      worktree: { exists: true, commits_since_base: 1, uncommitted: ['src/half.ts'] },
    });
    expect(recommended(waiting)).toEqual(['reconnect']);
    expect(await td.daemon.recovery.sweep()).toEqual([]);

    // The window passes: automatic recovery fences the attempt, keeps its work and reassigns.
    clock.advance(121_000);
    td.daemon.tick();
    expect(await td.daemon.recovery.sweep()).toEqual([`${first.taskId}: reassign`]);
    const released = await taskOf(td, first.taskId);
    expect(released).toMatchObject({ status: 'READY', current_run_id: null });
    expect(td.daemon.state.q.run(first.start.run_id)).toMatchObject({ status: 'ENDED', outcome: 'released' });
    const git = deterministicGit(dir);
    const preserved = `refs/friday/preserved/${first.taskId}/attempt-1`;
    expect((await git.run(['show', `${preserved}:src/half.ts`])).trim()).toBe('export const half = true;');
    const shown = await cli(['--project', dir, 'recover', first.taskId]);
    expect(shown.stdout).toContain(preserved);

    // The old attempt can no longer report.
    const late = await first.fake.rawRpc('agent.result', {
      protocol_version: '1.0',
      idempotency_key: 'late-1',
      task_id: first.taskId,
      run_id: first.start.run_id,
      status: 'completed_claim',
      summary: 'late',
      changed_paths: [],
      checks: [],
      notes: [],
    });
    expect(late.status).toBe(401);

    // Attempt 2 continues in the same worktree, on the same branch, with the work left there.
    const second = await take(td, 'be-2', { taskId: first.taskId });
    expect(second.start).toMatchObject({ working_directory: wt, git_ref: first.start.git_ref, attempt: 2 });
    expect(existsSync(path.join(wt, 'src', 'half.ts'))).toBe(true);
    expect((await git.run(['branch', '--list', 'friday/*'])).trim().split('\n')).toHaveLength(1);

    // A Claude Code session started in that worktree, holding nothing, may not write there.
    const pid = 6101;
    const stale = new GenericHarnessClient(td.bootstrap, {
      harness_key: `claude-code:${td.project.project_id}:pid:${pid}`,
      vendor: 'claude-code',
      name: 'Claude Code',
      version: '2.1.296',
      adapter_version: '0.1.0',
      attach_mode: 'attach',
      project_id: td.project.project_id,
      capabilities: { hooks: true },
      agent_key: 'dev-old',
      host: { pid, session_id: 'sess-old', cwd: wt },
    });
    await stale.register();
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    await postHook(
      daemon,
      'SessionStart',
      { session_id: 'sess-old', cwd: wt, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: pid },
    );
    const write = await postHook(
      daemon,
      'PreToolUse',
      toolHook(
        'PreToolUse',
        'Edit',
        { file_path: path.join(wt, 'src', 'a.ts'), old_string: 'a', new_string: 'b' },
        { projectDir: wt, sessionId: 'sess-old' },
      ),
      { claudePid: pid },
    );
    expect(decisionOf(write.body.hook_output)).toMatchObject({ decision: 'deny' });
    expect(decisionOf(write.body.hook_output)?.reason).toContain(`worktree of ${first.taskId}`);
  });
});

describe('recovery limits', () => {
  it('asks a human once the retries are used up, once, and a human can still reassign', async () => {
    const { td, clock, dir } = await project('recovery:\n  max_retries: 0\n');
    const t = await take(td, 'be-1');
    writeFileSync(path.join(t.start.working_directory, 'src', 'wip.ts'), 'export {};\n');
    await lose(td, clock, t.fake);
    expect(await td.daemon.recovery.sweep()).toEqual([`${t.taskId}: needs_human`]);
    expect(await td.daemon.recovery.sweep()).toEqual([]);
    expect((await taskOf(td, t.taskId)).status).toBe('HARNESS_LOST');
    expect(escalationsOf(td, t.taskId).map((e) => e.kind)).toEqual(['recovery_needed']);

    const done = await cli([
      '--project',
      dir,
      'recover',
      t.taskId,
      '--action',
      'reassign',
      '--reason',
      'try once more',
    ]);
    expect(done.code, done.stderr).toBe(0);
    expect(done.stdout).toContain(`refs/friday/preserved/${t.taskId}/attempt-1`);
    expect((await taskOf(td, t.taskId)).status).toBe('READY');
  });

  it('retries a failed attempt, but not the same error again and again', async () => {
    const { td } = await project();
    const t = await take(td, 'be-1');
    const fail = async (runId: string) => {
      await t.fake.client.reportError({ task_id: t.taskId, run_id: runId, message: 'disk full', fatal: true });
      await eventually(
        () => taskOf(td, t.taskId),
        (x) => x.waiting_reason === 'agent_error',
        'the agent error',
      );
    };
    await fail(t.start.run_id);
    expect(await td.daemon.recovery.sweep()).toEqual([`${t.taskId}: reassign`]);
    expect((await taskOf(td, t.taskId)).status).toBe('READY');

    await td.operator.post(td.operator.projectPath(`/tasks/${t.taskId}/assign`), { agent_key: 'be-1' });
    // The second start, not the first still in `received`: attempt 2's error must name attempt 2's
    // run, since an error for an ended run is recorded and changes nothing (plan M11.5).
    const again = (
      await t.fake.waitFor('task.start', 20_000, (m) => (m.params as TaskStartParams).run_id !== t.start.run_id)
    ).params as TaskStartParams;
    await eventually(
      () => taskOf(td, t.taskId),
      (x) => x.status === 'RUNNING',
      'attempt 2 to run',
    );
    await fail(again.run_id);
    const a = await assessment(td, t.taskId);
    expect(a.errors).toEqual({ total: 2, same_as_last: 2, last: 'disk full' });
    expect(await td.daemon.recovery.sweep()).toEqual([`${t.taskId}: needs_human`]);
    expect((await taskOf(td, t.taskId)).status).toBe('WAITING');
  });

  it('never hands work to someone else while the old process still runs on this machine', async () => {
    const { td, clock } = await project();
    // This harness reports the test process as its host, which is alive.
    const t = await take(td, 'be-1', { sessionId: 'sess-alive' });
    await lose(td, clock, t.fake);
    const a = await assessment(td, t.taskId);
    expect(a.harness).toMatchObject({ status: 'TERMINATED', process_alive: true });
    expect(recommended(a)).toEqual(['needs_human']);
    expect(await td.daemon.recovery.sweep()).toEqual([`${t.taskId}: needs_human`]);
    expect((await taskOf(td, t.taskId)).status).toBe('HARNESS_LOST');
  });
});
