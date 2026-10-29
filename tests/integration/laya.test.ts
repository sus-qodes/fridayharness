/**
 * Laya in routing (plan M7c, ADR-0031 §10; spec Part 12 §10): asked when a task becomes READY,
 * advisory until calibrated, deciding once its calibrated confidence passes, and never in the way
 * when it is down. Laya itself is a stand-in serving its HTTP contract.
 */
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import type { RoutingDecisionView, TaskStartParams, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
let saved: string | undefined;
let server: Server | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(async () => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** `laya-serve` answering every routing question with one choice. */
async function fakeLaya(choice: string, confidence: number) {
  const seen: { criteria: string[] }[] = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const q = (JSON.parse(body) as { questions: { route: { criteria: Record<string, string> } } }).questions.route;
      seen.push({ criteria: Object.keys(q.criteria) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'typed-decisions',
          answers: { route: { type: 'choice', choice, answer_confidence: confidence } },
        }),
      );
    });
  });
  const s = server;
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, seen };
}

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  const end = Date.now() + 20_000;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A READY task, its stored Laya answer awaited, then assigned to the spawn agent. */
async function routed(td: TestDaemon, fake: FakeHarness, summary: string, waitForAnswer = true) {
  const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary,
    kind: 'implementation',
    scope: { write: ['src/**'], read: [] },
    ready: true,
  });
  if (waitForAnswer) {
    await eventually(() => td.daemon.state.q.layaAnswer(td.project.project_id, t.task_id), Boolean, 'the Laya answer');
  }
  await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'spawned' });
  const start = (await fake.waitFor('task.start', 30_000, (m) => (m.params as TaskStartParams).task_id === t.task_id))
    .params as TaskStartParams;
  const [decision] = (
    await td.operator.get<{ decisions: RoutingDecisionView[] }>(td.operator.projectPath('/routing/decisions'), {
      query: { task: t.task_id },
    })
  ).decisions;
  // Let the next task find the agent free again.
  await fake.client.call('task.release', { task_id: t.task_id, run_id: start.run_id, reason: 'handoff', note: 'next' });
  return { task: t, start, decision: decision as RoutingDecisionView };
}

describe('Laya in routing', () => {
  it('stays advisory until calibrated, decides when its calibrated confidence passes, and is no obstacle when down', async () => {
    const laya = await fakeLaya('claude-sonnet-5-5', 0.93);
    const td = await startTestDaemon(ws(), {
      git: true,
      extraConfig: `routing:\n  laya:\n    enabled: true\n    url: ${laya.url}\n    timeout_ms: 2000\n`,
    });
    const fake = await FakeHarness.connect(td, {
      agentKey: 'spawned',
      capabilities: { task_start: true, model_control: 'set', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
    });

    // Uncalibrated: Laya's confidence is not a probability yet, so the score decides.
    const first = await routed(td, fake, 'Fix a difficult TypeScript generic inference bug');
    expect(laya.seen[0]?.criteria).toEqual([
      'claude-fable-5-1',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'gpt-5.6-luna',
    ]);
    expect(first.decision.reason_codes).toContain('laya.uncalibrated');
    expect(first.start.model).toBe('claude-opus-5-5');

    // Calibrated on labelled answers for this checkpoint and option count: Laya decides.
    const file = path.join(ws().root, 'labelled.jsonl');
    writeFileSync(
      file,
      `${Array.from({ length: 25 }, () => JSON.stringify({ checkpoint: 'typed-decisions', options: 5, confidence: 0.9, correct: true })).join('\n')}\n`,
    );
    const fitted = await cli(['--project', ws().projectDir, 'laya', 'calibrate', file]);
    expect(fitted.code, fitted.stderr).toBe(0);
    expect(fitted.stdout).toContain('typed-decisions choice:5: threshold 0.9 (100% accurate at 100% coverage of 25)');
    const second = await routed(td, fake, 'Fix another generic inference bug');
    expect(second.decision).toMatchObject({ source: 'laya', model: 'claude-sonnet-5-5', confidence: 0.93 });
    expect(second.start).toMatchObject({ model: 'claude-sonnet-5-5', model_binding: true });

    // Laya down: recorded, and routing goes on without it. (Keep-alive sockets would still reach it.)
    server?.closeAllConnections();
    await new Promise<void>((r) => server?.close(() => r()));
    server = undefined;
    const third = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Fix a third bug',
      kind: 'implementation',
      scope: { write: ['src/**'], read: [] },
      ready: true,
    });
    await eventually(
      () =>
        td.daemon.state.store.readByRef(td.project.project_id, 'task', third.task_id, { types: ['laya.unavailable'] }),
      (e) => e.length > 0,
      'laya.unavailable',
    );
    await td.operator.post(td.operator.projectPath(`/tasks/${third.task_id}/assign`), { agent_key: 'spawned' });
    const start = (
      await fake.waitFor('task.start', 30_000, (m) => (m.params as TaskStartParams).task_id === third.task_id)
    ).params as TaskStartParams;
    expect(start.model).toBe('claude-opus-5-5');
    const status = await cli(['--project', ws().projectDir, 'laya', 'status']);
    expect(status.stdout).toContain(`Laya is enabled at ${laya.url}`);
  }, 120_000);
});
