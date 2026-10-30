/**
 * The vendor-neutral conformance suite (M3.5) against the OpenCode worker (plan M14.4), its host a
 * scripted OpenCode server whose session keeps calling a tool Friday allows until something stops
 * it, so case 9 proves cancellation stops the work, not only the task's status. No model is called.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenCodeWorker } from '@friday/adapter-opencode';
import type { OutboundMessage } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { type ConformanceHarness, type ConformanceSubject, runHarnessConformance } from './harness-conformance.js';

const ws = useTestWorkspace();
const FAKE = fileURLToPath(new URL('../fixtures/opencode/fake-opencode.mjs', import.meta.url));
let counter = 0;

/** Every prompt: the session writes inside the project, again and again, until it is stopped. */
const BUSY = [{ loop: { tool: 'write', args: { filePath: 'src/work.ts', content: 'work\n' }, everyMs: 40 } }];

function dependencies(root: string): string {
  const dir = path.join(root, 'deps');
  mkdirSync(path.join(dir, 'node_modules/@opencode-ai/plugin'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.19.3' } }));
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@opencode-ai/plugin': '1.19.3' } },
        'node_modules/@opencode-ai/plugin': { version: '1.19.3' },
      },
    }),
  );
  writeFileSync(path.join(dir, 'node_modules/@opencode-ai/plugin/package.json'), '{"version":"1.19.3"}');
  return dir;
}

class OpenCodeSubject implements ConformanceHarness {
  constructor(
    readonly worker: OpenCodeWorker,
    private readonly td: TestDaemon,
    private readonly log: string,
  ) {}
  get harnessId() {
    return this.worker.harnessId;
  }
  get token() {
    return this.worker.client.registration.harness_token;
  }
  get client() {
    return this.worker.client;
  }
  async waitFor(method: OutboundMessage['method'], timeoutMs = 5000): Promise<OutboundMessage> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.worker.received.find((m) => m.method === method);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`the OpenCode worker got no ${method} within ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  crash() {
    return this.worker.crash();
  }
  reconnect() {
    return this.worker.reconnect();
  }
  async rawRpc(method: string, params: unknown, token: string = this.token) {
    const res = await fetch(`${this.td.url}/protocol/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'raw-1', method, params }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  /** The tool calls the scripted sessions made: they grow while a session works. */
  workDone(_taskId: string): number {
    return existsSync(this.log)
      ? readFileSync(this.log, 'utf8')
          .split('\n')
          .filter((l) => l.includes('"op":"tool"')).length
      : 0;
  }
}

async function subject(): Promise<ConformanceSubject> {
  const clock = new FakeClock(new Date().toISOString());
  const td = await startTestDaemon(ws(), { clock });
  const dir = path.join(ws().root, 'opencode');
  mkdirSync(dir, { recursive: true });
  const deps = dependencies(dir);
  return {
    td,
    clock,
    attach: async (opts = {}) => {
      counter += 1;
      const log = path.join(dir, `log-${counter}.jsonl`);
      const fixture = path.join(dir, `fixture-${counter}.json`);
      writeFileSync(fixture, JSON.stringify({ log, prompts: [BUSY] }));
      const worker = new OpenCodeWorker({
        bootstrap: td.bootstrap,
        projectId: td.project.project_id,
        agentKey: opts.agentKey ?? 'dev-1',
        harnessKey: opts.key ?? `opencode:conformance:${process.pid}:${counter}`,
        host: { command: process.execPath, args: [FAKE, '--fixture', fixture] },
        dependenciesDir: deps,
        inference: { baseURL: 'http://127.0.0.1:9/v1', model: 'qwen-fake' },
        workDir: dir,
        hostEnv: { ...process.env },
        ...(process.env.FRIDAY_TEST_DEBUG ? { log: (m: string) => console.error(`[opencode ${counter}] ${m}`) } : {}),
      });
      await worker.start();
      ws().track({ close: () => worker.close() });
      return new OpenCodeSubject(worker, td, log);
    },
  };
}

runHarnessConformance('OpenCode worker (scripted server, plan M14.4)', subject);
