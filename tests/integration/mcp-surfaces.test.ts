/**
 * The handoff's MCP surfaces behind the tools (ADR-0038; plan Phase 6): the code graph answers a
 * registered agent for its own checkout, an agent reads the raw output of its own work and nobody
 * else's, and a lesson learned from a failure carries the failure Friday recorded.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GenericHarnessClient } from '@friday/adapter-generic';
import { createFridayTools, type FridaySession } from '@friday/mcp-server';
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
const LONG = "console.log('x'.repeat(20000)); console.log('tail')";
const OPERATIONS = [
  'operations:',
  '  lines:',
  '    description: prints fifty lines',
  '    command: node',
  `    args: ["-e", ${JSON.stringify(SCRIPT)}]`,
  '    risk: low',
  '  long:',
  '    description: prints one line longer than an answer',
  '    command: node',
  `    args: ["-e", ${JSON.stringify(LONG)}]`,
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

/** The attached-session tools over a registered client: what an MCP host's agent would call. */
function toolsOver(client: GenericHarnessClient, me: Record<string, unknown> = {}) {
  const session = { ready: async () => client, me: async () => me } as unknown as FridaySession;
  return Object.fromEntries(createFridayTools(session).map((t) => [t.name, t]));
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

    // The tools over the same answers (ADR-0038 §1): in words, bounded, the graph's version named.
    const tools = toolsOver(be.client, { agent: { agent_key: 'be-1' }, current_task: task, claimable: [] });
    const q = await tools.friday_graph_query?.handler({ name: 'totalOf' });
    expect(q?.text).toContain('backend/src/checkout.service.ts:');
    expect(q?.text).toContain('called or used by: backend/src/checkout.service.ts#checkout:');
    expect(q?.text).toMatch(/\(code graph \S+\)$/);
    const none = await tools.friday_graph_query?.handler({ name: 'noSuchThing' });
    expect(none?.text).toContain('No symbol named noSuchThing');
    await expect(tools.friday_graph_query?.handler({})).rejects.toThrow(/ask one question/);
    const hits = await tools.friday_graph_query?.handler({ words: 'checkout', kind: 'file', limit: 3 });
    expect(hits?.text).toMatch(/^- file /);
    const b = await tools.friday_blast_radius?.handler({ symbols: ['backend/src/checkout.service.ts#totalOf'] });
    expect(b?.text).toContain('Changed: backend/src/checkout.service.ts (totalOf)');
    expect(b?.text).toMatch(/- 1 high: backend\/src\/checkout\.service\.ts#checkout via reference/);
    const s = await tools.friday_skeleton_read?.handler({
      paths: ['backend/src/checkout.service.ts', 'README.md'],
      level: 2,
    });
    expect(s?.text).toContain('backend/src/checkout.service.ts (L2:');
    expect(s?.text).toContain('README.md: not in the code graph');
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
    // The tool says what it read and how to read on; the operation result names the artifact.
    expect(done.artifact_ref).toBe(ref);
    const tools = toolsOver(client);
    const read = await tools.friday_ccr_retrieve?.handler({ artifact_ref: ref, find: 'error here', limit: 2 });
    expect(read?.text).toMatch(
      /^artifact:\S+ \(operation \S+ of \S+\): lines 1-\d+ of 52; 6 matched; more: ask again with offset \d+\.\n1: /,
    );
    const ran = await tools.friday_run_operation?.handler({ operation_run_id: done.operation_run_id, wait_s: 0 });
    expect(ran?.text).toContain(`The whole output is kept as ${ref}.`);

    // Another agent, another task: not its output. Nothing references an unknown id either.
    const other = await FakeHarness.connect(td, { agentKey: 'backend-2', role: 'backend', mode: 'attach' });
    await expect(other.client.call('artifact.read', { artifact_ref: ref })).rejects.toThrow(/not yours/);
    await expect(client.call('artifact.read', { artifact_ref: 'artifact:nothing' })).rejects.toThrow(
      /not an output you may read/,
    );
    await expect(client.call('artifact.read', { artifact_ref: 'snapshot:x' })).rejects.toThrow(/invalid params/);

    // A line longer than one answer is read in slices with a character cursor (review R8).
    const long = await settle(
      client,
      await client.call('operation.run', { operation: 'long', reason: 'long', run_id }),
    );
    expect(long.status).toBe('passed');
    const longRef = long.artifact_ref as string;
    const first = await client.call('artifact.read', { artifact_ref: longRef, offset: 3 });
    expect(first).toMatchObject({ from: 3, to: 3, truncated: true, cut: { line: 3, col: 16001 } });
    expect(first.text).toBe('x'.repeat(16000));
    const second = await client.call('artifact.read', { artifact_ref: longRef, offset: 3, col: 16001 });
    expect(second).toMatchObject({ from: 3, to: 3, cut: null });
    expect(second.text).toBe('x'.repeat(4000));
    const rest = await client.call('artifact.read', { artifact_ref: longRef, offset: 4 });
    expect(rest).toMatchObject({ from: 4, to: 4, truncated: false, cut: null, text: 'tail' });
    const foundLong = await client.call('artifact.read', { artifact_ref: longRef, find: 'xxxx' });
    expect(foundLong.matched).toBe(1);
    expect(foundLong.cut).toMatchObject({ line: 3 });
    expect(foundLong.text.startsWith('3: xxxx')).toBe(true);

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
    // Through the tool: the task is the one reserved for this agent after the rework.
    const tools = toolsOver(be.client, {
      agent: { agent_key: 'be-1' },
      current_task: null,
      claimable: [{ task_id: task.task_id, reserved_for_agent_key: 'be-1' }],
    });
    const learnedFrom = await tools.friday_mem_learn_from_failure?.handler({
      subject: 'Migrations',
      content: 'Back up the dev database before running migrations.',
      paths: ['db/**'],
    });
    expect(learnedFrom?.text).toMatch(/^Proposed \S+ for the whole project, learned from verification ver_\S+ \(/);
    expect(learnedFrom?.text).toContain('the failure itself promotes nothing');
    const { proposal } = (learnedFrom?.structured ?? {}) as { proposal: LearningProposalView };
    expect(proposal.status).toBe('proposed');
    expect(proposal.kind).toBe('learned-risk');
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

describe('symbolic patching (ADR-0039)', () => {
  it('previews, writes within the task scope, records the change, and refuses what it cannot do safely', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    for (const part of ['backend', 'frontend', 'shared', 'infra', 'tsconfig.json']) {
      cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop', part), path.join(dir, part), {
        recursive: true,
      });
    }
    await deterministicGit(dir).commitAll('fixture-shop');
    // A spawn-style session that reports L1: its own writes are judged and recorded like a host's.
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend', enforcement: 'L1' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Round totals',
      scope: { write: ['backend/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    const claim = await be.client.claim({ task_id: task.task_id });
    const file = 'backend/src/checkout.service.ts';
    const original = readFileSync(path.join(dir, file), 'utf8');
    const body = [
      'export function totalOf(request: CheckoutRequest): Money {',
      "  if (request.items.length === 0) throw new CheckoutError('cart is empty');",
      "  const currency = request.items[0]?.unitPrice.currency ?? 'EUR';",
      '  const amount = request.items.reduce((sum, item) => sum + item.unitPrice.amount * item.quantity, 0);',
      '  return { amount, currency };',
      '}',
    ].join('\n');

    // A preview writes nothing.
    const preview = await be.client.call('symbol.patch', { path: file, symbol: 'totalOf', body, dry_run: true });
    expect(preview).toMatchObject({
      status: 'preview',
      found: { kind: 'function', exported: 'export', lines: { from: 6, to: 17, new_to: 11 } },
    });
    expect(preview.preview).toContain('@@ 6,17 -> 6,11 @@');
    expect(preview.preview).toContain('- function totalOf(request: CheckoutRequest): Money {');
    expect(preview.preview).toContain('+   const amount = request.items.reduce(');
    expect(readFileSync(path.join(dir, file), 'utf8')).toBe(original);
    expect(preview.sha256?.before).toBe(preview.sha256?.after);

    // The write: the file changes, the export prefix stays, and the attempt records the path.
    const written = await be.client.call('symbol.patch', {
      path: file,
      symbol: 'totalOf',
      kind: 'function',
      line: 6,
      body,
    });
    expect(written.status).toBe('written');
    expect(written.sha256?.after).not.toBe(written.sha256?.before);
    const after = readFileSync(path.join(dir, file), 'utf8');
    expect(after).toContain(
      'export function totalOf(request: CheckoutRequest): Money {\n  if (request.items.length === 0)',
    );
    expect(after).toContain('request.items.reduce(');
    expect(after).not.toContain('mixed currencies');
    expect(after).toContain('export function checkout(request: CheckoutRequest): CheckoutResponse {');
    const run = (
      await td.operator.get<{ runs: { run_id: string; observed_paths?: string[] }[] }>(
        td.operator.projectPath(`/tasks/${task.task_id}`),
      )
    ).runs.find((r) => r.run_id === claim.run_id);
    expect(JSON.stringify(run)).toContain(file);
    const events = await td.operator.get<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      `${td.operator.projectPath('/events')}?task=${task.task_id}&limit=200`,
    );
    const recorded = events.events.find((e) => e.type === 'agent.event' && e.payload.tool === 'friday_symbolic_patch');
    expect(recorded?.payload).toMatchObject({ event_type: 'tool.completed', changed_paths: [file] });
    // The graph follows the edit: the symbol's new range.
    const sym = await be.client.call('graph.query', { name: 'totalOf' });
    expect(sym.symbol?.matches[0]?.symbol).toMatchObject({ line: 6, end_line: 11 });

    // Two patches of the same file side by side: both land, neither overwrites the other (review R2).
    const bodyA = [
      'export function totalOf(request: CheckoutRequest): Money {',
      "  return { amount: 1, currency: 'EUR' };",
      '}',
    ].join('\n');
    const bodyB = [
      'export function checkout(request: CheckoutRequest): CheckoutResponse {',
      "  return { orderId: 'ord_000000', total: totalOf(request) };",
      '}',
    ].join('\n');
    const [ra, rb] = await Promise.all([
      be.client.call('symbol.patch', { path: file, symbol: 'totalOf', body: bodyA }),
      be.client.call('symbol.patch', { path: file, symbol: 'checkout', body: bodyB }),
    ]);
    expect([ra.status, rb.status]).toEqual(['written', 'written']);
    const both = readFileSync(path.join(dir, file), 'utf8');
    expect(both).toContain("return { amount: 1, currency: 'EUR' };");
    expect(both).toContain("return { orderId: 'ord_000000', total: totalOf(request) };");
    // Later checks start from this content.
    const after2 = both;

    // Outside the task's write scope: the policy's answer, not a patch. Then the refusals.
    const outside = await be.client.call('symbol.patch', {
      path: 'shared/src/api.ts',
      symbol: 'isMoney',
      body: 'export function isMoney(x: unknown): x is Money { return true; }',
    });
    expect(outside.status).toBe('denied');
    expect(readFileSync(path.join(dir, 'shared/src/api.ts'), 'utf8')).toContain('isMoney');
    const moved = await be.client.call('symbol.patch', { path: file, symbol: 'totalOf', line: 17, body });
    expect(moved).toMatchObject({ status: 'refused', reason: expect.stringContaining('does not start at line 17') });
    const broken = await be.client.call('symbol.patch', {
      path: file,
      symbol: 'checkout',
      body: 'function checkout(request: CheckoutRequest { return 1; }',
    });
    expect(broken).toMatchObject({ status: 'refused', reason: expect.stringContaining('does not parse') });
    const renamed = await be.client.call('symbol.patch', {
      path: file,
      symbol: 'checkout',
      body: 'export function checkOut(request: CheckoutRequest): CheckoutResponse { return totalOf(request) as never; }',
    });
    expect(renamed).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('declares checkOut, not checkout'),
    });
    const unknown = await be.client.call('symbol.patch', {
      path: file,
      symbol: 'nothing',
      body: 'function nothing() {}',
    });
    expect(unknown).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('no declaration named nothing'),
    });
    const notCode = await be.client.call('symbol.patch', { path: 'backend/README.md', symbol: 'x', body: 'x' });
    expect(notCode).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('not a TypeScript or JavaScript file'),
    });
    expect(readFileSync(path.join(dir, file), 'utf8')).toBe(after2);

    // The tool says what happened.
    const tools = toolsOver(be.client, { agent: { agent_key: 'be-1' }, current_task: task, claimable: [] });
    const said = await tools.friday_symbolic_patch?.handler({
      path: file,
      symbol: 'checkout',
      body: "export function checkout(request: CheckoutRequest): CheckoutResponse {\n  const total = totalOf(request);\n  return { orderId: 'ord_' + String(nextOrder++).padStart(6, '0'), total };\n}",
      dry_run: true,
    });
    expect(said?.text).toMatch(
      /^Preview only, nothing written: checkout in backend\/src\/checkout\.service\.ts \(function, lines \d+-\d+ would become/,
    );
    const refusedSaid = await tools.friday_symbolic_patch?.handler({
      path: file,
      symbol: 'nothing',
      body: 'function nothing() {}',
    });
    expect(refusedSaid?.text).toMatch(/^Not patched: no declaration named nothing/);
  }, 120_000);
});

