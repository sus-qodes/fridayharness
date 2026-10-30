/**
 * M1b scenario: the real `friday` CLI against a real daemon process, with a generic harness
 * standing in for the agent. Exercises init → run → task create → claim → completion claim →
 * verify → COMPLETED, plus status, inspect, events, doctor, exit codes and daemon stop.
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { TaskView } from '@friday/protocol';
import { DaemonClient, loadProject } from '@friday/sdk';
import { deterministicGit, useTestWorkspace, waitForExit } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, spawnFridayRun } from '../helpers/cli.js';
import { TEST_HOST_MODELS } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

describe('friday CLI end to end', () => {
  it('runs a task from creation to a verified completion', async () => {
    const dir = ws().projectDir;
    writeFileSync(path.join(dir, 'README.md'), '# shop\n');
    const git = deterministicGit(dir);
    await git.init();

    const init = await cli(['--project', dir, 'init', '--name', 'shop']);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain('Initialized Friday project "shop"');
    expect(existsSync(path.join(dir, '.friday', 'config.yaml'))).toBe(true);
    expect((await cli(['--project', dir, 'init'])).code).toBe(2);
    await git.commitAll('init friday');

    const daemon = await spawnFridayRun(ws());
    expect(daemon.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const created = await cli([
      '--project',
      dir,
      '--json',
      'task',
      'create',
      'Add discount codes',
      '--criteria',
      'tests pass',
      '--scope-write',
      'src/pricing/**',
      '--assign',
      'dev-1',
    ]);
    expect(created.code, created.stderr).toBe(0);
    const task = JSON.parse(created.stdout) as TaskView;
    expect(task).toMatchObject({
      status: 'READY',
      reserved_for_agent_key: 'dev-1',
      scope: { write: ['src/pricing/**'] },
    });

    const list = await cli(['--project', dir, 'tasks']);
    expect(list.stdout).toContain(task.task_id);

    // A loose task without a reservation is nobody's to start: the command says so.
    const loose = await cli(['--project', dir, 'task', 'create', 'Tidy the README', '--ready']);
    expect(loose.code, loose.stderr).toBe(0);
    expect(loose.stdout).toContain('not delegated: Friday hands out the tasks of a goal');
    expect(loose.stdout).toContain('friday task assign');
    const reserved = await cli(['--project', dir, 'task', 'create', 'Tidy the docs', '--assign', 'dev-1']);
    expect(reserved.stdout).not.toContain('not delegated');

    // An attach-mode harness claims the reserved task and submits a completion claim.
    const ref = loadProject(dir);
    const h = new GenericHarnessClient(DaemonClient.forProject(ref, 'bootstrap'), {
      harness_key: 'cli-e2e:1',
      vendor: 'generic',
      name: 'e2e',
      attach_mode: 'attach',
      project_id: ref.project_id,
      agent_key: 'dev-1',
      capabilities: { models: TEST_HOST_MODELS },
      // Stands in for an adapter with policy hooks; the project requires L1 (review F09).
      enforcement_level: 'L1',
    });
    await h.register();
    const claim = await h.claim({ next: true });
    expect(claim.task.task_id).toBe(task.task_id);
    expect(claim.context?.sections.map((s) => s.kind)).toContain('task.scope');
    const result = await h.reportResult({
      task_id: task.task_id,
      run_id: claim.run_id,
      status: 'completed_claim',
      summary: 'added codes',
      changed_paths: ['src/pricing/discount.ts'],
    });
    expect(result.task_status).toBe('READY_FOR_VERIFICATION');

    const verified = await cli([
      '--project',
      dir,
      'verify',
      task.task_id,
      '--result',
      'passed',
      '--note',
      'checked by hand',
    ]);
    expect(verified.code, verified.stderr).toBe(0);
    expect(verified.stdout).toContain('COMPLETED');

    const inspect = await cli(['--project', dir, 'task', 'inspect', task.task_id]);
    expect(inspect.code).toBe(0);
    for (const s of [
      'COMPLETED',
      'task.completion_claimed',
      'task.completed',
      'discrepancy: src/pricing/discount.ts',
    ]) {
      expect(inspect.stdout).toContain(s);
    }

    const events = await cli(['--project', dir, 'events', 'tail', '--limit', '200']);
    expect(events.stdout).toContain('READY_FOR_VERIFICATION -> VERIFYING');

    const status = await cli(['--project', dir, '--json', 'status']);
    expect(JSON.parse(status.stdout).counts).toMatchObject({ COMPLETED: 1 });

    const doc = await cli(['--project', dir, 'doctor']);
    expect(doc.stdout).not.toContain('[FAIL]');
    expect(doc.stdout).toContain('runtime files ignored, config.yaml trackable');

    const missing = await cli(['--project', dir, 'task', 'inspect', 'task_00000000000000000000000000']);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('COS-2001');

    // A one-time sign-in link (plan M9 §5.12): printed, never opened, under tests.
    const ui = await cli(['--project', dir, 'ui', '--print-link']);
    const link = ui.stdout.trim();
    expect(link.startsWith(`${daemon.url}/ui/`)).toBe(true);
    const code = /#code=([A-Za-z0-9_-]{43})$/.exec(link)?.[1];
    expect(code).toBeTruthy();
    const exchange = () =>
      fetch(`${daemon.url}/ui/session`, {
        method: 'POST',
        headers: { origin: daemon.url, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      }).then((r) => r.status);
    expect(await exchange()).toBe(200);
    expect(await exchange()).toBe(401);
    const legacy = await cli(['--project', dir, 'ui', '--token']);
    expect(legacy.stdout).toContain(`${daemon.url}/ui`);

    const stop = await cli(['--project', dir, 'daemon', 'stop']);
    expect(stop.code).toBe(0);
    const exit = await waitForExit(daemon.child, 15_000);
    expect(exit.code).toBe(0);
    expect(daemon.output()).toContain('Friday daemon stopped.');

    const down = await cli(['--project', dir, 'tasks']);
    expect(down.code).toBe(3);
    expect(down.stderr).toContain('not running');
  });

  it('reports a missing project with a clear message', async () => {
    const res = await cli(['--project', ws().root, 'tasks']);
    expect(res.code).toBe(4);
    expect(res.stderr).toContain('friday init');
  });
});
