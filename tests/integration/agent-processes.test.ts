import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAgentLauncher } from '@friday/cli';
import type { AgentHost, AgentProcessesView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { codeOf, raw, signIn } from '../helpers/ui.js';

/**
 * The agent launcher (docs/frontend/PLAN.md §5.9, FD-10, FD-24). The child is a scripted adapter
 * injected in place of `friday harness run`, and host detection is faked: no real host can start
 * (LESSONS UI-34).
 */

const ws = useTestWorkspace();
const ADAPTER = path.join(REPO_ROOT, 'tests', 'fixtures', 'scripted-adapter', 'adapter.mjs');
const HOSTS: AgentHost[] = [
  { host: 'codex', found: true, version: '0.0.0-test', supported: true, path: null, reason: null },
  { host: 'claude-code', found: false, version: null, supported: false, path: null, reason: 'not installed (test)' },
];

function launcher(opts: { detectMs?: number } = {}) {
  const started: string[][] = [];
  const ext = createAgentLauncher({
    detectHosts: async () => {
      if (opts.detectMs) await new Promise((res) => setTimeout(res, opts.detectMs));
      return HOSTS;
    },
    stopGraceMs: 3000,
    child: (req, ctx) => {
      const args = [
        ADAPTER,
        `http://127.0.0.1:${ctx.port()}`,
        path.join(ctx.privateDir, 'bootstrap.token'),
        ctx.project.project_id,
        req.agent_key,
        req.role,
      ];
      started.push(args);
      // No PATH and no host variables: nothing real could be found or started.
      return { command: process.execPath, args, env: { SystemRoot: process.env.SystemRoot ?? '' } };
    },
  });
  return { ext, started };
}

const op = (td: TestDaemon) => td.daemon.tokens.operator;
const processes = async (td: TestDaemon) =>
  (await raw(td, 'GET', td.operator.projectPath('/agent-processes'), { token: op(td) }))
    .json as unknown as AgentProcessesView;
async function until(check: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
}

describe('the agent launcher', () => {
  it('refuses a second start of the same key while hosts are still being detected (review M9i)', async () => {
    const { ext, started } = launcher({ detectMs: 300 });
    const td = await startTestDaemon(ws(), { extensions: [ext] });
    const post = () =>
      raw(td, 'POST', td.operator.projectPath('/agent-processes'), {
        token: op(td),
        body: JSON.stringify({ host: 'codex', agent_key: 'dev-1', role: 'developer' }),
      });
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(started).toHaveLength(1);
    expect((await processes(td)).processes.map((p) => p.agent_key)).toEqual(['dev-1']);
  });

  it('starts an agent that registers, keeps its redacted output, and stops it gracefully', async () => {
    const { ext, started } = launcher();
    const td = await startTestDaemon(ws(), { extensions: [ext] });
    const hosts = await raw(td, 'GET', td.operator.projectPath('/agent-hosts'), { token: op(td) });
    expect(((hosts.json?.hosts ?? []) as AgentHost[]).map((h) => h.host)).toEqual(['codex', 'claude-code']);
    const r = await raw(td, 'POST', td.operator.projectPath('/agent-processes'), {
      token: op(td),
      body: JSON.stringify({ host: 'codex', agent_key: 'codex-1', role: 'backend', options: { sandbox: 'read-only' } }),
    });
    expect(r.status, r.text).toBe(201);
    expect(started).toHaveLength(1);
    await until(async () =>
      (await td.operator.get<{ agents: { agent_key: string }[] }>(td.operator.projectPath('/agents'))).agents.some(
        (a) => a.agent_key === 'codex-1',
      ),
    );
    await until(async () => (await processes(td)).processes[0]?.log_tail.length === 1);
    const view = await processes(td);
    expect(view.processes[0]).toMatchObject({
      agent_key: 'codex-1',
      host: 'codex',
      role: 'backend',
      status: 'running',
    });
    // The bootstrap token the child printed never reaches the API or the log file.
    const bootstrap = td.daemon.tokens.bootstrap;
    expect(JSON.stringify(view)).not.toContain(bootstrap);
    const log = readFileSync(path.join(ws().projectDir, '.friday', 'logs', 'agents', 'codex-1.log'), 'utf8');
    expect(log).not.toContain(bootstrap);
    expect(view.profiles).toEqual([expect.objectContaining({ agent_key: 'codex-1', autostart: true })]);

    const stop = await raw(td, 'POST', td.operator.projectPath('/agent-processes/codex-1/stop'), {
      token: op(td),
      body: '{}',
    });
    expect(stop.status).toBe(200);
    expect((stop.json?.process as { status: string; exit_code: number } | undefined)?.exit_code).toBe(0);
    expect((await processes(td)).processes[0]?.log_tail.at(-1)).toBe('stopped');
  });

  it('starts a remembered agent again, and forgets it', async () => {
    const { ext, started } = launcher();
    const td = await startTestDaemon(ws(), { extensions: [ext] });
    await raw(td, 'POST', td.operator.projectPath('/agent-processes'), {
      token: op(td),
      body: JSON.stringify({ host: 'codex', agent_key: 'codex-2', role: 'developer', autostart: false }),
    });
    await raw(td, 'POST', td.operator.projectPath('/agent-processes/codex-2/stop'), { token: op(td), body: '{}' });
    const again = await raw(td, 'POST', td.operator.projectPath('/agent-processes/codex-2/start'), {
      token: op(td),
      body: '{}',
    });
    expect(again.status, again.text).toBe(201);
    expect(started).toHaveLength(2);
    const forgot = await raw(td, 'POST', td.operator.projectPath('/agent-processes/codex-2/forget'), {
      token: op(td),
      body: '{}',
    });
    expect(forgot.status).toBe(200);
    expect((await processes(td)).profiles).toEqual([]);
  });

  it('refuses what it must not run', async () => {
    const { ext, started } = launcher();
    const td = await startTestDaemon(ws(), { extensions: [ext] });
    const post = (body: unknown, token = op(td)) =>
      raw(td, 'POST', td.operator.projectPath('/agent-processes'), { token, body: JSON.stringify(body) });
    // Options are validated: nothing becomes another command-line option of the host.
    expect((await post({ host: 'codex', agent_key: 'codex-3', options: { sandbox: '--yolo' } })).status).toBe(400);
    expect((await post({ host: 'codex', agent_key: 'codex-3', options: { effort: '-x' } })).status).toBe(400);
    expect((await post({ host: 'codex', agent_key: 'BAD KEY' })).status).toBe(400);
    // Models come from routing.
    expect((await post({ host: 'codex', agent_key: 'codex-3', model: 'gpt-x' })).status).toBe(400);
    // Only the operator class: a bootstrap token is refused (extensions sit outside allow()).
    const boot = await post({ host: 'codex', agent_key: 'codex-3' }, td.daemon.tokens.bootstrap);
    expect(boot.status).toBe(403);
    // A UI session is operator-class and may start agents.
    const token = await signIn(td);
    expect((await raw(td, 'GET', td.operator.projectPath('/agent-processes'), { token })).status).toBe(200);
    // A key a live session already holds is refused, with who holds it.
    expect((await post({ host: 'codex', agent_key: 'codex-4' })).status).toBe(201);
    await until(async () =>
      (await td.operator.get<{ agents: { agent_key: string }[] }>(td.operator.projectPath('/agents'))).agents.some(
        (a) => a.agent_key === 'codex-4',
      ),
    );
    const twice = await post({ host: 'codex', agent_key: 'codex-4' });
    expect(twice.status).toBe(409);
    expect(codeOf(twice)).toBe('COS-2002');
    expect(started).toHaveLength(1);
  });

  it('stops its agents before the daemon drains, so they disconnect cleanly', async () => {
    const { ext } = launcher();
    const td = await startTestDaemon(ws(), { extensions: [ext] });
    await raw(td, 'POST', td.operator.projectPath('/agent-processes'), {
      token: op(td),
      body: JSON.stringify({ host: 'codex', agent_key: 'codex-5' }),
    });
    await until(async () =>
      (await td.operator.get<{ agents: { agent_key: string }[] }>(td.operator.projectPath('/agents'))).agents.some(
        (a) => a.agent_key === 'codex-5',
      ),
    );
    await raw(td, 'POST', td.operator.projectPath('/daemon/stop'), { token: op(td), body: '{}' });
    await td.daemon.closed;
    // The child was told to stop while the daemon still answered: its disconnect went through.
    const log = readFileSync(path.join(ws().projectDir, '.friday', 'logs', 'agents', 'codex-5.log'), 'utf8');
    expect(log).toContain('disconnected');
    expect(log).not.toContain('disconnect failed');
  });
});
