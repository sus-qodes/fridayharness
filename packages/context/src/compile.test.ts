/**
 * The context compiler (plan M4d, ADR-0022) on fixture-shop.
 */
import { cpSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph, type CodeGraph, memoryFactsCache } from '@friday/code-graph';
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { GitRoot } from '@friday/git';
import { type Actor, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { FridayState } from '@friday/state';
import { deterministicGit, FakeClock, useTestWorkspace } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { HANDOFF_MAX_CHARS } from './compile.js';
import {
  boundRecord,
  ContextCache,
  type ContextDeps,
  type ContextPolicy,
  compileContext,
  packetStaleness,
  RECORD_LIMIT_BYTES,
} from './index.js';

const ws = useTestWorkspace();
const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };

let state: FridayState;
let deps: ContextDeps;
let dir: string;
let agent: { agent_id: string; harness_id: string };

beforeEach(async () => {
  dir = path.join(ws().root, 'shop');
  cpSync(path.join(REPO, 'tests', 'fixtures', 'fixture-shop'), dir, { recursive: true });
  const g = deterministicGit(dir);
  await g.init();
  await g.commitAll('fixture');
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-10-14T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: dir });
  const root = await GitRoot.open(dir);
  const facts = memoryFactsCache();
  let graph: CodeGraph | undefined;
  deps = {
    state,
    project: {
      project_id: PROJECT,
      name: 'shop',
      root: root.root,
      config: { context: { session_start_max_chars: 9000 } },
    },
    git: async () => root,
    graph: async () => {
      const version = (await root.identity()).version;
      if (graph?.version !== version) graph = await buildGraph(root, { cache: facts });
      return graph;
    },
    cache: new ContextCache(),
  };
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: 'fake:be-1',
      vendor: 'generic',
      name: 'be-1',
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: 'be-1', role: 'backend' },
    }),
  );
  agent = { agent_id: r.agent_id, harness_id: r.harness_id };
});

function backendTask(read: string[] = []): string {
  return state.createTask(PROJECT, human, {
    summary: 'Add discount codes to checkout',
    description: 'Apply a discount code to the checkout total.',
    acceptance_criteria: ['node --test passes'],
    scope: { write: ['backend/**'], read },
    assign_agent_key: 'be-1',
  }).task_id;
}

const compile = (taskId: string, extra: { max_chars?: number; purpose?: string } = {}) =>
  compileContext(
    deps,
    {
      recipient: { kind: 'agent', id: agent.agent_id, harness_id: agent.harness_id },
      task_id: taskId,
      purpose: extra.purpose ?? 'test',
      ...(extra.max_chars ? { max_chars: extra.max_chars } : {}),
    },
    { kind: 'agent', id: agent.agent_id },
  );

const section = (packet: { sections: { kind: string; content: string }[] }, kind: string) =>
  packet.sections.find((s) => s.kind === kind)?.content ?? '';

