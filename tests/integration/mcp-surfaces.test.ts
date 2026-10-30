/**
 * The handoff's MCP surfaces behind the tools (ADR-0038; plan Phase 6): the code graph answers a
 * registered agent for its own checkout, an agent reads the raw output of its own work and nobody
 * else's, and a lesson learned from a failure carries the failure Friday recorded.
 */
import { cpSync } from 'node:fs';
import path from 'node:path';
import type { GenericHarnessClient } from '@friday/adapter-generic';
import type { LearningProposalView, OperationResult, TaskStartParams, TaskView } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
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

const SCRIPT = "for (let i = 1; i <= 50; i++) console.log('line ' + i + (i % 10 === 0 ? ' error here' : ''))";
const OPERATIONS = [
  'operations:',
  '  lines:',
  '    description: prints fifty lines',
  '    command: node',
  `    args: ["-e", ${JSON.stringify(SCRIPT)}]`,
  '    risk: low',
  '',
].join('\n');

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`));

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A spawned backend agent running a task in its own worktree. */
async function agentOnTask(td: TestDaemon, summary: string, n: number) {
  const fake = await FakeHarness.connect(td, { agentKey: `backend-${n}`, role: 'backend' });
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary,
    kind: 'chore',
    scope: { write: ['notes/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: `backend-${n}` });
  const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
  await eventually(
    () => taskOf(td, task.task_id),
    (t) => t.task.status === 'RUNNING',
    'the task to run',
  );
  return { client: fake.client, task, run_id: start.run_id };
}

async function settle(client: GenericHarnessClient, r: OperationResult): Promise<OperationResult> {
  let res = r;
  for (let i = 0; res.status === 'running' && i < 10; i++) {
    res = await client.call('operation.status', { operation_run_id: res.operation_run_id as string, wait_ms: 20_000 });
  }
  return res;
}

describe('the code graph for an agent (ADR-0038 §2)', () => {
  it('answers a symbol, a file, words, a blast radius and skeletons for the agent’s checkout, bounded', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    for (const part of ['backend', 'frontend', 'shared', 'infra', 'tsconfig.json']) {
      cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop', part), path.join(dir, part), {
        recursive: true,
      });
    }
    await deterministicGit(dir).commitAll('fixture-shop');
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend', mode: 'attach' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes to checkout',
      scope: { write: ['backend/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    await be.client.call('task.claim', { task_id: task.task_id });

    // A symbol: where it is, who calls it; the answer names the graph it describes.
    const symbol = await be.client.call('graph.query', { name: 'totalOf' });
    expect(symbol.asked).toBe('symbol');
    expect(symbol.version).toMatch(/\S/);
    const match = symbol.symbol?.matches[0];
    expect(match?.symbol).toMatchObject({ path: 'backend/src/checkout.service.ts', name: 'totalOf', exported: true });
    expect(match?.callers.some((e) => e.from.symbol === 'checkout' && e.certainty === 'exact')).toBe(true);
    // A file: what it imports and who imports it.
    const file = await be.client.call('graph.query', { path: 'backend/src/checkout.service.ts', depth: 2 });
    expect(file.asked).toBe('file');
    expect(file.file?.node.path).toBe('backend/src/checkout.service.ts');
    expect(file.file?.dependencies.length).toBeGreaterThan(0);
    expect(file.file?.neighbourhood.length).toBeGreaterThan(0);
    // Words: symbols and files by their names.
    const words = await be.client.call('graph.query', { words: 'checkout', limit: 5 });
    expect(words.asked).toBe('search');
    expect(words.hits?.length).toBeGreaterThan(0);
    expect(words.hits?.length).toBeLessThanOrEqual(5);
    // One question at a time.
    await expect(be.client.call('graph.query', { name: 'totalOf', words: 'checkout' })).rejects.toThrow(
      /invalid params/,
    );
    await expect(be.client.call('graph.query', {})).rejects.toThrow(/invalid params/);

    // A blast radius from a symbol: what calls it, with confidence.
    const blast = await be.client.call('graph.blast_radius', {
      symbols: ['backend/src/checkout.service.ts#totalOf'],
      depth: 2,
    });
    expect(blast.seeds[0]).toMatchObject({ path: 'backend/src/checkout.service.ts', symbols: ['totalOf'] });
    expect(
      blast.affected.some(
        (a) => a.path === 'backend/src/checkout.service.ts' && a.symbol === 'checkout' && a.confidence === 'high',
      ),
    ).toBe(true);
    expect(blast.name_matches_included).toBe(false);
    await expect(be.client.call('graph.blast_radius', { depth: 1 })).rejects.toThrow(/invalid params/);

    // Skeletons: at most five files, each with its bodies folded; what the graph lacks is named.
    const sk = await be.client.call('graph.skeleton', {
      paths: ['backend/src/checkout.service.ts', 'README.md'],
      level: 1,
    });
    expect(sk.files).toHaveLength(1);
    expect(sk.files[0]?.path).toBe('backend/src/checkout.service.ts');
    expect(sk.files[0]?.text).toContain('totalOf');
    expect(sk.files[0]?.folded).toBeGreaterThan(0);
    expect(sk.missing).toEqual([{ path: 'README.md', reason: expect.stringContaining('not in the code graph') }]);
    await expect(be.client.call('graph.skeleton', { paths: ['a', 'b', 'c', 'd', 'e', 'f'] })).rejects.toThrow(
      /invalid params/,
    );
  }, 120_000);
});

describe('raw output and a lesson from a failure (ADR-0038 §3, §5)', () => {
  it('lets an agent read its own operation’s output in bounded slices, and nobody else', async () => {
    const td = await startTestDaemon(ws(), { git: true, extraConfig: OPERATIONS });
    const dir = ws().projectDir;
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    const { client, task, run_id } = await agentOnTask(td, 'print the lines', 1);
    const done = await settle(
      client,
      await client.call('operation.run', { operation: 'lines', reason: 'see them', run_id }),
    );
    expect(done.status).toBe('passed');
    const ref = done.artifact_ref as string;
    expect(ref).toMatch(/^artifact:/);

    // The whole record: the two header lines the gateway wrote and the fifty lines.
    const head = await client.call('artifact.read', { artifact_ref: ref, limit: 5 });
    expect(head).toMatchObject({
      artifact_ref: ref,
      kind: 'operation',
      from: 1,
      to: 5,
      truncated: true,
      matched: null,
    });
    expect(head.of).toMatchObject({ kind: 'operation', task_id: task.task_id });
    expect(head.lines_total).toBe(52);
    expect(head.text.split('\n')).toHaveLength(5);
    expect(head.text).toContain('(operation lines in ');
    // A slice from an offset reaches the end.
    const tail = await client.call('artifact.read', { artifact_ref: ref, offset: head.lines_total - 1, limit: 10 });
    expect(tail).toMatchObject({ from: head.lines_total - 1, to: head.lines_total, truncated: false });
    expect(tail.text).toContain('line 50');
    // Only the lines that match, numbered (the header line quotes the script, so it matches too).
    const found = await client.call('artifact.read', { artifact_ref: ref, find: 'ERROR HERE' });
    expect(found.matched).toBe(6);
    expect(found.truncated).toBe(false);
    expect(found.text.split('\n')).toHaveLength(6);
    expect(found.text).toMatch(/^1: \$ /);
    expect(found.text).toMatch(/\n\d+: line 10 error here\n/);
    const cut = await client.call('artifact.read', { artifact_ref: ref, find: 'line', limit: 3 });
    expect(cut.matched).toBe(52);
    expect(cut.truncated).toBe(true);
    expect(cut.text.split('\n')).toHaveLength(3);

    // Another agent, another task: not its output. Nothing references an unknown id either.
    const other = await FakeHarness.connect(td, { agentKey: 'backend-2', role: 'backend', mode: 'attach' });
    await expect(other.client.call('artifact.read', { artifact_ref: ref })).rejects.toThrow(/not yours/);
    await expect(client.call('artifact.read', { artifact_ref: 'artifact:nothing' })).rejects.toThrow(
      /not an output you may read/,
    );
    await expect(client.call('artifact.read', { artifact_ref: 'snapshot:x' })).rejects.toThrow(/invalid params/);

    // A passed operation is no failure to learn from.
    await expect(
      client.call('learning.propose', {
        kind: 'learned-risk',
        subject: 'Lines',
        content: 'Something.',
        task_id: task.task_id,
        from_failure: { kind: 'operation', id: done.operation_run_id as string },
      }),
    ).rejects.toThrow(/is passed, not failed/);
  }, 120_000);

  it('records a lesson from a failed verification with the failure Friday saw, promoted only by authority', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend', mode: 'attach' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Fix migrations',
      role: 'backend',
      scope: { write: ['db/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    const claim = await be.client.claim({ task_id: task.task_id });

    // No failure yet: nothing to learn from.
    await expect(
      be.client.call('learning.propose', {
        kind: 'learned-risk',
        subject: 'Migrations',
        content: 'Back up first.',
        from_failure: { kind: 'verification' },
      }),
    ).rejects.toThrow(/not a verification of/);

    await be.client.reportResult({
      task_id: task.task_id,
      run_id: claim.run_id,
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
    });
    const failed = await cli([
      '--project',
      dir,
      'verify',
      task.task_id,
      '--result',
      'failed',
      '--note',
      'migration 7 dropped a column',
    ]);
    expect(failed.code, failed.stderr).toBe(0);
    const { proposal } = await be.client.call('learning.propose', {
      kind: 'learned-risk',
      subject: 'Migrations',
      content: 'Back up the dev database before running migrations.',
      paths: ['db/**'],
      task_id: task.task_id,
      from_failure: { kind: 'verification' },
    });
    expect(proposal.status).toBe('proposed');
    expect(proposal.origin).toMatchObject({ kind: 'verification', id: expect.stringMatching(/^ver_/) });
    expect(proposal.origin?.detail).toContain('migration 7 dropped a column');
    // The failure promotes nothing: it waits for a human.
    const shown = await cli(['--project', dir, 'learning', 'show', proposal.proposal_id]);
    expect(shown.stdout).toContain('waiting');
    expect(shown.stdout).toContain(`learned from verification ${proposal.origin?.id}: `);
    // A human approves it: the memory names the failure it came from.
    expect((await cli(['--project', dir, 'learning', 'approve', proposal.proposal_id])).code).toBe(0);
    const learned = await td.operator.get<LearningProposalView>(
      td.operator.projectPath(`/learnings/${proposal.proposal_id}`),
    );
    expect(learned.status).toBe('promoted');
    const memory = await td.operator.get<{ tags: string[]; authority: string }>(
      td.operator.projectPath(`/memory/${learned.memory_id}`),
    );
    expect(memory.tags).toContain(`origin:verification:${proposal.origin?.id}`);
    expect(memory.tags).toContain('db/**');
  }, 120_000);
});
