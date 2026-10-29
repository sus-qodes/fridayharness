/**
 * Backup, restore and restart as an operator does them (M3.1, review R08): a backup taken while
 * sessions work and a model call is in flight is restored into another clone of the project.
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import path from 'node:path';
import { createDaemon, type Daemon } from '@friday/daemon';
import type { Actor } from '@friday/protocol';
import { DaemonClient, renderInitialConfig } from '@friday/sdk';
import { FakeClock, type TestWorkspace, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { initTestProject, TEST_PROJECT_ID, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const human: Actor = { kind: 'human', id: 'local-operator' };
const PLAN = (
  JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'planner', 'stripe-subscriptions', '01-plan.json'), 'utf8'),
  ) as { output: unknown }
).output;

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['FRIDAY_STATE_DIR', 'ANTHROPIC_API_KEY', 'FRIDAY_TEST_ANTHROPIC_KEY']) saved[k] = process.env[k];
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** A stand-in for the Messages API that holds each request open until released. */
async function heldApi(w: TestWorkspace): Promise<{ url: string; seen: number; release: () => void }> {
  const held: ServerResponse[] = [];
  const api: { url: string; seen: number; release: () => void } = { url: '', seen: 0, release: () => {} };
  const answer = (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_held' });
    res.end(
      JSON.stringify({
        id: 'msg_held',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify(PLAN) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }),
    );
  };
  let released = false;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      api.seen += 1;
      if (released) answer(res);
      else held.push(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.track({ close: () => new Promise<void>((r) => server.close(() => r())) });
  api.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  api.release = () => {
    released = true;
    for (const res of held.splice(0)) answer(res);
  };
  return api;
}

function writeProject(root: string): void {
  mkdirSync(path.join(root, '.friday'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# shop\n');
  writeFileSync(
    path.join(root, '.friday', 'config.yaml'),
    renderInitialConfig(TEST_PROJECT_ID, 'test-project').replace('allow_remote: false', 'allow_remote: true'),
  );
}

function asTest(d: Daemon, w: TestWorkspace): TestDaemon {
  const base = { baseUrl: d.url, projectId: d.project.project_id };
  return {
    daemon: d,
    url: d.url,
    project: d.project,
    operator: new DaemonClient({ ...base, token: d.tokens.operator, tokenClass: 'operator' }),
    bootstrap: new DaemonClient({ ...base, token: d.tokens.bootstrap, tokenClass: 'bootstrap' }),
    ws: w,
  };
}

async function until(ok: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('restore and restart (R08)', () => {
  it('restores into another clone: sessions register again, waiting work is recovered, and an interrupted model call is not repeated without approval there', async () => {
    const api = await heldApi(ws());
    const cloneA = ws().projectDir;
    initTestProject(ws());
    writeProject(cloneA);
    const a = await createDaemon({
      projectRoot: cloneA,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
      brain: { autoStart: false },
    });
    ws().track({ close: () => a.close('test cleanup') });
    const pid = a.project.project_id;
    const tdA = asTest(a, ws());

    // Clone A works: one running task, one assignment its session never picked up, a request
    // the backend session has read but not answered, and planning allowed on this clone.
    const be = await FakeHarness.connect(tdA, { agentKey: 'be-1', key: 'fake:be-1', role: 'backend' });
    const fe = await FakeHarness.connect(tdA, { agentKey: 'fe-1', key: 'fake:fe-1', role: 'frontend', loop: false });
    const api1 = a.state.createTask(pid, human, {
      summary: 'api',
      scope: { write: ['backend/**'], read: [] },
      ready: true,
    });
    a.state.assignTask(pid, human, api1.task_id, 'be-1');
    await until(() => a.state.q.task(pid, api1.task_id).status === 'RUNNING', 'the backend task to run');
    const page = a.state.createTask(pid, human, {
      summary: 'page',
      scope: { write: ['frontend/**'], read: [] },
      ready: true,
    });
    a.state.assignTask(pid, human, page.task_id, 'fe-1');
    const ask = a.state.sendMessage(
      pid,
      { kind: 'human', actor: human },
      {
        to: 'be-1',
        mode: 'request',
        content: 'Is the schema final?',
        blocking: true,
      },
    );
    const read = await be.rawRpc('message.inbox', { protocol_version: '1.0' });
    expect(JSON.stringify(read.body)).toContain(ask.message_id);
    process.env.FRIDAY_TEST_ANTHROPIC_KEY = `sk-ant-api03-${'Rs4'.repeat(30)}`;
    for (const args of [
      ['secrets', 'set', 'anthropic', '--from-env', 'FRIDAY_TEST_ANTHROPIC_KEY', '--base-url', api.url],
      ['--project', cloneA, 'brain', 'allow-remote', '--budget', '3'],
      ['--project', cloneA, 'goal', 'create', 'Add Stripe subscriptions, keep one-time checkout working', '--no-wait'],
    ]) {
      const r = await cli(args);
      expect(r.code, r.stderr).toBe(0);
    }

    // The planning call is in flight when the backup is taken.
    const planning = tdA.operator.post(tdA.operator.projectPath('/brain/run-once'), {}, { timeoutMs: 60_000 });
    await until(() => a.state.brainJobs(pid, ['calling']).length === 1, 'the planning call');
    const backup = path.join(ws().root, 'backup');
    const made = await tdA.operator.post<{ event_head: number }>('/admin/backup', { into: backup });
    expect(made.event_head).toBeGreaterThan(0);
    api.release();
    await planning;
    expect(api.seen).toBe(1);

    // Restoring over a running Friday is refused, and so is a backup of another project.
    const busy = await cli(['--project', cloneA, 'restore', '--from', backup]);
    expect(busy.code).toBe(4);
    expect(busy.stderr).toContain('Friday is running');
    const foreign = path.join(ws().root, 'foreign');
    cpSync(backup, foreign, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(foreign, 'manifest.json'), 'utf8'));
    writeFileSync(path.join(foreign, 'manifest.json'), JSON.stringify({ ...manifest, project_id: 'proj_other' }));
    const cloneB = path.join(ws().root, 'clone-b');
    writeProject(cloneB);
    const wrong = await cli(['--project', cloneB, 'restore', '--from', foreign]);
    expect(wrong.stderr).toContain('belongs to project proj_other');

    await be.crash();
    await fe.crash();
    await a.close();

    // Clone B, same user, never approved for remote planning.
    const restored = await cli(['--project', cloneB, 'restore', '--from', backup]);
    expect(restored.code, restored.stderr).toBe(0);
    expect(restored.stdout).toContain('There was no state to replace');
    const clock = new FakeClock(new Date().toISOString());
    const b = await createDaemon({
      projectRoot: cloneB,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
      clock,
      brain: { autoStart: false },
    });
    ws().track({ close: () => b.close('test cleanup') });
    const tdB = asTest(b, ws());
    expect(b.state.brainJobs(pid, ['calling'])).toHaveLength(1);

    // The backup carries no credential: the old session token does not work here.
    const stale = await fetch(`${b.url}/protocol/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'harness.heartbeat',
        params: { protocol_version: '1.0' },
      }),
    });
    expect(stale.status).toBe(401);

    // The backend session registers again within its lease: its task and its unread request wait for it.
    const be2 = await FakeHarness.connect(tdB, { agentKey: 'be-1', key: 'fake:be-1', role: 'backend', loop: false });
    expect(b.state.q.task(pid, api1.task_id)).toMatchObject({ status: 'RUNNING' });
    const again = await be2.rawRpc('message.inbox', { protocol_version: '1.0' });
    expect(JSON.stringify(again.body)).toContain(ask.message_id);

    // The frontend session never comes back: after one lease it is lost, as after a crash.
    clock.advance(b.state.config.leaseTtlMs + 1_000);
    await be2.client.heartbeat();
    const tick = b.tick();
    expect(tick.lost).toEqual([fe.harnessId]);
    expect(b.state.q.task(pid, page.task_id).status).toBe('READY');
    expect(b.state.q.task(pid, api1.task_id).status).toBe('RUNNING');

    // The interrupted call is recorded; trying again needs this clone's approval, so no request leaves.
    const run = await cli(['--project', cloneB, 'brain', 'run-once']);
    expect(run.code, run.stderr).toBe(0);
    expect(api.seen).toBe(1);
    expect(b.state.q.modelCalls(pid).map((c) => c.status)).toContain('interrupted');
    const asked = await cli(['--project', cloneB, 'escalations']);
    expect(asked.stdout).toContain('friday brain allow-remote');
    await be2.close();
  });
});