describe('what a backend task receives (Part 12 §13)', () => {
  it('gets the shared contract, the frontend that consumes it and the tests, never the infra config', async () => {
    const { packet, explanation } = await compile(backendTask());
    const related = section(packet, 'code.related');
    expect(related).toContain('backend/src/checkout.service.ts — in your write scope');
    expect(related).toMatch(/shared\/src\/api\.ts — .*shared contract used by backend, frontend/);
    expect(related).toMatch(/frontend\/src\/api-client\.ts — uses the shared contract shared\/src\/api\.ts/);
    expect(related).toContain('backend/test/checkout.service.test.ts — in your write scope; a test');
    expect(JSON.stringify(packet)).not.toContain('infra/');
    expect(packet.source_version).toMatch(/^[0-9a-f]{40}$/);
    expect(explanation.included.find((i) => i.source_id === 'frontend/src/api-client.ts')).toMatchObject({
      rule: 'graph exact, distance 2 (priority 3)',
    });
    for (const kind of [
      'agent.identity',
      'task.contract',
      'task.acceptance',
      'task.scope',
      'repo.head',
      'protocol.reminder',
    ]) {
      expect(packet.sections.map((s) => s.kind)).toContain(kind);
    }
    expect(explanation.semantic_fallback).toEqual({ enabled: false, results: 0 });
  });

  it('never gathers, or names, a file the task may not read', async () => {
    const { packet, explanation } = await compile(backendTask(['backend/**', 'shared/**']));
    expect(section(packet, 'code.related')).toContain('shared/src/api.ts');
    expect(JSON.stringify(packet)).not.toContain('frontend/');
    expect(JSON.stringify(explanation)).not.toContain('frontend/');
    expect(explanation.withheld_by_permission).toBeGreaterThan(0);
  });

  it("applies the project's effective read policy, and a changed policy is a new packet for the same code (review F02)", async () => {
    let policy: ContextPolicy = { version: 'v1', deny: { read: [] }, teams: {} };
    deps.policy = () => policy;
    const taskId = backendTask();
    const first = await compile(taskId);
    expect(section(first.packet, 'code.related')).toContain('frontend/src/api-client.ts');

    // The project keeps the frontend from agents: the stored packet no longer stands, and the next
    // one leaves the frontend out, although the code is the same.
    policy = { version: 'v2', deny: { read: ['frontend/**'] }, teams: {} };
    expect((await packetStaleness(deps, first.packet, first.explanation)).staleness).toMatchObject({
      is_stale: true,
      reason: expect.stringContaining('policy'),
    });
    const second = await compile(taskId);
    expect(second.cached).toBe(false);
    expect(second.packet.source_version).toBe(first.packet.source_version);
    expect(JSON.stringify(second.packet)).not.toContain('frontend/');
    expect(JSON.stringify(second.explanation)).not.toContain('frontend/');
    expect(second.explanation.policy_version).toBe('v2');

    // A team scope that names reads narrows what is gathered, as the task's own read scope does.
    policy = {
      version: 'v3',
      deny: { read: [] },
      teams: { backend: [{ source: 'teams.yaml', write: ['backend/**'], read: ['shared/**'] }] },
    };
    const third = await compile(taskId);
    expect(section(third.packet, 'code.related')).toContain('shared/src/api.ts');
    expect(JSON.stringify(third.packet)).not.toContain('frontend/');

    // An exact path a human approved for this task is shown anyway; its grant is part of the key.
    policy = { version: 'v4', deny: { read: ['frontend/**'] }, teams: {} };
    deps.readGrants = () => [{ approval_id: 'apr_1', target: 'frontend/src/api-client.ts' }];
    const granted = await compile(taskId);
    expect(granted.cached).toBe(false);
    expect(section(granted.packet, 'code.related')).toContain('frontend/src/api-client.ts');
    expect(section(granted.packet, 'code.related')).not.toContain('frontend/src/format-price.ts');
    deps.readGrants = undefined;

    // The policy changes while sources are gathered: the packet is compiled again under the new one.
    policy = { version: 'v5', deny: { read: [] }, teams: {} };
    const graphOf = deps.graph;
    let flipped = false;
    deps.graph = async (root) => {
      const g = await graphOf(root);
      if (!flipped) {
        flipped = true;
        policy = { version: 'v6', deny: { read: ['frontend/**'] }, teams: {} };
      }
      return g;
    };
    const raced = await compile(taskId, { purpose: 'race' });
    expect(raced.explanation.policy_version).toBe('v6');
    expect(JSON.stringify(raced.packet)).not.toContain('frontend/');
  });
});

