/**
 * The vendor-neutral conformance suite (M3.5) against the Codex adapter (ADR-0032), its host a
 * scripted app-server that speaks the recorded protocol. Its work is a real process an approved
 * command started, so case 9 proves cancellation stops it, not only the task's status. After the
 * 11 cases: the token baseline's row for a Codex attempt (plan M11.4).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '@friday/adapter-codex';
import type { OutboundMessage, TaskStartParams, TaskView, UsageReport } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { type ConformanceHarness, type ConformanceSubject, runHarnessConformance } from './harness-conformance.js';

const ws = useTestWorkspace();
const FAKE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'codex',
  'fake-app-server.mjs',
);
let counter = 0;

/** Each turn starts a long command Friday allows, which works until something stops it. */
const SCRIPT = {
  turns: [[{ op: 'command', command: 'node --test', long: true }]],
  resume: [{ op: 'command', command: 'node --test', long: true }],
};

/** A turn that answers and finishes: two model responses, which the host counts. */
const FINISHING = {
  turns: [
    [
      { op: 'message', text: 'reading the task' },
      { op: 'final', status: 'completed', summary: 'done', changed_paths: [] },
    ],
  ],
};

class CodexSubject implements ConformanceHarness {
  constructor(
    readonly adapter: CodexAdapter,
    private readonly td: TestDaemon,
    private readonly work: string,
    private readonly log: string,
  ) {}
  get harnessId() {
    return this.adapter.harnessId;
  }
  get token() {
    return this.adapter.registration.harness_token;
  }
  get client() {
    return this.adapter.client;
  }
  async waitFor(method: OutboundMessage['method'], timeoutMs = 5000): Promise<OutboundMessage> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.adapter.received.find((m) => m.method === method);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`the Codex adapter got no ${method} within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  crash() {
    return this.adapter.crash();
  }
  reconnect() {
    return this.adapter.reconnect();
  }
  async rawRpc(method: string, params: unknown, token: string = this.token) {
    const res = await fetch(`${this.td.url}/protocol/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'raw-1', method, params }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  workDone(taskId: string): number {
    const f = path.join(this.work, `${taskId}.work`);
    return existsSync(f) ? statSync(f).size : 0;
  }
  /** What the scripted host logged: the client's requests, its own answers, the token counts it sent. */
  entries(): Record<string, unknown>[] {
    return existsSync(this.log)
      ? readFileSync(this.log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  }
}

/** The conformance subject whose harnesses are Codex adapters, each with its scripted host's log. */
interface CodexConformanceSubject extends Omit<ConformanceSubject, 'attach'> {
  attach(opts?: { key?: string; agentKey?: string }): Promise<CodexSubject>;
}

/** A daemon, and a way to attach Codex adapters whose scripted hosts play `script`. */
async function subject(script: unknown): Promise<CodexConformanceSubject> {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), { clock });
  const dir = path.join(ws().root, 'codex');
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(script));
  const work = path.join(dir, 'work');
  return {
    td,
    clock,
    attach: async (opts = {}) => {
      counter += 1;
      const log = path.join(dir, `log-${counter}.jsonl`);
      const adapter = new CodexAdapter({
        bootstrap: td.bootstrap,
        projectId: td.project.project_id,
        agentKey: opts.agentKey ?? 'dev-1',
        harnessKey: opts.key ?? `codex:conformance:${process.pid}:${counter}`,
        host: { command: process.execPath, args: [FAKE], version: '0.162.1' },
        hostEnv: {
          ...process.env,
          FAKE_CODEX_SCRIPT: scriptFile,
          FAKE_CODEX_LOG: log,
          FAKE_CODEX_WORK: work,
        },
        sandbox: 'workspace-write',
        // FRIDAY_TEST_DEBUG=1 shows what the adapter saw and said.
        ...(process.env.FRIDAY_TEST_DEBUG
          ? {
              log: (m: string) => console.error(`[codex ${counter}] ${m}`),
              trace: (d: 'send' | 'receive', line: string) =>
                console.error(`[codex ${counter}] ${d} ${line.slice(0, 300)}`),
            }
          : {}),
      });
      await adapter.start();
      ws().track({ close: () => adapter.close() });
      return new CodexSubject(adapter, td, work, log);
    },
  };
}

runHarnessConformance('Codex adapter (scripted app-server)', () => subject(SCRIPT));

describe('harness conformance: Codex adapter (scripted app-server), the usage row (plan M11.4)', () => {
  it('shows a complete row for a finished attempt: every count the host sent, the turn and the model', async () => {
    const s = await subject(FINISHING);
    const h = await s.attach();
    const t = await s.td.operator.post<TaskView>(s.td.operator.projectPath('/tasks'), {
      summary: 'conformance task',
      ready: true,
    });
    await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'dev-1' });
    const start = (await h.waitFor('task.start')).params as TaskStartParams;
    // Well under the suite's 90 s: the turn is quick, but a full parallel run slows everything (LESSONS T-63).
    const deadline = Date.now() + 60_000;
    for (;;) {
      const { task } = await s.td.operator.get<{ task: TaskView }>(s.td.operator.projectPath(`/tasks/${t.task_id}`));
      if (task.status === 'READY_FOR_VERIFICATION') break;
      if (Date.now() > deadline) {
        const { events } = await s.td.operator.get<{ events: { type: string; payload: Record<string, unknown> }[] }>(
          s.td.operator.projectPath(`/tasks/${t.task_id}/events`),
        );
        const seen = events.map(
          (e) => `${e.type}${e.type === 'agent.event' ? `(${String(e.payload.event_type)})` : ''}`,
        );
        throw new Error(`no claim within 60 s: the task is ${task.status} after ${seen.join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    // The host counted two model responses, the last before the turn ended; its `total` is the
    // thread's count, in which the input holds the whole prompt, the cached part included.
    const counts = h.entries().filter((e) => e.tokenUsage);
    expect(counts).toHaveLength(2);
    expect(counts.at(-1)?.tokenUsage).toEqual({
      totalTokens: 20710,
      inputTokens: 20600,
      cachedInputTokens: 9984,
      cacheWriteInputTokens: 1024,
      outputTokens: 110,
      reasoningOutputTokens: 15,
    });
    // The attempt's row, through the daemon: that last count, field by field, the turn the adapter
    // ran, the model the thread reported (the one Friday routed the run to, else the host's own),
    // and no cost, which the app-server does not name.
    const report = await s.td.operator.get<UsageReport>(s.td.operator.projectPath(`/usage?task=${t.task_id}`));
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row).toMatchObject({
      run_id: start.run_id,
      harness_vendor: 'codex',
      harness_mode: 'spawn',
      host: {
        reported: true,
        input_tokens: 20600,
        output_tokens: 110,
        cache_read_input_tokens: 9984,
        cache_creation_input_tokens: 1024,
        cost_usd: null,
        turns: 1,
        model: start.model ?? 'gpt-fake',
      },
    });
    // None of what the host counts is unknown; only the cost is, which it does not name.
    for (const k of [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ] as const) {
      expect(row?.host[k], k).not.toBeNull();
    }
    expect(report.totals).toMatchObject({
      attempts: 1,
      host_reported: 1,
      input_tokens: 20600,
      output_tokens: 110,
      cache_read_input_tokens: 9984,
      cache_creation_input_tokens: 1024,
      cost_usd: null,
    });
  });
});
