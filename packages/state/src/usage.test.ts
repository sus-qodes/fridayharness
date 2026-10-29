/**
 * The token baseline (plan M10a): one usage row per run attempt, joined from the event log. The
 * events here are made by hand, shaped as the hooks router, the spawn adapters and the context
 * compiler record them.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, type ContextPacket, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { FridayState } from './index.js';
import { toolKind } from './usage.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

function register(key: string, agent: string, mode: 'attach' | 'spawn') {
  return state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `${mode === 'spawn' ? 'generic' : 'claude-code'}:${PROJECT}:${key}`,
      vendor: mode === 'spawn' ? 'generic' : 'claude-code',
      name: key,
      attach_mode: mode,
      project_id: PROJECT,
      capabilities: { task_start: mode === 'spawn' },
      agent: { agent_key: agent, role: 'developer' },
      host: { session_id: `sess-${key}` },
    }),
  );
}

let packets = 0;

/** A packet as the compiler records it; only the fields the row reads carry meaning here. */
function packet(o: {
  agentId: string;
  taskId: string;
  runId?: string;
  /** The session it was compiled for, as the daemon names it on every packet it delivers. */
  harnessId?: string;
  createdAt: string;
  tokens: number;
  chars?: number;
  sources: number[];
  purpose: string;
}): ContextPacket {
  packets += 1;
  return {
    context_id: `ctx_${String(packets).padStart(26, '0')}`,
    project_id: PROJECT,
    recipient: {
      kind: 'agent',
      id: o.agentId,
      ...(o.harnessId ? { harness_id: o.harnessId } : {}),
      ...(o.runId ? { run_id: o.runId } : {}),
    },
    task_id: o.taskId,
    purpose: o.purpose,
    created_at: o.createdAt,
    state_version: 1,
    budget: { tokens: o.tokens, latency_ms: 50, ...(o.chars === undefined ? {} : { chars: o.chars }) },
    sections: [
      {
        kind: 'task',
        content: 'the task',
        authority: 'task',
        sources: o.sources.map((estimated_tokens, i) => ({
          source_id: `src-${i}`,
          source_type: 'task_record' as const,
          authority: 'task',
          recency: o.createdAt,
          relevance: 1,
          relationship_distance: 0,
          verification_status: 'verified' as const,
          selection_reason: 'the task itself',
          estimated_tokens,
        })),
      },
    ],
    staleness: { is_stale: false },
  };
}

/**
 * A tool event as the hooks router records it (the tool name at the payload's top). The router
 * names the session that made the call (`harness_id`); a record older than that names none.
 */
function hookTool(actorId: string, taskId: string, runId: string, tool: string, failed = false, harnessId?: string) {
  state.recordObservation(
    PROJECT,
    { kind: 'harness', id: actorId },
    'agent.event',
    {
      task_id: taskId,
      run_id: runId,
      ...(harnessId ? { harness_id: harnessId } : {}),
      event_type: failed ? 'tool.failed' : 'tool.completed',
      tool,
      summary: tool,
      changed_paths: [],
      error: failed ? 'exit code 1' : null,
    },
    [
      { kind: 'task', id: taskId },
      { kind: 'run', id: runId },
      ...(harnessId ? [{ kind: 'harness' as const, id: harnessId }] : []),
    ],
  );
}

/** A `context.requested` observation as the daemon records it when a request arrives. */
function requested(agentId: string, taskId: string, runId: string, kind: string, harnessId: string) {
  state.recordObservation(
    PROJECT,
    { kind: 'agent', id: agentId },
    'context.requested',
    { task_id: taskId, run_id: runId, kind, harness_id: harnessId, max_chars: 8000 },
    [
      { kind: 'task', id: taskId },
      { kind: 'run', id: runId },
    ],
  );
}

/** The claim of an attached session's attempt, as its host reports it. */
function claim(caller: { harness_id: string; agent_id: string }, taskId: string, runId: string, key: string) {
  state.submitResult(PROJECT, caller, {
    idempotency_key: key,
    task_id: taskId,
    run_id: runId,
    status: 'completed_claim',
    summary: 'done',
    changed_paths: [],
    checks: [],
    notes: [],
    risks: [],
  });
}