describe('budget', () => {
  it('keeps every protected section and cuts the rest by rank', async () => {
    const taskId = backendTask();
    state.memory.record(
      PROJECT,
      { kind: 'human', actor: human },
      {
        scope_type: 'project',
        kind: 'decision',
        subject: 'money',
        content: 'Money is integer minor units with an ISO-4217 currency.',
      },
    );
    const { packet, explanation } = await compile(taskId, { max_chars: 4500 });
    for (const kind of [
      'agent.identity',
      'task.contract',
      'task.acceptance',
      'task.scope',
      'repo.head',
      'protocol.reminder',
    ]) {
      expect(packet.sections.map((s) => s.kind)).toContain(kind);
    }
    expect(explanation.cut_by_budget.length).toBeGreaterThan(0);
    const worstIncluded = Math.max(...explanation.included.filter((i) => !i.protected).map((i) => i.priority), 0);
    const bestCut = Math.min(...explanation.cut_by_budget.map((c) => c.priority));
    expect(bestCut).toBeGreaterThanOrEqual(worstIncluded === 0 ? 0 : Math.min(worstIncluded, bestCut));
    // What is delivered fits what is advertised (review F12): the JSON packet, sources and all.
    expect(packet.budget.chars).toBe(4500);
    expect(JSON.stringify(packet).length).toBeLessThanOrEqual(4500);
    expect(explanation.budget.used_chars).toBe(JSON.stringify(packet).length);
  });

  it('says how much the protected context needs instead of exceeding the budget it was given (review F12)', async () => {
    const taskId = state.createTask(PROJECT, human, {
      summary: 'Add discount codes to checkout',
      description: `${'Apply a discount code to the checkout total and keep its audit trail. '.repeat(120)}`,
      acceptance_criteria: Array.from({ length: 12 }, (_, i) => `criterion ${i + 1}: ${'it holds '.repeat(10)}`),
      scope: { write: ['backend/**'], read: [] },
      assign_agent_key: 'be-1',
    }).task_id;
    // A caller that asked for a size: told exactly what the protected sections need.
    const refused = await compileContext(
      deps,
      {
        recipient: { kind: 'agent', id: agent.agent_id, harness_id: agent.harness_id },
        task_id: taskId,
        purpose: 'request:task',
        max_chars: 500,
        overflow: 'refuse',
      },
      { kind: 'agent', id: agent.agent_id },
    ).catch((e: FridayError) => e);
    expect(refused).toBeInstanceOf(FridayError);
    expect((refused as FridayError).code).toBe('COS-5002');
    const need = (refused as FridayError).details as { required_chars: number; max_chars: number };
    expect(need.max_chars).toBe(500);
    expect(need.required_chars).toBeGreaterThan(8000);
    // Friday's own delivery raises the budget to what they need, and the packet says so.
    const raised = await compile(taskId, { max_chars: 500, purpose: 'request:task' });
    expect(raised.packet.budget.chars).toBe(need.required_chars);
    expect(JSON.stringify(raised.packet).length).toBeLessThanOrEqual(raised.packet.budget.chars ?? 0);
    expect(raised.explanation.budget).toMatchObject({ asked_chars: 500, chars: need.required_chars });
    expect(raised.explanation.notes.join(' ')).toContain('the budget was raised');
    // The stored packet still stands: its key is the one it was asked with.
    expect((await packetStaleness(deps, raised.packet, raised.explanation)).staleness.is_stale).toBe(false);
  });
});

describe('cache and staleness', () => {
  it('serves the same packet until a key component changes, and ignores tool completions', async () => {
    const taskId = backendTask();
    const first = await compile(taskId);
    const again = await compile(taskId);
    expect(again).toMatchObject({ cached: true, packet: { context_id: first.packet.context_id } });
    // An observation does not change the key.
    const run = state.claimTask(PROJECT, agent, { task_id: taskId });
    const claimed = await compile(taskId);
    expect(claimed.cached).toBe(false); // the task's status changed
    state.recordObservation(
      PROJECT,
      { kind: 'agent', id: agent.agent_id },
      'agent.event',
      { task_id: taskId, run_id: run.run_id, event_type: 'tool.completed', summary: 'ran tests' },
      [{ kind: 'task', id: taskId }],
    );
    expect((await compile(taskId)).packet.context_id).toBe(claimed.packet.context_id);
    // An uncommitted edit does, and the stored packet reports itself stale.
    writeFileSync(path.join(dir, 'backend', 'src', 'checkout.service.ts'), '// edited\n');
    expect((await packetStaleness(deps, claimed.packet, claimed.explanation)).staleness).toMatchObject({
      is_stale: true,
      reason: expect.stringContaining('the code changed'),
    });
    const edited = await compile(taskId);
    expect(edited.cached).toBe(false);
    expect(section(edited.packet, 'repo.dirty')).toContain('backend/src/checkout.service.ts');
    // So does a new memory.
    state.memory.record(
      PROJECT,
      { kind: 'human', actor: human },
      { scope_type: 'project', kind: 'convention', subject: 'tests', content: 'Every discount rule has a test.' },
    );
    const remembered = await compile(taskId);
    expect(remembered.cached).toBe(false);
    expect(section(remembered.packet, 'memory.relevant')).toContain('Every discount rule has a test.');
  });

  it('never reuses a packet for code identified only approximately, and says so (review F13)', async () => {
    // Above its hashing limit (here 0 files), git identifies uncommitted changes by size and time.
    const approximate = await GitRoot.open(dir, { maxHashedFiles: 0 });
    deps.git = async () => approximate;
    writeFileSync(path.join(dir, 'backend', 'src', 'checkout.service.ts'), '// edited\n');
    const taskId = backendTask();
    const first = await compile(taskId);
    const again = await compile(taskId);
    expect(again.cached).toBe(false);
    expect(again.packet.context_id).not.toBe(first.packet.context_id);
    expect(first.explanation.source_basis).toBe('approximate');
    expect(first.explanation.notes.join(' ')).toContain('approximately');
    expect((await packetStaleness(deps, again.packet, again.explanation)).staleness).toMatchObject({
      is_stale: true,
      reason: expect.stringContaining('approximately'),
    });
  });
});

