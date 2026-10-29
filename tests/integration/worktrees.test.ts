/**
 * Task worktrees through the daemon (plan M5a, ADR-0023).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import type { TaskStartParams, TaskView, WorktreeView } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { postHook } from '../helpers/hooks.js';
import { startMcp } from '../helpers/mcp-rig.js';

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

async function eventually<T>(fn: () => Promise<T> | T, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function project(): Promise<TestDaemon> {
  const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
  const dir = ws().projectDir;
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'shared.ts'), 'export const shared = 1;\n');
  await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('add shared');
  return td;
}

const createTask = (td: TestDaemon, summary: string, extra: Record<string, unknown> = {}) =>
  td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary,
    scope: { write: ['src/**'], read: [] },
    ...extra,
  });
const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);

describe('spawn runs work in their own worktrees', () => {
  it('gives each run its checkout, keeps their contents apart and the main checkout clean', async () => {
    const td = await project();
    const dir = ws().projectDir;
    const be = await FakeHarness.connect(td, { agentKey: 'be-1' });
    const fe = await FakeHarness.connect(td, { agentKey: 'fe-1' });
    const t1 = await createTask(td, 'backend change', { ready: true });
    const t2 = await createTask(td, 'frontend change', { ready: true });
    await td.operator.post(td.operator.projectPath(`/tasks/${t1.task_id}/assign`), { agent_key: 'be-1' });
    await td.operator.post(td.operator.projectPath(`/tasks/${t2.task_id}/assign`), { agent_key: 'fe-1' });
    const start1 = (await be.waitFor('task.start', 15_000)).params as TaskStartParams;
    const start2 = (await fe.waitFor('task.start', 15_000)).params as TaskStartParams;
    expect(start1.git_ref).toBe(`friday/${t1.task_id}`);
    expect(start1.working_directory).not.toBe(start2.working_directory);
    for (const s of [start1, start2]) {
      expect(path.relative(path.join(ws().root, 'friday-worktrees'), s.working_directory).startsWith('..')).toBe(false);
    }
    await eventually(
      () => taskOf(td, t1.task_id),
      (t) => t.status === 'RUNNING',
      'the backend task to run',
    );
    expect(td.daemon.state.q.run((await taskOf(td, t1.task_id)).current_run_id as string)).toMatchObject({
      execution_root: start1.working_directory,
      branch_ref: `friday/${t1.task_id}`,
      workspace: 'ready',
    });

    // The same relative file, different contents in each checkout; the main checkout untouched.
    writeFileSync(path.join(start1.working_directory, 'src', 'shared.ts'), 'export const shared = 2;\n');
    writeFileSync(path.join(start2.working_directory, 'src', 'shared.ts'), 'export const shared = 3;\n');
    expect(await deterministicGit(dir).run(['status', '--porcelain'])).toBe('');
    const listed = JSON.parse((await cli(['--project', dir, '--json', 'worktrees'])).stdout) as {
      worktrees: (WorktreeView & { uncommitted: number })[];
    };
    expect(listed.worktrees.map((w) => [w.status, w.uncommitted]).sort()).toEqual([
      ['active', 1],
      ['active', 1],
    ]);

    // Ending the tasks: uncommitted work is preserved; a clean worktree is released and can be pruned.
    writeFileSync(path.join(start2.working_directory, 'src', 'shared.ts'), 'export const shared = 1;\n');
    await td.operator.post(td.operator.projectPath(`/tasks/${t1.task_id}/cancel`), { reason: 'not needed' });
    await td.operator.post(td.operator.projectPath(`/tasks/${t2.task_id}/cancel`), { reason: 'not needed' });
    const statuses = await eventually(
      () => td.daemon.state.q.worktrees(td.project.project_id).map((w) => [w.task_id, w.status]),
      (s) => s.every(([, st]) => st !== 'active'),
      'both worktrees to be released',
    );
    expect(Object.fromEntries(statuses)).toEqual({ [t1.task_id]: 'preserved', [t2.task_id]: 'released' });
    const pruned = await cli(['--project', dir, 'worktrees', 'prune']);
    expect(pruned.stdout, pruned.stdout + pruned.stderr).toContain('Removed 1');
    expect(td.daemon.state.q.worktreeForTask(t1.task_id)?.status).toBe('preserved');
    expect(await deterministicGit(dir).run(['branch', '--list', `friday/${t2.task_id}`])).not.toBe('');
  });
});

describe('a session started in a task worktree', () => {
  it('registers that checkout, claims only its task, writes only there, and gets its context', async () => {
    const td = await project();
    const dir = ws().projectDir;
    const task = await createTask(td, 'checkout change', { ready: true });
    const other = await createTask(td, 'another change', { ready: true });
    const made = await cli(['--project', dir, 'task', 'worktree', task.task_id]);
    expect(made.code, made.stderr).toBe(0);
    const tree = td.daemon.state.q.worktreeForTask(task.task_id) as WorktreeView;
    expect(made.stdout).toContain(tree.path);

    const pid = 4343;
    const mcp = await startMcp(ws(), {
      CLAUDE_PROJECT_DIR: tree.path,
      FRIDAY_AGENT: 'dev-2',
      CLAUDE_CODE_SESSION_ID: 'sess-wt',
      FRIDAY_HOST_PID: String(pid),
    });
    await eventually(
      () => mcp.call('friday_whoami'),
      (r) => (r.structured.daemon as { reachable?: boolean } | undefined)?.reachable === true,
      'the session to register',
    );
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    const hook = (event: string, extra: Record<string, unknown>) =>
      postHook(
        daemon,
        event,
        { session_id: 'sess-wt', cwd: tree.path, hook_event_name: event, ...extra },
        { claudePid: pid },
      );
    const started = await hook('SessionStart', { source: 'startup' });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const wrong = await mcp.call('friday_task_claim', { task_id: other.task_id });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain('works in the worktree of');
    const claim = await mcp.call('friday_task_claim', { task_id: task.task_id });
    expect(claim.isError, claim.text).toBe(false);
    const run = td.daemon.state.q.run((await taskOf(td, task.task_id)).current_run_id as string);
    expect(run.execution_root?.toLowerCase()).toBe(tree.path.toLowerCase());

    const edit = (file: string) =>
      hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
    expect((await edit(path.join(tree.path, 'src', 'shared.ts'))).body.hook_output).toBeNull();
    const intoMain = (await edit(path.join(dir, 'src', 'shared.ts'))).body.hook_output as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
    };
    expect(intoMain.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(intoMain.hookSpecificOutput.permissionDecisionReason).toContain('outside the project');
    const runtime = (
      await hook('PreToolUse', {
        tool_name: 'Read',
        tool_input: { file_path: path.join(dir, '.friday', 'run', 'daemon.json') },
      })
    ).body.hook_output as { hookSpecificOutput: { permissionDecision: string } };
    expect(runtime.hookSpecificOutput.permissionDecision).toBe('deny');

    // Its context is about its own checkout.
    const packet = await td.operator.post<{ sections: { kind: string; content: string }[] }>(
      td.operator.projectPath('/context/compile'),
      { task_id: task.task_id, purpose: 'check' },
    );
    expect(packet.sections.find((s) => s.kind === 'repo.head')?.content).toContain(`friday/${task.task_id}`);

    // A session in the main checkout cannot take over the task whose work lives in the worktree.
    const mainSession = await startMcp(ws(), {
      FRIDAY_AGENT: 'dev-3',
      CLAUDE_CODE_SESSION_ID: 'sess-main',
      FRIDAY_HOST_PID: '4444',
    });
    await eventually(
      () => mainSession.call('friday_whoami'),
      (r) => (r.structured.daemon as { reachable?: boolean } | undefined)?.reachable === true,
      'the main session to register',
    );
    const mainStart = await postHook(
      daemon,
      'SessionStart',
      { session_id: 'sess-main', cwd: dir, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: 4444 },
    );
    expect(mainStart.status, JSON.stringify(mainStart.body)).toBe(200);
    const handed = await mcp.call('friday_task_release', { reason: 'handoff', note: 'over to the next session' });
    expect(handed.isError, handed.text).toBe(false);
    expect((await taskOf(td, task.task_id)).status).toBe('READY');
    const takeover = await mainSession.call('friday_task_claim', { task_id: task.task_id });
    expect(takeover.isError).toBe(true);
    expect(takeover.text).toContain('start a session there');
  });
});