/** One verification of a task with one required check, finished as it went. */
function verify(taskId: string, passed: boolean) {
  const { verification_id } = state.startVerification(PROJECT, human, taskId);
  state.recordVerificationCheck(PROJECT, human, verification_id, {
    name: 'tests',
    kind: 'test',
    status: passed ? 'PASSED' : 'FAILED',
    exit_code: passed ? 0 : 1,
    artifact_ref: null,
    summary: passed ? 'ok' : '1 failing',
  });
  state.finishVerification(PROJECT, human, verification_id, passed, passed ? 'passed' : 'tests failed');
}

/** An event as a spawn adapter reports it over `agent.event` (the tool inside `data`). */
function adapterEvent(agentId: string, taskId: string, runId: string, type: string, data: Record<string, unknown>) {
  state.recordObservation(
    PROJECT,
    { kind: 'agent', id: agentId },
    'agent.event',
    { task_id: taskId, run_id: runId, event_type: type, summary: null, data },
    [
      { kind: 'task', id: taskId },
      { kind: 'run', id: runId },
    ],
  );
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof FridayError) return e.code;
    throw e;
  }
  throw new Error('expected an error');
}

describe('the usage row (plan M10a)', () => {
  it('joins an attempt with everything, one whose host said nothing, and one with an old-style report', () => {
    // Attempt A: a spawned host that reports its usage, with packets, tool calls and a verification.
    const t1 = state.createTask(PROJECT, human, { summary: 'Add discount codes', ready: true });
    const fake = register('fake-1', 'dev-1', 'spawn');
    state.assignTask(PROJECT, human, t1.task_id, 'dev-1');
    const [start] = state.pollOutbox(PROJECT, fake.harness_id);
    if (!start) throw new Error('no task.start was queued');
    state.ackOutbox(PROJECT, fake.harness_id, [{ message_id: start.message_id, accepted: true }]);
    const runA = (start.params as { run_id: string }).run_id;
    const agentActor: Actor = { kind: 'agent', id: fake.agent_id };
    // Compiled before the attempt existed: not this attempt's, though for its task and agent.
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({
        agentId: fake.agent_id,
        taskId: t1.task_id,
        createdAt: '2026-10-14T09:59:00.000Z',
        tokens: 100,
        sources: [100],
        purpose: 'preview',
      }),
    );
    // Tied by run: the packet names the attempt.
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({
        agentId: fake.agent_id,
        taskId: t1.task_id,
        runId: runA,
        createdAt: clock.now(),
        tokens: 900,
        chars: 3600,
        sources: [400, 300],
        purpose: 'task_start',
      }),
    );
    clock.advance(1000);
    // Tied by lifetime: no run named, same task and agent, compiled while the attempt ran; it
    // answered a context request for a file.
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({
        agentId: fake.agent_id,
        taskId: t1.task_id,
        createdAt: clock.now(),
        tokens: 500,
        chars: 2000,
        sources: [250],
        purpose: 'request:file',
      }),
    );
    hookTool(fake.harness_id, t1.task_id, runA, 'Read');
    adapterEvent(fake.agent_id, t1.task_id, runA, 'tool.completed', { tool: 'Edit' });
    adapterEvent(fake.agent_id, t1.task_id, runA, 'tool.completed', { tool: 'commandExecution' });
    hookTool(fake.harness_id, t1.task_id, runA, 'Bash', true);
    adapterEvent(fake.agent_id, t1.task_id, runA, 'tool.completed', { tool: 'WebFetch' });
    adapterEvent(fake.agent_id, t1.task_id, runA, 'tool.completed', { tool: 'mcp__friday__context_request' });
    adapterEvent(fake.agent_id, t1.task_id, runA, 'tool.completed', { tool: 'Task' });
    adapterEvent(fake.agent_id, t1.task_id, runA, 'progress', { note: 'not a tool call' });
    // An early partial report, then the final one: the last report counts.
    adapterEvent(fake.agent_id, t1.task_id, runA, 'host.usage', {
      cost_usd: 0.002,
      input_tokens: 300,
      output_tokens: 20,
    });
    adapterEvent(fake.agent_id, t1.task_id, runA, 'host.usage', {
      cost_usd: 0.0123,
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
      turns: 3,
      model: 'claude-haiku-5-5',
    });
    clock.advance(4000);
    state.submitResult(
      PROJECT,
      { harness_id: fake.harness_id, agent_id: fake.agent_id },
      {
        idempotency_key: 'claim-a',
        task_id: t1.task_id,
        run_id: runA,
        status: 'completed_claim',
        summary: 'done',
        changed_paths: [],
        checks: [],
        notes: [],
        risks: [],
      },
    );
    const { verification_id } = state.startVerification(PROJECT, human, t1.task_id);
    state.recordVerificationCheck(PROJECT, human, verification_id, {
      name: 'tests',
      kind: 'test',
      status: 'PASSED',
      exit_code: 0,
      artifact_ref: null,
      summary: 'ok',
    });
    state.recordVerificationCheck(PROJECT, human, verification_id, {
      name: 'lint',
      kind: 'lint',
      status: 'FAILED',
      exit_code: 1,
      artifact_ref: null,
      summary: 'advisory',
      required: false,
    });
    state.finishVerification(PROJECT, human, verification_id, true, '1/1 required checks passed');

    // Attempt B: an attached session whose host never reports anything.
    const t2 = state.createTask(PROJECT, human, { summary: 'Document the checkout', assign_agent_key: 'dev-2' });
    const cc1 = register('cc-1', 'dev-2', 'attach');
    const runB = state.claimTask(
      PROJECT,
      { harness_id: cc1.harness_id, agent_id: cc1.agent_id },
      { task_id: t2.task_id },
    );

    // Attempt C: a host whose report predates the cache keys, and a recorded context request.
    const t3 = state.createTask(PROJECT, human, { summary: 'Tidy the docs', assign_agent_key: 'dev-3' });
    const cc2 = register('cc-2', 'dev-3', 'attach');
    const runC = state.claimTask(
      PROJECT,
      { harness_id: cc2.harness_id, agent_id: cc2.agent_id },
      { task_id: t3.task_id },
    );
    adapterEvent(cc2.agent_id, t3.task_id, runC.run_id, 'host.usage', {
      cost_usd: 0.01,
      input_tokens: 100,
      output_tokens: 10,
      turns: 1,
    });
    state.recordObservation(
      PROJECT,
      { kind: 'agent', id: cc2.agent_id },
      'context.requested',
      { task_id: t3.task_id, run_id: runC.run_id, kind: 'symbol' },
      [{ kind: 'run', id: runC.run_id }],
    );

    const report = state.q.usageReport(PROJECT);
    expect(report.rows.map((r) => r.run_id)).toEqual([runA, runB.run_id, runC.run_id]);
    expect(report).toMatchObject({ truncated: false, limit: 500 });

    const a = report.rows[0];
    const endedA = state.q.run(runA).ended_at;
    expect(a).toMatchObject({
      task_id: t1.task_id,
      task_summary: 'Add discount codes',
      goal_id: null,
      attempt: 1,
      agent_key: 'dev-1',
      harness_vendor: 'generic',
      harness_mode: 'spawn',
      packets: { count: 2, tokens: 1400, chars: 5600, source_tokens: 950 },
      context_requests: { count: 1, kinds: { file: 1 } },
      host: {
        reported: true,
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        cost_usd: 0.0123,
        turns: 3,
        model: 'claude-haiku-5-5',
      },
      tool_calls: { total: 7, failed: 1, by_kind: { read: 1, edit: 1, shell: 2, web: 1, friday: 1, other: 1 } },
      verification: { status: 'PASSED', checks_passed: 1, checks_total: 2 },
      started_at: '2026-10-14T10:00:00.000Z',
      ended_at: endedA,
    });
    expect(a?.duration_ms).toBe(endedA ? Date.parse(endedA) - Date.parse('2026-10-14T10:00:00.000Z') : null);

    expect(report.rows[1]).toMatchObject({
      task_id: t2.task_id,
      agent_key: 'dev-2',
      harness_vendor: 'claude-code',
      harness_mode: 'attach',
      packets: { count: 0, tokens: 0, chars: null, source_tokens: 0 },
      context_requests: { count: 0, kinds: {} },
      host: {
        reported: false,
        input_tokens: null,
        output_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cost_usd: null,
        turns: null,
        model: null,
      },
      tool_calls: { total: 0, failed: 0, by_kind: { read: 0, edit: 0, shell: 0, web: 0, friday: 0, other: 0 } },
      verification: null,
      ended_at: null,
      duration_ms: null,
    });

    expect(report.rows[2]).toMatchObject({
      task_id: t3.task_id,
      context_requests: { count: 1, kinds: { symbol: 1 } },
      host: {
        reported: true,
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cost_usd: 0.01,
        turns: 1,
        model: null,
      },
    });

    // Totals sum only what was reported, say how many attempts reported at all, and, per total, how
    // many it sums: the cache figures come from one attempt, the token counts from two.
    expect(report.totals).toEqual({
      attempts: 3,
      host_reported: 2,
      reporters: {
        input_tokens: 2,
        output_tokens: 2,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 1,
        cost_usd: 2,
      },
      input_tokens: 1300,
      output_tokens: 90,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
      cost_usd: 0.0223,
      tool_calls: 7,
    });

    // Filters, and the bound on an unfiltered report.
    expect(state.q.usageReport(PROJECT, { taskId: t1.task_id }).rows.map((r) => r.run_id)).toEqual([runA]);
    expect(code(() => state.q.usageReport(PROJECT, { taskId: 'task_00000000000000000000000000' }))).toBe('COS-2001');
    expect(code(() => state.q.usageReport(PROJECT, { goalId: 'goal_00000000000000000000000000' }))).toBe('COS-2006');
    const cut = state.q.usageReport(PROJECT, { limit: 2 });
    expect(cut.rows.map((r) => r.run_id)).toEqual([runB.run_id, runC.run_id]);
    expect(cut).toMatchObject({ truncated: true, limit: 2 });
    expect(cut.totals).toMatchObject({
      attempts: 2,
      host_reported: 1,
      input_tokens: 100,
      cache_read_input_tokens: null,
    });
  });

  it('counts nothing a second live session of the same agent (a shadow) did or was given', () => {
    const t = state.createTask(PROJECT, human, { summary: 'Ship the cart', assign_agent_key: 'dev-5' });
    const first = register('cc-5', 'dev-5', 'attach');
    const run = state.claimTask(
      PROJECT,
      { harness_id: first.harness_id, agent_id: first.agent_id },
      { task_id: t.task_id },
    );
    // A second window opened with the same agent key while the first session is live: Friday
    // registers it as a shadow of the same agent, which resolves to the same held task.
    const second = register('cc-5b', 'dev-5', 'attach');
    expect(second).toMatchObject({ shadow: true, agent_id: first.agent_id });
    const agentActor: Actor = { kind: 'agent', id: first.agent_id };
    clock.advance(1000);
    const during = { agentId: first.agent_id, taskId: t.task_id, createdAt: clock.now(), purpose: 'session_startup' };
    // The shadow's own packet at its start, for the attempt's task and agent, while the attempt runs.
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({ ...during, harnessId: second.harness_id, tokens: 700, sources: [700] }),
    );
    // The attempt's own, and one that names no session (a record older than that field).
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({ ...during, harnessId: first.harness_id, tokens: 300, sources: [300] }),
    );
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({ ...during, tokens: 50, sources: [50], purpose: 'request:file' }),
    );
    // Tool calls the hooks recorded with the attempt's run: the shadow's reads, the attempt's own
    // edit, and an older record that names no session.
    hookTool(second.harness_id, t.task_id, run.run_id, 'Read', false, second.harness_id);
    hookTool(second.harness_id, t.task_id, run.run_id, 'Grep', false, second.harness_id);
    hookTool(first.harness_id, t.task_id, run.run_id, 'Edit', false, first.harness_id);
    hookTool(first.harness_id, t.task_id, run.run_id, 'Bash', true);
    // A request each session made.
    requested(first.agent_id, t.task_id, run.run_id, 'file', second.harness_id);
    requested(first.agent_id, t.task_id, run.run_id, 'symbol', first.harness_id);

    const [row] = state.q.usageReport(PROJECT, { taskId: t.task_id }).rows;
    expect(row).toMatchObject({
      run_id: run.run_id,
      packets: { count: 2, tokens: 350, chars: null, source_tokens: 350 },
      context_requests: { count: 1, kinds: { symbol: 1 } },
      tool_calls: { total: 2, failed: 1, by_kind: { read: 0, edit: 1, shell: 1, web: 0, friday: 0, other: 0 } },
    });
  });

  it('keeps two attempts of one task apart: a boundary packet goes to the earlier one, once; no attempt shows another’s verdict', () => {
    const t = state.createTask(PROJECT, human, { summary: 'Fix the cart total', assign_agent_key: 'dev-6' });
    const cc = register('cc-6', 'dev-6', 'attach');
    const caller = { harness_id: cc.harness_id, agent_id: cc.agent_id };
    const agentActor: Actor = { kind: 'agent', id: cc.agent_id };
    const own = { agentId: cc.agent_id, taskId: t.task_id, harnessId: cc.harness_id, purpose: 'session_startup' };

    // Attempt 1: a packet and a read while it runs, a claim, and a verification that fails.
    const first = state.claimTask(PROJECT, caller, { task_id: t.task_id });
    clock.advance(1000);
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({ ...own, createdAt: clock.now(), tokens: 400, sources: [400] }),
    );
    hookTool(cc.harness_id, t.task_id, first.run_id, 'Read', false, cc.harness_id);
    clock.advance(1000);
    claim(caller, t.task_id, first.run_id, 'claim-1');
    verify(t.task_id, false);
    const endedFirst = state.q.run(first.run_id).ended_at;
    expect(endedFirst).toBe(clock.now());

    // Reworked and taken again by the same agent in the same second the first attempt ended.
    state.reworkTask(PROJECT, human, t.task_id, 'fix the failing test');
    const second = state.claimTask(PROJECT, caller, { task_id: t.task_id });
    expect(second.attempt).toBe(2);
    expect(state.q.run(second.run_id).created_at).toBe(endedFirst);
    // A packet at the boundary: both attempts' windows hold it, and the earlier one takes it.
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({ ...own, createdAt: clock.now(), tokens: 100, sources: [100] }),
    );
    clock.advance(1000);
    // Attempt 2's own packet and edit, its claim, and a verification that passes.
    state.recordContextPacket(
      PROJECT,
      agentActor,
      packet({ ...own, createdAt: clock.now(), tokens: 250, sources: [250] }),
    );
    hookTool(cc.harness_id, t.task_id, second.run_id, 'Edit', false, cc.harness_id);
    clock.advance(1000);
    claim(caller, t.task_id, second.run_id, 'claim-2');
    verify(t.task_id, true);

    const report = state.q.usageReport(PROJECT, { taskId: t.task_id });
    expect(report.rows.map((r) => [r.run_id, r.attempt])).toEqual([
      [first.run_id, 1],
      [second.run_id, 2],
    ]);
    expect(report.rows[0]).toMatchObject({
      packets: { count: 2, tokens: 500, source_tokens: 500 },
      tool_calls: { total: 1, by_kind: { read: 1, edit: 0 } },
      verification: { status: 'FAILED', checks_passed: 0, checks_total: 1 },
      ended_at: endedFirst,
    });
    expect(report.rows[1]).toMatchObject({
      packets: { count: 1, tokens: 250, source_tokens: 250 },
      tool_calls: { total: 1, by_kind: { read: 0, edit: 1 } },
      verification: { status: 'PASSED', checks_passed: 1, checks_total: 1 },
      started_at: endedFirst,
    });
    // Every packet recorded is counted exactly once.
    expect(report.rows.reduce((n, r) => n + r.packets.count, 0)).toBe(3);
    expect(report.rows[1]?.ended_at).toBe(clock.now());
  });

  it('groups tool names by what the tool does, whichever host named them', () => {
    expect(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].map(toolKind)).toEqual(Array(5).fill('read'));
    expect(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'fileChange'].map(toolKind)).toEqual(Array(5).fill('edit'));
    expect(['Bash', 'PowerShell', 'commandExecution'].map(toolKind)).toEqual(Array(3).fill('shell'));
    expect(['WebFetch', 'WebSearch'].map(toolKind)).toEqual(['web', 'web']);
    expect(toolKind('mcp__friday__context_request')).toBe('friday');
    expect(['Task', 'mcp__other__thing', '', null, undefined].map(toolKind)).toEqual(Array(5).fill('other'));
  });
});