describe('what a request asks for (review F17)', () => {
  const ask = (taskId: string, request: { kind: string; query?: string; paths?: string[] }) =>
    compileContext(
      deps,
      {
        recipient: { kind: 'agent', id: agent.agent_id, harness_id: agent.harness_id },
        task_id: taskId,
        purpose: `request:${request.kind}`,
        request,
      },
      { kind: 'agent', id: agent.agent_id },
    );

  it('gathers the files and history asked for, within permission, and says what it cannot answer', async () => {
    const taskId = backendTask();
    const a = await ask(taskId, { kind: 'file', paths: ['backend/src/checkout.service.ts'] });
    const b = await ask(taskId, { kind: 'file', paths: ['shared/src/api.ts'] });
    expect(a.packet.context_id).not.toBe(b.packet.context_id);
    expect(section(a.packet, 'code.requested')).toMatch(/^backend\/src\/checkout\.service\.ts:\n/);
    expect(section(a.packet, 'code.requested')).toContain('export');
    expect(section(b.packet, 'code.requested')).toMatch(/^shared\/src\/api\.ts:\n/);
    expect(section(b.packet, 'code.requested')).not.toContain('checkout.service');
    expect(a.explanation.included.find((i) => i.section === 'code.requested')?.reason).toBe('you asked for this file');

    // What the recipient may not read is not shown, also behind a link (a junction on Windows).
    deps.policy = () => ({ version: 'v1', deny: { read: ['infra/**'] }, teams: {} });
    symlinkSync(path.join(dir, 'infra'), path.join(dir, 'backend', 'linked'), 'junction');
    const denied = await ask(taskId, {
      kind: 'file',
      paths: ['infra/deploy.config.json', 'backend/linked/deploy.config.json', '.git/config'],
    });
    const text = JSON.stringify(denied.packet);
    for (const p of ['infra/deploy', 'linked/deploy', '.git/config']) expect(text).not.toContain(p);
    expect(denied.explanation.withheld_by_permission).toBeGreaterThanOrEqual(3);

    // History of the paths asked for.
    const history = await ask(taskId, { kind: 'history', paths: ['backend/src/checkout.service.ts'] });
    expect(section(history.packet, 'repo.history')).toContain('fixture');

    // What Friday cannot look up yet is said, never ignored in silence.
    const symbol = await ask(taskId, { kind: 'symbol', query: 'applyDiscount' });
    expect(section(symbol.packet, 'request.note')).toContain('Not supported yet');
    expect(section(symbol.packet, 'request.note')).toContain('applyDiscount');
    expect(symbol.explanation.notes).toContain('symbol requests are not supported yet');
  });
});

describe('memory precedence', () => {
  it('ranks a human-approved decision above an agent memory that contradicts it, and says which was kept', async () => {
    const taskId = backendTask();
    const decision = state.memory.record(
      PROJECT,
      { kind: 'human', actor: human },
      {
        scope_type: 'project',
        kind: 'decision',
        subject: 'discounts',
        content: 'Discount codes are case-insensitive.',
      },
    ).memory;
    const guess = state.memory.record(
      PROJECT,
      { kind: 'agent', caller: agent },
      {
        scope_type: 'task',
        scope_id: taskId,
        kind: 'decision',
        subject: 'discounts',
        content: 'Discount codes are case-sensitive.',
      },
    ).memory;
    const { packet, explanation } = await compile(taskId);
    const memory = section(packet, 'memory.relevant');
    expect(memory.indexOf(decision.memory_id)).toBeLessThan(memory.indexOf(guess.memory_id));
    expect(memory).toContain('[human-approved, decision]');
    expect(explanation.memory_conflicts).toContainEqual({
      memory_id: guess.memory_id,
      contradicts: [decision.memory_id],
      kept: decision.memory_id,
    });
  });
});

