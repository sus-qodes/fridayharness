/**
 * The vendor-neutral conformance suite (M3.5) against the Codex adapter (ADR-0032), its host a
 * scripted app-server that speaks the recorded protocol. Its work is a real process an approved
 * command started, so case 9 proves cancellation stops it, not only the task's status.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAdapter } from '@friday/adapter-codex';
import type { OutboundMessage } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { type ConformanceHarness, runHarnessConformance } from './harness-conformance.js';

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

class CodexSubject implements ConformanceHarness {
  constructor(
    readonly adapter: CodexAdapter,
    private readonly td: TestDaemon,
    private readonly work: string,
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
}

runHarnessConformance('Codex adapter (scripted app-server)', async () => {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), { clock });
  const dir = path.join(ws().root, 'codex');
  mkdirSync(dir, { recursive: true });
  const scriptFile = path.join(dir, 'script.json');
  writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const work = path.join(dir, 'work');
  return {
    td,
    clock,
    attach: async (opts = {}) => {
      counter += 1;
      const adapter = new CodexAdapter({
        bootstrap: td.bootstrap,
        projectId: td.project.project_id,
        agentKey: opts.agentKey ?? 'dev-1',
        harnessKey: opts.key ?? `codex:conformance:${process.pid}:${counter}`,
        host: { command: process.execPath, args: [FAKE], version: '0.162.1' },
        hostEnv: {
          ...process.env,
          FAKE_CODEX_SCRIPT: scriptFile,
          FAKE_CODEX_LOG: path.join(dir, `log-${counter}.jsonl`),
          FAKE_CODEX_WORK: work,
        },
        sandbox: 'workspace-write',
      });
      await adapter.start();
      ws().track({ close: () => adapter.close() });
      return new CodexSubject(adapter, td, work);
    },
  };
});
