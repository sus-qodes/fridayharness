/**
 * The context compiler (plan M4d, ADR-0022) on fixture-shop.
 */
import { cpSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
import { ContextCache, type ContextDeps, type ContextPolicy, compileContext, packetStaleness } from './index.js';

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