describe('cost', () => {
  // The plan's target (E.1) is under 300 ms for a deterministic compile. Measured alone it is
  // 130-200 ms on fixture-shop; when the whole suite runs in parallel, git processes compete (the
  // best of five took over 600 ms on a busy machine), so the strict target is checked with
  // FRIDAY_TEST_BENCH=1 and the normal suite only catches a tenfold regression.
  const budgetMs = process.env.FRIDAY_TEST_BENCH ? 300 : 3000;
  it('compiles within the deterministic budget, and reports its size against the files it points to', async () => {
    const taskId = backendTask();
    await compile(taskId); // builds the graph once
    const runs: number[] = [];
    let last: Awaited<ReturnType<typeof compile>> | undefined;
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      last = await compile(taskId, { purpose: `timing-${i}` });
      runs.push(performance.now() - started);
    }
    const best = Math.min(...runs);
    expect(best).toBeLessThan(budgetMs);
    const { packet, explanation } = last as Awaited<ReturnType<typeof compile>>;
    const pointed = explanation.included
      .filter((i) => i.section === 'code.related')
      .reduce((n, i) => n + statSync(path.join(dir, i.source_id)).size, 0);
    const packetChars = JSON.stringify(packet.sections).length;
    console.log(
      `context: best ${Math.round(best)} ms of 5; packet ${packetChars} chars; files it points to ${pointed} bytes; ${explanation.included.length} sources`,
    );
  });
});

describe('the record of a packet (plan M12.6)', () => {
  it('cuts the explanation lists until the record fits one event, the cut-by-budget list first, and says so', async () => {
    const { packet, explanation } = await compile(backendTask());
    // A large repository: two hundred candidates cut and two hundred included, each with a reason.
    const entry = (i: number) => ({
      section: 'code.related',
      source_id: `packages/some-package/src/deeply/nested/folder/file-${i}.ts`,
      priority: 5,
      reason: `imports packages/other/src/index.ts, which the write scope imports (graph certain, distance 2) ${'x'.repeat(120)}`,
      tokens: 40,
    });
    const size = (e: typeof explanation) => Buffer.byteLength(JSON.stringify({ packet, explanation: e }), 'utf8');
    const cutOnly = { ...explanation, cut_by_budget: Array.from({ length: 200 }, (_, i) => entry(1000 + i)) };
    expect(size(cutOnly)).toBeGreaterThan(RECORD_LIMIT_BYTES);
    const bounded = boundRecord(packet, cutOnly);
    expect(size(bounded)).toBeLessThanOrEqual(RECORD_LIMIT_BYTES);
    // The included list is kept whole while cutting the other list suffices; the note counts both.
    expect(bounded.included).toEqual(explanation.included);
    expect(bounded.cut_by_budget.length).toBeLessThan(200);
    expect(bounded.cut_by_budget.length).toBeGreaterThan(0);
    expect(bounded.notes.at(-1)).toBe(
      `the record lists ${bounded.cut_by_budget.length} of 200 sources cut by the budget and ${explanation.included.length} of ${explanation.included.length} included, so it fits one event`,
    );
    expect(bounded.budget).toEqual(explanation.budget);
    // Both lists too large: the included list is cut only once nothing cut by the budget is left.
    const both = {
      ...cutOnly,
      included: Array.from({ length: 200 }, (_, i) => ({
        ...entry(i),
        relevance: 0.5,
        protected: false,
        rule: 'graph',
      })),
    };
    expect(size(both)).toBeGreaterThan(64 * 1024);
    const twice = boundRecord(packet, both);
    expect(size(twice)).toBeLessThanOrEqual(RECORD_LIMIT_BYTES);
    expect(twice.cut_by_budget).toHaveLength(0);
    expect(twice.included.length).toBeLessThan(200);
    expect(twice.notes.at(-1)).toBe(
      `the record lists 0 of 200 sources cut by the budget and ${twice.included.length} of 200 included, so it fits one event`,
    );
    // A record that fits is returned as it is, and the bounded one is recorded without an error.
    expect(boundRecord(packet, explanation)).toBe(explanation);
    expect(() =>
      state.recordContextPacket(PROJECT, human, { ...packet, context_id: 'ctx_bounded' }, twice),
    ).not.toThrow();
  });
});

