import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createDaemon } from '@friday/daemon';
import type { TaskView } from '@friday/protocol';
import { privateDirFor, readDiscovery } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { rawRequest, startTestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();

describe('daemon lifecycle and discovery', () => {
  it('writes discovery and tokens to the private directory, and only a non-secret pointer into the project', async () => {
    const td = await startTestDaemon(ws());
    const env = { FRIDAY_STATE_DIR: ws().stateDir };
    const priv = privateDirFor(td.project, env);
    expect(readdirSync(priv).sort()).toEqual(['bootstrap.token', 'daemon.json', 'daemon.lock', 'operator.token']);
    expect(readDiscovery(td.project, env)).toMatchObject({
      url: td.url,
      host: '127.0.0.1',
      project_id: td.project.project_id,
    });
    const pointer = readFileSync(path.join(ws().fridayDir, 'run', 'daemon.json'), 'utf8');
    expect(pointer).toContain(td.url);
    expect(pointer).not.toContain(td.daemon.tokens.operator);
    expect(pointer).not.toContain(td.daemon.tokens.bootstrap);
    expect(td.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('refuses a second daemon for the same project', async () => {
    await startTestDaemon(ws());
    await expect(
      createDaemon({ projectRoot: ws().projectDir, stateDir: ws().stateDir, tickMs: 0, logToFile: false }),
    ).rejects.toThrow(/already running/);
  });

  it('close() removes discovery files and tokens and stops serving', async () => {
    const td = await startTestDaemon(ws());
    const priv = privateDirFor(td.project, { FRIDAY_STATE_DIR: ws().stateDir });
    await td.daemon.close();
    expect(existsSync(path.join(priv, 'daemon.json'))).toBe(false);
    expect(existsSync(path.join(priv, 'operator.token'))).toBe(false);
    expect(existsSync(path.join(ws().fridayDir, 'run', 'daemon.json'))).toBe(false);
    await expect(fetch(`${td.url}/health`)).rejects.toThrow();
  });

  it('restarts against the same database and keeps its history', async () => {
    const td = await startTestDaemon(ws());
    const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), { summary: 'survives restart' });
    await td.daemon.close();
    const again = await createDaemon({
      projectRoot: ws().projectDir,
      stateDir: ws().stateDir,
      tickMs: 0,
      logToFile: false,
    });
    ws().track({ close: () => again.close() });
    expect(again.state.q.task(td.project.project_id, t.task_id).summary).toBe('survives restart');
    expect(again.tokens.operator).not.toBe(td.daemon.tokens.operator);
  });

  it('serves the status page without a token, and its data only with the operator token', async () => {
    const td = await startTestDaemon(ws());
    const page = await fetch(`${td.url}/ui`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('<title>Friday status</title>');
    expect(html).not.toContain(td.daemon.tokens.operator);
    const status = await td.operator.get<{ head: number; tasks: unknown[] }>(td.operator.projectPath('/status'));
    expect(status.head).toBeGreaterThan(0);
  });
});

describe('token scopes (Appendix 8)', () => {
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('requires a token, rejects unknown and revoked ones', async () => {
    const td = await startTestDaemon(ws());
    expect((await fetch(`${td.url}/health`)).status).toBe(401);
    const bad = await fetch(`${td.url}/health`, { headers: { authorization: 'Bearer not-a-real-token-123456' } });
    expect(bad.status).toBe(401);
    expect(await code(bad)).toBe('COS-3004');
    const old = td.daemon.tokens.operator;
    await td.operator.post('/admin/rotate-tokens');
    const revoked = await fetch(`${td.url}/health`, { headers: { authorization: `Bearer ${old}` } });
    expect(revoked.status).toBe(401);
    expect(await code(revoked)).toBe('COS-3005');
  });

  it('bootstrap tokens can register and bind but cannot read or change tasks', async () => {
    const td = await startTestDaemon(ws());
    const res = await fetch(`${td.url}${td.operator.projectPath('/tasks')}`, {
      headers: { authorization: `Bearer ${td.daemon.tokens.bootstrap}` },
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('COS-3006');
    const h = await FakeHarness.connect(td, { loop: false });
    ws().track({ close: () => h.close() });
    expect(h.harnessId).toMatch(/^harness_/);
  });

  it('harness tokens cannot administer, assign or reach the operator API', async () => {
    const td = await startTestDaemon(ws());
    const h = await FakeHarness.connect(td, { loop: false });
    ws().track({ close: () => h.close() });
    const auth = { authorization: `Bearer ${h.token}` };
    for (const [method, p] of [
      ['POST', '/admin/shutdown'],
      ['GET', td.operator.projectPath('/tasks')],
      ['POST', td.operator.projectPath('/tasks/task_x/assign')],
      ['GET', td.operator.projectPath('/events')],
    ] as const) {
      const res = await fetch(`${td.url}${p}`, { method, headers: auth });
      expect(res.status, `${method} ${p}`).toBe(403);
      expect(await code(res)).toBe('COS-3006');
    }
    const reg = await h.rawRpc('harness.register', { protocol_version: '1.0' });
    expect((reg.body.error as { data: { code: string } }).data.code).toBe('COS-1001');
  });

  it('operator tokens cannot call harness methods, and project paths must match', async () => {
    const td = await startTestDaemon(ws());
    const rpc = await fetch(`${td.url}/protocol/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${td.daemon.tokens.operator}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'harness.heartbeat', params: {} }),
    });
    expect(rpc.status).toBe(403);
    const other = await fetch(`${td.url}/api/v1/projects/proj_00000000000000000000000099/tasks`, {
      headers: { authorization: `Bearer ${td.daemon.tokens.operator}` },
    });
    expect(other.status).toBe(404);
    expect(await code(other)).toBe('COS-2000');
  });
});

describe('Host and Origin policy (plan B22)', () => {
  it('accepts no Origin and its own origin; rejects other origins and foreign Host headers', async () => {
    const td = await startTestDaemon(ws());
    const u = new URL(td.url);
    const auth = { authorization: `Bearer ${td.daemon.tokens.operator}` };
    const own = await rawRequest(td.url, { path: '/health', headers: { ...auth, host: u.host, origin: td.url } });
    expect(own.status).toBe(200);
    const hostile = await rawRequest(td.url, {
      path: '/health',
      headers: { ...auth, host: u.host, origin: 'https://evil.example' },
    });
    expect(hostile.status).toBe(403);
    const rebinding = await rawRequest(td.url, {
      path: '/health',
      headers: { ...auth, host: `evil.example:${u.port}` },
    });
    expect(rebinding.status).toBe(403);
    const namedLoopback = 'localhost'; // portability-allow: localhost (the daemon must reject it)
    const localhostName = await rawRequest(td.url, {
      path: '/health',
      headers: { ...auth, host: `${namedLoopback}:${u.port}` },
    });
    expect(localhostName.status).toBe(403);
  });
});

describe('payload limits (plan B23)', () => {
  it('rejects bodies over 1 MB with COS-1004', async () => {
    const td = await startTestDaemon(ws());
    const res = await fetch(`${td.url}${td.operator.projectPath('/tasks')}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${td.daemon.tokens.operator}`, 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'x', description: 'y'.repeat(1_100_000) }),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('COS-1004');
  });

  it('rejects an oversized structured agent event without recording anything', async () => {
    const td = await startTestDaemon(ws());
    const h = await FakeHarness.connect(td, { loop: false });
    ws().track({ close: () => h.close() });
    const head = td.daemon.state.store.head(td.project.project_id);
    const res = await h.rawRpc('agent.event', { event_type: 'tool.completed', data: { blob: 'x'.repeat(70_000) } });
    expect((res.body.error as { data: { code: string } }).data.code).toBe('COS-1004');
    const after = td.daemon.state.store.readSince(td.project.project_id, head);
    // The rejection itself is recorded (plan B16); the oversized observation is not.
    expect(after.map((e) => e.type)).toEqual(['command.rejected']);
    expect(JSON.stringify(after)).not.toContain('xxxxxxxxxx');
  });

  it('rejects malformed JSON-RPC and invalid params with schema errors', async () => {
    const td = await startTestDaemon(ws());
    const h = await FakeHarness.connect(td, { loop: false });
    ws().track({ close: () => h.close() });
    const notRpc = await fetch(`${td.url}/protocol/v1/rpc`, {
      method: 'POST',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: '{"hello":',
    });
    expect(((await notRpc.json()) as { error: { data: { code: string } } }).error.data.code).toBe('COS-1001');
    const badParams = await h.rawRpc('task.update', { task_id: 1 });
    expect((badParams.body.error as { data: { code: string } }).data.code).toBe('COS-1001');
    const reserved = await h.rawRpc('verification.request', {});
    expect((reserved.body.error as { data: { code: string } }).data.code).toBe('COS-4002');
  });
});

describe('event stream', () => {
  it('streams events as SSE with sequence ids and resumes from Last-Event-ID', async () => {
    const td = await startTestDaemon(ws());
    const ctrl = new AbortController();
    const seen: { id: string | null; event: string }[] = [];
    const reader = (async () => {
      for await (const msg of td.operator.sse(td.operator.projectPath('/events/stream'), {
        signal: ctrl.signal,
        query: { since: 0 },
      })) {
        seen.push({ id: msg.id, event: msg.event });
        if (msg.event === 'task.created') ctrl.abort();
      }
    })();
    await td.operator.post(td.operator.projectPath('/tasks'), { summary: 'streamed' });
    await reader;
    expect(seen.map((s) => s.event)).toEqual(
      expect.arrayContaining(['project.created', 'daemon.started', 'task.created']),
    );
    const ids = seen.map((s) => Number(s.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    const resume = new AbortController();
    const after: string[] = [];
    const lastId = String(ids.at(-2));
    for await (const msg of td.operator.sse(td.operator.projectPath('/events/stream'), {
      signal: resume.signal,
      lastEventId: lastId,
    })) {
      after.push(msg.event);
      resume.abort();
    }
    expect(after).toEqual(['task.created']);
  });
});
