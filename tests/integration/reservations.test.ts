/**
 * File reservations through hooks and verification (plan M5c, ADR-0025; spec Part 12 §6).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { FileReservationView, TaskStartParams, TaskView, VerificationView, WorktreeView } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
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

const RESERVATIONS = 'reservations:\n  mode: hybrid\n  required: ["pnpm-lock.yaml", "migrations/**"]\n';
const ONE_CHECK = '  checks:\n    - name: ok\n      command: node\n      args: ["-e", "process.exit(0)"]\n';

async function project(withCheck = false): Promise<TestDaemon> {
  const td = await startTestDaemon(ws(), {
    git: true,
    extensions: [claudeCodeHooks()],
    extraConfig: RESERVATIONS,
    ...(withCheck ? { editConfig: (y: string) => y.replace('  checks: []\n', ONE_CHECK) } : {}),
  });
  const dir = ws().projectDir;
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  await deterministicGit(dir, { startEpoch: 1_767_225_700 }).commitAll('lockfile and source');
  return td;
}

const active = (td: TestDaemon) =>
  td.operator
    .get<{ reservations: FileReservationView[] }>(td.operator.projectPath('/file-reservations'))
    .then((r) => r.reservations.map((x) => [x.task_id, x.pattern, x.via]));

const newTask = (td: TestDaemon, agent: string) =>
  td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: `work of ${agent}`,
    scope: { write: ['**'], read: [] },
    assign_agent_key: agent,
  });

/** A Claude Code session started in `cwd`, registered and hooked as friday-mcp and the launcher do. */
async function session(td: TestDaemon, agent: string, pid: number, cwd: string) {
  const sessionId = `sess-${agent}`;
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `claude-code:${td.project.project_id}:pid:${pid}`,
    vendor: 'claude-code',
    name: 'Claude Code',
    version: '2.1.296',
    adapter_version: '0.1.0',
    attach_mode: 'attach',
    project_id: td.project.project_id,
    capabilities: { hooks: true },
    agent_key: agent,
    host: { pid, session_id: sessionId, cwd },
  });
  await client.register();
  const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
  const start = await postHook(
    daemon,
    'SessionStart',
    { session_id: sessionId, cwd, hook_event_name: 'SessionStart', source: 'startup' },
    { claudePid: pid },
  );
  expect(start.status).toBe(200);
  const edit = async (file: string) => {
    const res = await postHook(
      daemon,
      'PreToolUse',
      toolHook(
        'PreToolUse',
        'Edit',
        { file_path: file, old_string: 'a', new_string: 'b' },
        { projectDir: cwd, sessionId },
      ),
      { claudePid: pid },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return decisionOf(res.body.hook_output);
  };
  return { client, edit };
}

describe('conflict-prone files', () => {
  it('lets one task at a time change them across worktrees, and frees them when it ends', async () => {
    const td = await project();
    const a = await newTask(td, 'dev-a');
    const b = await newTask(td, 'dev-b');
    const tree = async (t: TaskView) =>
      (await td.operator.post<{ worktree: WorktreeView }>(td.operator.projectPath(`/tasks/${t.task_id}/worktree`), {}))
        .worktree.path;
    const [wa, wb] = [await tree(a), await tree(b)];
    const sa = await session(td, 'dev-a', 5101, wa);
    const sb = await session(td, 'dev-b', 5102, wb);
    await sa.client.claim({ task_id: a.task_id });
    await sb.client.claim({ task_id: b.task_id });

    // The first write takes the lockfile for its task.
    expect(await sa.edit(path.join(wa, 'pnpm-lock.yaml'))).toBeNull();
    expect(await active(td)).toEqual([[a.task_id, 'pnpm-lock.yaml', 'write']]);
    // In the other worktree it is refused, naming the holder; other files stay free.
    const refused = await sb.edit(path.join(wb, 'pnpm-lock.yaml'));
    expect(refused?.decision).toBe('deny');
    expect(refused?.reason).toContain(a.task_id);
    expect(await sb.edit(path.join(wb, 'src', 'a.ts'))).toBeNull();
    const conflicts = td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['ownership.conflict'] });
    expect(conflicts.map((e) => e.payload)).toEqual([
      expect.objectContaining({ task_id: b.task_id, holder_task_id: a.task_id, pattern: 'pnpm-lock.yaml' }),
    ]);
    const listed = await cli(['--project', ws().projectDir, 'reservations']);
    expect(listed.stdout).toContain('pnpm-lock.yaml');
    expect(listed.stdout).toContain(a.task_id);

    // When the holder ends, the next task may take it.
    await td.operator.post(td.operator.projectPath(`/tasks/${a.task_id}/cancel`), { reason: 'not needed' });
    expect(await active(td)).toEqual([]);
    expect(await sb.edit(path.join(wb, 'pnpm-lock.yaml'))).toBeNull();
    expect(await active(td)).toEqual([[b.task_id, 'pnpm-lock.yaml', 'write']]);
  });

  it('checks them at verification for runs without hooks, and takes free ones there', async () => {
    const td = await project(true);
    const holder = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), { summary: 'migration owner' });
    const reserved = await cli([
      '--project',
      ws().projectDir,
      '--json',
      'reserve',
      'migrations/**',
      '--task',
      holder.task_id,
    ]);
    expect(reserved.code, reserved.stderr).toBe(0);

    const spawnWork = async (agent: string, files: Record<string, string>) => {
      const fake = await FakeHarness.connect(td, { agentKey: agent });
      const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
        summary: `work of ${agent}`,
        scope: { write: ['**'], read: [] },
        ready: true,
      });
      await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: agent });
      const start = (await fake.waitFor('task.start', 20_000)).params as TaskStartParams;
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(path.dirname(path.join(start.working_directory, rel)), { recursive: true });
        writeFileSync(path.join(start.working_directory, rel), text);
      }
      for (let i = 0; i < 200; i++) {
        const t = await td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${task.task_id}`));
        if (t.task.status === 'RUNNING') break;
        await new Promise((r) => setTimeout(r, 50));
      }
      await fake.client.reportResult({
        task_id: task.task_id,
        run_id: start.run_id,
        status: 'completed_claim',
        summary: 'done',
        changed_paths: Object.keys(files),
        checks: [],
      });
      return td.operator.post<{ task: TaskView; verification: VerificationView }>(
        td.operator.projectPath(`/tasks/${task.task_id}/verify`),
        {},
        { timeoutMs: 120_000 },
      );
    };

    const blocked = await spawnWork('be-1', { 'migrations/0002_add.sql': 'select 1;\n' });
    expect(blocked.task.status).toBe('FAILED');
    const diff = blocked.verification.checks.find((c) => c.name === 'friday.diff');
    expect(diff?.details?.findings?.find((f) => f.rule === 'diff.reserved')).toMatchObject({
      severity: 'fail',
      paths: ['migrations/0002_add.sql'],
    });

    const passed = await spawnWork('be-2', { 'pnpm-lock.yaml': 'lockfileVersion: 9\n# changed\n' });
    expect(passed.task.status).toBe('COMPLETED');
    const all = await td.operator.get<{ reservations: FileReservationView[] }>(
      `${td.operator.projectPath('/file-reservations')}?all=true`,
    );
    expect(all.reservations.find((r) => r.task_id === passed.task.task_id)).toMatchObject({
      pattern: 'pnpm-lock.yaml',
      via: 'verification',
      status: 'released',
      note: 'the task was completed',
    });
  });
});