describe('the code graph answers under the recipient’s read permission (review 2026-10-22, R1)', () => {
  it('withholds files the task may not read from every graph answer, and protected ones', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    for (const part of ['backend', 'frontend', 'shared', 'infra', 'tsconfig.json']) {
      cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop', part), path.join(dir, part), {
        recursive: true,
      });
    }
    // A tracked file in a protected location, with a sentinel no answer may carry.
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'hidden.ts'), "export const hiddenSentinel = 'REVIEW-SENTINEL-R1';\n");
    await deterministicGit(dir).commitAll('fixture-shop with a hidden file');
    // The project keeps the frontend from agents.
    mkdirSync(path.join(ws().fridayDir, 'policies'), { recursive: true });
    writeFileSync(path.join(ws().fridayDir, 'policies', 'private.yaml'), 'deny:\n  read: ["frontend/**"]\n');
    await td.operator.post(td.operator.projectPath('/policy/reload'), {});
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend', mode: 'attach' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes to checkout',
      // A declared read scope (ADR-0028): what it does not name is withheld, `.claude/hidden.ts` included.
      scope: { write: ['backend/**'], read: ['shared/**'] },
      assign_agent_key: 'be-1',
    });
    await be.client.call('task.claim', { task_id: task.task_id });
    const sentinel = 'REVIEW-SENTINEL-R1';

    // A symbol in a withheld file: no match, no name-only reference into it.
    const sym = await be.client.call('graph.query', { name: 'formatPrice' });
    expect(sym.symbol?.matches).toEqual([]);
    expect(JSON.stringify(sym)).not.toContain('frontend/');
    const hidden = await be.client.call('graph.query', { name: 'hiddenSentinel' });
    expect(hidden.symbol?.matches).toEqual([]);
    // A readable symbol's edges and tests never name a withheld file.
    const money = await be.client.call('graph.query', { name: 'Money' });
    expect(money.symbol?.matches.length).toBeGreaterThan(0);
    expect(JSON.stringify(money)).not.toContain('frontend/');
    // A file the agent may not read is refused as such; a readable one lists only readable neighbours.
    await expect(be.client.call('graph.query', { path: 'frontend/src/api-client.ts' })).rejects.toThrow(
      /not a file you may read/,
    );
    await expect(be.client.call('graph.query', { path: '.claude/hidden.ts' })).rejects.toThrow(
      /not a file you may read/,
    );
    const api = await be.client.call('graph.query', { path: 'shared/src/api.ts', depth: 2 });
    expect(api.file?.consumers.length).toBeGreaterThan(0);
    expect(JSON.stringify(api)).not.toContain('frontend/');
    // Words: no hit in a withheld file.
    const words = await be.client.call('graph.query', { words: 'price checkout hidden', limit: 50 });
    expect(JSON.stringify(words)).not.toContain('frontend/');
    expect(JSON.stringify(words)).not.toContain('hidden');
    // A blast radius never names a withheld file, and a seed the agent may not read is no seed.
    const blast = await be.client.call('graph.blast_radius', { paths: ['shared/src/api.ts'], depth: 3 });
    expect(blast.affected.length).toBeGreaterThan(0);
    expect(JSON.stringify(blast)).not.toContain('frontend/');
    await expect(be.client.call('graph.blast_radius', { paths: ['frontend/src/api-client.ts'] })).rejects.toThrow(
      /none of the seeds is a file you may read/,
    );
    // A skeleton of a withheld file is named back, never shown; the sentinel reaches no answer.
    const sk = await be.client.call('graph.skeleton', {
      paths: ['frontend/src/format-price.ts', '.claude/hidden.ts', 'backend/src/checkout.service.ts'],
    });
    expect(sk.files.map((f) => f.path)).toEqual(['backend/src/checkout.service.ts']);
    expect(sk.missing.map((m) => [m.path, m.reason])).toEqual([
      ['frontend/src/format-price.ts', 'not a file you may read'],
      ['.claude/hidden.ts', 'not a file you may read'],
    ]);
    expect(JSON.stringify(sk)).not.toContain(sentinel);
    // The same request through the context compiler withholds the same files.
    const packet = await be.client.requestContext({
      task_id: task.task_id,
      kind: 'file',
      paths: ['.claude/hidden.ts'],
    });
    expect(JSON.stringify(packet)).not.toContain(sentinel);
  }, 120_000);
});