describe('authority at delivery (review M7.1 R02, R06)', () => {
  const ask = (taskId: string, request: { kind: string; paths?: string[] }) =>
    compileContext(
      deps,
      {
        recipient: { kind: 'agent', id: agent.agent_id, harness_id: agent.harness_id },
        task_id: taskId,
        purpose: `request:${request.kind}`,
        request,
      },
      { kind: 'agent', id: agent.agent_id },
    );
  const client = 'frontend/src/api-client.ts';

  it('delivers nothing gathered under a grant, a policy or a task that changed meanwhile (R02)', async () => {
    const taskId = backendTask();
    const graphOf = deps.graph;
    // A: the human's exact-path grant is withdrawn while sources are gathered; the policy stays.
    writeFileSync(path.join(dir, client), '// REVOKED_GRANT_CONTENT\nexport {};\n');
    deps.policy = () => ({ version: 'v1', deny: { read: ['frontend/**'] }, teams: {} });
    let grants = [{ approval_id: 'apr_r02', target: client }];
    deps.readGrants = () => grants;
    deps.graph = async (root) => {
      const g = await graphOf(root);
      grants = [];
      return g;
    };
    const revoked = await ask(taskId, { kind: 'file', paths: [client] });
    expect(JSON.stringify(revoked.packet)).not.toContain('REVOKED_GRANT_CONTENT');
    expect(revoked.packet.staleness.is_stale).toBe(false);
    expect(revoked.explanation.withheld_by_permission).toBeGreaterThan(0);

    // B: the policy changes during every attempt, and the last change denies the file: nothing is
    // delivered, not even marked stale; a calm request then follows the policy in force.
    deps.readGrants = undefined;
    writeFileSync(path.join(dir, client), '// CHURN_DENIED_CONTENT\nexport {};\n');
    let n = 1;
    let policy: ContextPolicy = { version: 'c1', deny: { read: [] }, teams: {} };
    deps.policy = () => policy;
    deps.graph = async (root) => {
      const g = await graphOf(root);
      n += 1;
      policy = { version: `c${n}`, deny: { read: n >= 4 ? ['frontend/**'] : [] }, teams: {} };
      return g;
    };
    await expect(ask(taskId, { kind: 'file', paths: [client] })).rejects.toThrow(/kept changing/);
    deps.graph = graphOf;
    const calm = await ask(taskId, { kind: 'file', paths: [client] });
    expect(JSON.stringify(calm.packet)).not.toContain('CHURN_DENIED_CONTENT');

    // C: the task is cancelled while its packet is compiled: the packet shows the task as it is.
    deps.policy = undefined;
    let cancelled = false;
    deps.graph = async (root) => {
      const g = await graphOf(root);
      if (!cancelled) {
        cancelled = true;
        state.cancelTask(PROJECT, human, taskId, 'no longer needed');
      }
      return g;
    };
    const late = await compile(taskId, { purpose: 'during-cancel' });
    expect(section(late.packet, 'task.contract')).toContain('CANCELLED');
    deps.graph = graphOf;
  });

  it('history names only commits that change a file the recipient may read (R06)', async () => {
    const g = deterministicGit(dir, { startEpoch: 1_767_300_000 });
    const append = (rel: string, text: string) =>
      writeFileSync(path.join(dir, rel), `${readFileSync(path.join(dir, rel), 'utf8')}${text}`);
    append(client, '// a private change\n');
    await g.run(['add', client]);
    await g.run(['commit', '-q', '-m', `PRIVATE_HISTORY_MARKER: ${client} deployment`]);
    append('backend/src/checkout.service.ts', '// a readable change\n');
    await g.run(['add', 'backend/src/checkout.service.ts']);
    await g.run(['commit', '-q', '-m', 'READABLE_HISTORY_MARKER: checkout']);
    append(client, '// mixed\n');
    append('backend/src/checkout.service.ts', '// mixed\n');
    await g.run(['add', '-A']);
    await g.run(['commit', '-q', '-m', 'MIXED_HISTORY_MARKER: both']);
    const taskId = state.createTask(PROJECT, human, {
      summary: 'Look after the whole shop',
      acceptance_criteria: ['node --test passes'],
      scope: { write: ['**'], read: [] },
      assign_agent_key: 'be-1',
    }).task_id;

    // The file is kept from the agent by a pattern, by its exact path, or by its team's read scope.
    const team = { source: 'policies/teams.yaml', write: ['backend/**'], read: ['backend/**', 'shared/**'] };
    const policies: ContextPolicy[] = [
      { version: 'glob', deny: { read: ['frontend/**'] }, teams: {} },
      { version: 'path', deny: { read: [client] }, teams: {} },
      { version: 'team', deny: { read: [] }, teams: { backend: [team] } },
    ];
    for (const policy of policies) {
      deps.policy = () => policy;
      const asked = await ask(taskId, { kind: 'history' });
      const recent = await compile(taskId, { purpose: `recent:${policy.version}` });
      for (const p of [asked.packet, recent.packet]) {
        expect(JSON.stringify(p), policy.version).not.toContain('PRIVATE_HISTORY_MARKER');
        expect(JSON.stringify(p), policy.version).not.toContain(client);
      }
      // A commit that changes a readable file is shown, mixed ones included: its message is the
      // committer's text, about whatever it changed.
      expect(section(asked.packet, 'repo.history'), policy.version).toContain('READABLE_HISTORY_MARKER');
      expect(section(asked.packet, 'repo.history'), policy.version).toContain('MIXED_HISTORY_MARKER');
      expect(section(recent.packet, 'repo.recent_commits'), policy.version).toContain('READABLE_HISTORY_MARKER');
    }
  });
});

