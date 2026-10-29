/**
 * Project memory through the daemon and the CLI (plan M4c, ADR-0021).
 */
import type { TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';
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

describe('friday memory', () => {
  it('records, supersedes without deleting, searches, and reviews what an agent contradicted', async () => {
    const td = await startTestDaemon(ws());
    const dir = ws().projectDir;
    const run = async (args: string[]) => {
      const r = await cli(['--project', dir, ...args]);
      expect(r.code, r.stderr).toBe(0);
      return r.stdout;
    };
    const first = JSON.parse(
      await run(['--json', 'memory', 'add', '--kind', 'architecture', '--subject', 'auth', 'Auth', 'uses', 'JWT.']),
    ) as {
      memory: { memory_id: string };
    };
    const second = await run(['memory', 'add', '--kind', 'architecture', '--subject', 'Auth', 'Auth uses OAuth.']);
    expect(second).toContain(`It supersedes ${first.memory.memory_id}`);
    // The same content again, spaced differently: nothing changes. A difference in case is a
    // different fact (review F14).
    expect(
      await run(['memory', 'add', '--kind', 'architecture', '--subject', 'auth', ' Auth  uses OAuth. ']),
    ).toContain('nothing changed');
    const found = await run(['memory', 'search', 'auth']);
    expect(found).toContain('Auth uses OAuth.');
    expect(found).not.toContain('JWT');
    expect(await run(['memory', 'search', 'auth', '--all'])).toContain('superseded');
    expect(await run(['memory', 'show', first.memory.memory_id])).toMatch(/Superseded by: mem_/);

    // An agent records a contradicting task memory: it never replaces the human's, and waits for review.
    const fe = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Login page',
      assign_agent_key: 'fe-1',
    });
    const agentMemory = td.daemon.state.memory.record(
      td.project.project_id,
      { kind: 'agent', caller: { harness_id: fe.harnessId, agent_id: fe.agentId } },
      {
        scope_type: 'task',
        scope_id: task.task_id,
        kind: 'architecture',
        subject: 'auth',
        content: 'Auth uses API keys.',
      },
    );
    expect(agentMemory.memory.needs_review).toBe(true);
    const review = await run(['memory', 'review']);
    expect(review).toContain(agentMemory.memory.memory_id);
    await run(['memory', 'approve', agentMemory.memory.memory_id]);
    expect(await run(['memory', 'review'])).toContain('Nothing waits for review.');
    await run(['memory', 'retract', agentMemory.memory.memory_id, '--reason', 'superseded by the login redesign']);
    expect(await run(['memory', 'search', 'api keys'])).toContain('No memories.');

    const bad = await cli(['--project', dir, 'memory', 'add', '--kind', 'gossip', '--subject', 'x', 'y']);
    expect(bad.code).toBe(4);
    expect(bad.stderr).toContain('unknown memory kind gossip');
  });
});
