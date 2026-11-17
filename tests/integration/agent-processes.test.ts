import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createAgentLauncher } from '@friday/cli';
import type { AgentHost, AgentOptions, AgentProcessesView, AgentProfile } from '@friday/protocol';
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

function launcher(opts: { detectMs?: number; hosts?: AgentHost[]; signIn?: () => string | undefined } = {}) {
  const started: string[][] = [];
  /** The options each child was started with, as the launcher decided them. */
  const ran: AgentOptions[] = [];
  const ext = createAgentLauncher({
    detectHosts: async () => {
      if (opts.detectMs) await new Promise((res) => setTimeout(res, opts.detectMs));
      return opts.hosts ?? HOSTS;
    },
    stopGraceMs: 3000,
    // Never this machine's own sign-in files: what a test gives, or none read.
    signIn: opts.signIn ?? (() => undefined),
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
      ran.push(req.options);
      // No PATH and no host variables: nothing real could be found or started.
      return { command: process.execPath, args, env: { SystemRoot: process.env.SystemRoot ?? '' } };
    },
  });
  return { ext, started, ran };
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

  it('changes a remembered agent in place: the next start uses the new, what runs keeps the old', async () => {
    const { ext, ran } = launcher();
    const td = await startTestDaemon(ws(), { extensions: [ext] });
    const post = (rel: string, body: unknown, token = op(td)) =>
      raw(td, 'POST', td.operator.projectPath(rel), { token, body: JSON.stringify(body) });
    expect(
      (await post('/agent-processes', { host: 'codex', agent_key: 'codex-6', options: { sandbox: 'read-only' } }))
        .status,
    ).toBe(201);
    const changed = await post('/agent-processes/codex-6/update', {
      role: 'backend',
      autostart: false,
      options: { sandbox: 'workspace-write', effort: 'high' },
    });
    expect(changed.status, changed.text).toBe(200);
    // It runs: said, so the interface can tell the person the change waits for the next start.
    expect(changed.json?.running).toBe(true);
    expect(changed.json?.profile).toMatchObject({
      agent_key: 'codex-6',
      host: 'codex',
      role: 'backend',
      autostart: false,
      options: { sandbox: 'workspace-write', effort: 'high' },
    });
    const view = await processes(td);
    expect(view.profiles[0]).toMatchObject({ role: 'backend', autostart: false });
    expect(view.processes[0]).toMatchObject({ role: 'developer', options: { sandbox: 'read-only' } });

    // A part left out is kept; options sent replace the options as a whole.
    const partly = await post('/agent-processes/codex-6/update', { role: 'frontend' });
    expect(partly.json?.profile as AgentProfile).toMatchObject({
      role: 'frontend',
      autostart: false,
      options: { sandbox: 'workspace-write', effort: 'high' },
    });

    // The same rules as a start: nothing becomes another option of the host, host and key stay.
    expect((await post('/agent-processes/codex-6/update', { options: { sandbox: '--yolo' } })).status).toBe(400);
    expect((await post('/agent-processes/codex-6/update', { options: { max_budget_usd: 5 } })).status).toBe(400);
    expect((await post('/agent-processes/codex-6/update', { role: 'Bad Role' })).status).toBe(400);
    expect((await post('/agent-processes/codex-6/update', { host: 'claude-code' })).status).toBe(400);
    expect((await post('/agent-processes/codex-6/update', { agent_key: 'codex-7' })).status).toBe(400);
    expect((await post('/agent-processes/nobody/update', { role: 'backend' })).status).toBe(404);
    expect((await post('/agent-processes/codex-6/update', { role: 'qa' }, td.daemon.tokens.bootstrap)).status).toBe(
      403,
    );
    expect((await processes(td)).profiles[0]).toMatchObject({ role: 'frontend' });

    // Stopped and started again, it runs with what was saved.
    await post('/agent-processes/codex-6/stop', {});
    expect((await post('/agent-processes/codex-6/start', {})).status).toBe(201);
    expect(ran).toEqual([{ sandbox: 'read-only' }, { sandbox: 'workspace-write', effort: 'high' }]);
    expect((await processes(td)).processes[0]).toMatchObject({ role: 'frontend' });
  });

  it('decides a limit nobody set from how the host is signed in, and keeps a person’s own', async () => {
    // The host check says a subscription throughout, and is hours old for all the launcher knows:
    // what counts is the sign-in read when the agent starts.
    let now: string | undefined;
    let n = 0;
    const { ext, ran } = launcher({
      hosts: [
        {
          host: 'claude-code',
          found: true,
          version: '9.9.9-test',
          supported: true,
          path: null,
          reason: null,
          sign_in: 'subscription',
        },
      ],
      signIn: () => now,
    });
    const td = await startTestDaemon(ws(), { extensions: [ext] });
    const start = async (signIn: string | undefined, options?: AgentOptions) => {
      now = signIn;
      n += 1;
      const key = `claude-${n}`;
      const r = await raw(td, 'POST', td.operator.projectPath('/agent-processes'), {
        token: op(td),
        body: JSON.stringify({
          host: 'claude-code',
          agent_key: key,
          autostart: false,
          ...(options ? { options } : {}),
        }),
      });
      expect(r.status, r.text).toBe(201);
      const view = await processes(td);
      return {
        ran: ran.at(-1),
        shown: view.processes.find((p) => p.agent_key === key)?.options,
        remembered: view.profiles.find((p) => p.agent_key === key)?.options,
      };
    };
    // The Start dialog is told the sign-in of this moment too, not the one of the host check.
    now = 'api_key';
    const listed = await raw(td, 'GET', td.operator.projectPath('/agent-hosts'), { token: op(td) });
    expect(((listed.json?.hosts ?? []) as AgentHost[])[0]?.sign_in).toBe('api_key');
    // A subscription is not charged per attempt: no limit. What is remembered stays undecided, so
    // a later change of sign-in is followed.
    expect(await start('subscription')).toEqual({
      ran: { max_budget_usd: null },
      shown: { max_budget_usd: null },
      remembered: {},
    });
    // Charged per use, or Friday cannot tell: the default limit.
    // (Three of them here: the launcher runs at most eight agents at once.)
    for (const signIn of ['api_key', 'none', undefined]) {
      expect((await start(signIn)).ran, String(signIn)).toEqual({ max_budget_usd: 5 });
    }
    // A person's own choice stands either way.
    expect((await start('subscription', { max_budget_usd: 2 })).ran).toEqual({ max_budget_usd: 2 });
    expect(await start('api_key', { max_budget_usd: null })).toEqual({
      ran: { max_budget_usd: null },
      shown: { max_budget_usd: null },
      remembered: { max_budget_usd: null },
    });
    // A limit raised on an agent that runs shows at once: it is read again at its next attempt,
    // with no restart of the agent.
    const raised = await raw(td, 'POST', td.operator.projectPath('/agent-processes/claude-1/update'), {
      token: op(td),
      body: JSON.stringify({ options: { max_budget_usd: 9 } }),
    });
    expect(raised.json?.running).toBe(true);
    const after = await processes(td);
    expect(after.processes.find((p) => p.agent_key === 'claude-1')?.options).toEqual({ max_budget_usd: 9 });
    expect(after.profiles.find((p) => p.agent_key === 'claude-1')?.options).toEqual({ max_budget_usd: 9 });
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