describe('the handoff summary (plan M12.3)', () => {
  const LABELS = ['Goal:', 'Done so far:', 'Checked:', 'Decided:', 'Next:', 'Files:'];
  const caller = () => ({ harness_id: agent.harness_id, agent_id: agent.agent_id });
  /** The spawn harness accepts what Friday sent it, as a FakeHarness does. */
  const accept = () => {
    const msgs = state.pollOutbox(PROJECT, agent.harness_id, 10);
    state.ackOutbox(
      PROJECT,
      agent.harness_id,
      msgs.map((m) => ({ message_id: m.message_id, accepted: true, session_ref: 'sess-be-1' })),
    );
  };
  /** An attempt of be-1 on the task: assigned, accepted, RUNNING. */
  const startAttempt = (taskId: string): string => {
    state.assignTask(PROJECT, human, taskId, 'be-1');
    accept();
    const t = state.q.task(PROJECT, taskId);
    expect(t.status).toBe('RUNNING');
    return t.current_run_id as string;
  };
  /** The labels appear once each, in the fixed order. */
  const expectLabelled = (text: string) => {
    const at = LABELS.map((l) => text.indexOf(`\n${l}`));
    for (const [i, l] of LABELS.entries()) expect(at[i], l).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  };

  it("replaces a second attempt's progress notes with the summary of what the first did, decided and left", async () => {
    const taskId = backendTask();
    const run1 = startAttempt(taskId);
    state.updateTask(PROJECT, caller(), {
      task_id: taskId,
      run_id: run1,
      note: 'the discount service is written; the webhook is next',
      changed_paths: ['backend/src/discount.ts'],
    });
    // A first attempt sees its notes as before: no handoff.
    const first = await compile(taskId, { purpose: 'first' });
    expect(section(first.packet, 'task.progress')).toContain('the discount service is written');
    expect(section(first.packet, 'task.progress')).not.toContain('Handoff:');

    const asked = state.requestPermission(PROJECT, caller(), {
      task_id: taskId,
      run_id: run1,
      action_class: 'file.write',
      resource: 'shared/src/api.ts',
      justification: 'the contract gains a field',
      ttl_s: 600,
    });
    state.decideApproval(PROJECT, human, asked.approval_id as string, true);
    const refused = state.requestPermission(PROJECT, caller(), {
      task_id: taskId,
      run_id: run1,
      action_class: 'shell.git.push',
      command: 'git push',
      justification: 'ship it',
      ttl_s: 600,
    });
    state.decideApproval(PROJECT, human, refused.approval_id as string, false);
    const q = state.requestEscalation(PROJECT, caller(), {
      task_id: taskId,
      run_id: run1,
      question: 'Which currency is the default?',
    });
    state.answerEscalation(PROJECT, human, q.escalation_id, 'EUR, minor units');
    state.submitResult(PROJECT, caller(), {
      idempotency_key: 'claim-1',
      task_id: taskId,
      run_id: run1,
      status: 'completed_claim',
      summary: 'discount codes apply at checkout',
      changed_paths: ['backend/src/discount.ts', 'backend/src/checkout.service.ts'],
      checks: [],
      notes: ['the webhook handler still has to be wired'],
      risks: [],
    });
    const { verification_id } = state.startVerification(PROJECT, human, taskId);
    state.recordVerificationCheck(PROJECT, human, verification_id, {
      name: 'node --test',
      kind: 'test',
      status: 'FAILED',
      exit_code: 1,
      artifact_ref: null,
      summary: '2 failing',
    });
    state.finishVerification(PROJECT, human, verification_id, false, 'tests failed');
    state.reworkTask(PROJECT, human, taskId, 'fix the failing tests');
    startAttempt(taskId);

    const { packet, explanation } = await compile(taskId, { purpose: 'second' });
    const text = section(packet, 'task.progress');
    expect(text.startsWith(`Handoff: attempt 1 of ${taskId}, for attempt 2.`)).toBe(true);
    expectLabelled(text);
    expect(text).toContain('Goal: Add discount codes to checkout Constraints: none from the human');
    expect(text).toContain('(attempt 1): the discount service is written; the webhook is next');
    expect(text).toContain('(attempt 1) claimed done: discount codes apply at checkout');
    expect(text).toContain('- verification FAILED: tests failed; node --test FAILED (exit 1)');
    expect(text).toContain('- approved file.write shared/src/api.ts');
    expect(text).toContain('- refused shell.git.push git push');
    expect(text).toContain('- asked "Which currency is the default?" -> EUR, minor units');
    expect(text).toContain('Next: the webhook handler still has to be wired');
    expect(text).toContain('Files: backend/src/checkout.service.ts, backend/src/discount.ts');
    expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    // The note is in the summary, not repeated as a loose line, and the summary is protected.
    expect(packet.sections.filter((s) => s.kind === 'task.progress')).toHaveLength(1);
    expect(explanation.included.find((i) => i.section === 'task.progress')).toMatchObject({
      protected: true,
      rule: 'protected: handoff summary (plan M12.3)',
    });
    // A tight budget keeps it, like the contract.
    const tight = await compile(taskId, { purpose: 'tight', max_chars: 3000 });
    expect(section(tight.packet, 'task.progress')).toContain('Handoff: attempt 1');
  });

  it('cuts the oldest "Done so far" lines first and never exceeds 1,500 characters', async () => {
    const taskId = backendTask();
    const run1 = startAttempt(taskId);
    for (let i = 1; i <= 30; i += 1) {
      state.updateTask(PROJECT, caller(), {
        task_id: taskId,
        run_id: run1,
        note: `step ${i}: ${'checked the pricing rules and adjusted the rounding '.repeat(2)}`,
        changed_paths: [`backend/src/step-${i}.ts`],
      });
    }
    state.recoverTask(PROJECT, human, taskId, 'reassign', { reason: 'the session was lost' });
    expect(state.q.task(PROJECT, taskId).status).toBe('READY');
    startAttempt(taskId);

    const { packet } = await compile(taskId, { purpose: 'cut' });
    const text = section(packet, 'task.progress');
    expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    expectLabelled(text);
    expect(text).toMatch(/- \(\d+ earlier lines cut\)/);
    // The newest note stays and is what remains; the oldest went first.
    expect(text).toContain('step 30:');
    expect(text).not.toContain('step 1:');
    expect(text).toMatch(/Next: step 30:/);
    // The file list is whole: the notes went first.
    expect(text).toContain('Files: backend/src/step-1.ts, backend/src/step-10.ts');
    expect(text).toContain('backend/src/step-9.ts');
    // A new record is a new packet: the summary is part of the key.
    const again = await compile(taskId, { purpose: 'cut' });
    expect(again.cached).toBe(true);
    const run2 = state.q.task(PROJECT, taskId).current_run_id as string;
    state.updateTask(PROJECT, caller(), { task_id: taskId, run_id: run2, note: 'attempt 2 picked it up' });
    const fresh = await compile(taskId, { purpose: 'cut' });
    expect(fresh.cached).toBe(false);
    expect(section(fresh.packet, 'task.progress')).toContain('(attempt 2): attempt 2 picked it up');
  });

  it('shortens the file list, from its end, once the notes are gone and the files alone exceed the bound', async () => {
    const taskId = backendTask();
    const run1 = startAttempt(taskId);
    for (const batch of [0, 1]) {
      state.updateTask(PROJECT, caller(), {
        task_id: taskId,
        run_id: run1,
        note: `batch ${batch} of the pricing tables rewritten`,
        changed_paths: Array.from({ length: 45 }, (_, i) => `backend/src/pricing/table-${batch * 45 + i}.ts`),
      });
    }
    state.recoverTask(PROJECT, human, taskId, 'restart', { reason: 'start from the last commit' });
    startAttempt(taskId);
    const { packet } = await compile(taskId, { purpose: 'files' });
    const text = section(packet, 'task.progress');
    expect(text.length).toBeLessThanOrEqual(HANDOFF_MAX_CHARS);
    expectLabelled(text);
    expect(text).toMatch(/Files: backend\/src\/pricing\/table-0\.ts, .* and \d+ more$/);
    expect(text).toContain('- (2 earlier lines cut)');
    // What remains is still said, from the newest note, although its line was cut.
    expect(text).toContain('Next: batch 1 of the pricing tables rewritten');
  });
});
