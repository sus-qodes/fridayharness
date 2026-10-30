/**
 * Runtime readiness through the daemon (ADR-0035 §1–§2; plan Phase 2.1): a connected session
 * makes its host ready, a doctor check makes a host ready for a day, a dry run judges each
 * candidate on its own host, the receipt records the checks, and `friday readiness` shows it all.
 */
import type {
  ReadinessEvidenceView,
  ReadinessReport,
  RoutingDecisionView,
  TaskStartParams,
  TaskView,
} from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { hostSeen } from '../helpers/readiness.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

type DryRun = { model: string | null; blocked: boolean; reason: string; readiness: RoutingDecisionView['readiness'] };

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`)).then((r) => r.task);
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('runtime readiness', () => {
  it('routes only to hosts this machine has seen, and says why the others are out', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const P = (p: string) => td.operator.projectPath(p);
    const task = await td.operator.post<TaskView>(P('/tasks'), {
      summary: 'Fix one file',
      kind: 'implementation',
      risk_level: 'low',
      scope: { write: ['src/a.ts'], read: [] },
    });
    const explain = () => td.operator.get<{ dry_run: DryRun }>(P(`/routing/explain/${task.task_id}`));

    // Nothing connected, nothing checked: no candidate can be shown able to take the work.
    const nothing = (await explain()).dry_run;
    expect(nothing).toMatchObject({ blocked: true, model: null });
    expect(nothing.reason).toContain('not ready: claude-code/claude-sonnet-5-5 is not installed');
    expect(nothing.readiness.map((r) => [r.host, r.model, r.dispatchable])).toEqual([
      ['claude-code', 'claude-sonnet-5-5', false],
      ['cursor', 'claude-opus-5-5', false],
      ['codex', 'openai/gpt-6.1-sol', false],
      ['opencode', 'z-ai/glm-5.3', false],
    ]);
    let report = await td.operator.get<ReadinessReport>(P('/readiness'));
    const codex = report.hosts.find((h) => h.host === 'codex');
    expect(codex).toMatchObject({ live: false, sessions: 0, ranked: true });
    expect(codex?.assessments.map((a) => [a.model, a.dispatchable])).toEqual([
      [null, false],
      ['openai/gpt-6-astra', false],
      ['openai/gpt-6-luna', false],
      ['openai/gpt-6.1-sol', false],
    ]);
    expect(codex?.assessments.find((a) => a.model === 'openai/gpt-6.1-sol')?.roles).toEqual([
      { role: 'backend_engineer', rank: 4 },
      { role: 'qa_and_debugging', rank: 2 },
      { role: 'devops_and_terminal', rank: 2 },
    ]);

    // A doctor check saw Codex: its rank 4 takes the work; Claude Code's rank 1 is still out.
    await hostSeen(td, 'codex', '0.162.1');
    const seen = (await explain()).dry_run;
    expect(seen).toMatchObject({ blocked: false, model: 'openai/gpt-6.1-sol' });
    expect(seen.readiness).toContainEqual({
      host: 'codex',
      model: 'openai/gpt-6.1-sol',
      dispatchable: true,
      reason: 'ready',
      bench_until: null,
    });
    const evidence = await td.operator.get<{ evidence: ReadinessEvidenceView[] }>(P('/readiness/evidence'), {
      query: { host: 'codex' },
    });
    expect(evidence.evidence.map((e) => [e.stage, e.status, e.source, e.version])).toEqual([
      ['handshake', 'passed', 'harness doctor', '0.162.1'],
      ['configured', 'passed', 'harness doctor', '0.162.1'],
      ['detected', 'passed', 'harness doctor', '0.162.1'],
    ]);

    // A session connects: its host is ready at once, and is the first in the ranking it serves.
    const fake = await FakeHarness.connect(td, { agentKey: 'cc-1', vendor: 'claude-code' });
    const connected = (await explain()).dry_run;
    expect(connected).toMatchObject({ blocked: false, model: 'claude-sonnet-5-5' });
    report = await td.operator.get<ReadinessReport>(P('/readiness'));
    expect(report.hosts.find((h) => h.host === 'claude-code')).toMatchObject({ live: true, sessions: 1 });

    const shown = await cli(['--project', dir, 'readiness']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('claude-code');
    expect(shown.stdout).toMatch(/claude-sonnet-5-5\s+yes\s+1/);
    expect(shown.stdout).toMatch(/openai\/gpt-6.1-sol\s+yes\s+-/);
    expect(shown.stdout).toMatch(/gemini-4-argon\s+no/);
    const explained = await cli(['--project', dir, 'routing', 'explain', task.task_id]);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.stdout).toContain('readiness claude-code/claude-sonnet-5-5: ready');
    expect(explained.stdout).toContain(
      'readiness cursor/claude-opus-5-5: not ready, cursor/claude-opus-5-5 is not installed',
    );
    const evidenceShown = await cli(['--project', dir, 'readiness', '--evidence', '--host', 'claude-code']);
    expect(evidenceShown.code, evidenceShown.stderr).toBe(0);
    expect(evidenceShown.stdout).toContain('harness.register');

    // The session ends: nothing vouches for Claude Code any more, and the dry run goes back to Codex.
    await fake.close();
    const gone = await td.operator.get<ReadinessReport>(P('/readiness'));
    expect(gone.hosts.find((h) => h.host === 'claude-code')).toMatchObject({ live: false, sessions: 0 });
  }, 120_000);

  it('a failed sign-in keeps a host out until a human clears it', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const P = (p: string) => td.operator.projectPath(p);
    await hostSeen(td, 'codex');
    await td.operator.post(P('/readiness/evidence'), {
      host: 'codex',
      source: 'test',
      stages: [{ stage: 'authenticated', status: 'failed', detail: 'run "codex login"' }],
    });
    const task = await td.operator.post<TaskView>(P('/tasks'), {
      summary: 'Fix one file',
      kind: 'implementation',
      risk_level: 'low',
      scope: { write: ['src/a.ts'], read: [] },
    });
    const blocked = await td.operator.get<{ dry_run: DryRun }>(P(`/routing/explain/${task.task_id}`));
    expect(blocked.dry_run).toMatchObject({ blocked: true, model: null });
    expect(blocked.dry_run.reason).toContain('codex/openai/gpt-6.1-sol is not signed in: run "codex login"');

    const cleared = await cli(['--project', dir, 'readiness', 'clear', 'codex']);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain('Cleared 1 record(s) for codex');
    const after = await td.operator.get<{ dry_run: DryRun }>(P(`/routing/explain/${task.task_id}`));
    expect(after.dry_run).toMatchObject({ blocked: false, model: 'openai/gpt-6.1-sol' });
  }, 60_000);

  it('fails over to the next host in the ranking after a host failure, and says so (ADR-0035 §3–§4)', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const P = (p: string) => td.operator.projectPath(p);
    const caps = (models: string[]) => ({ task_start: true, model_control: 'set', models });
    const cx = await FakeHarness.connect(td, {
      agentKey: 'cx-1',
      vendor: 'codex',
      capabilities: caps(['openai/gpt-6.1-sol']),
    });
    const cc = await FakeHarness.connect(td, {
      agentKey: 'cc-1',
      vendor: 'claude-code',
      capabilities: caps(['claude-sonnet-5-5']),
    });
    const task = await td.operator.post<TaskView>(P('/tasks'), {
      summary: 'Fix one file',
      kind: 'implementation',
      risk_level: 'low',
      scope: { write: ['src/a.ts'], read: [] },
      ready: true,
    });
    await td.operator.post(P(`/tasks/${task.task_id}/assign`), { agent_key: 'cx-1' });
    const first = (await cx.waitFor('task.start', 20_000)).params as TaskStartParams;
    expect(first).toMatchObject({ model: 'openai/gpt-6.1-sol', model_binding: true });
    await until(
      () => taskOf(td, task.task_id),
      (t) => t.status === 'RUNNING',
      'attempt 1 to run',
    );

    // The host is rate limited: the attempt ends as the host's failure, not the work's.
    await cx.client.reportError({
      task_id: task.task_id,
      run_id: first.run_id,
      message: 'Codex stopped: HTTP 429 Too Many Requests',
      fatal: true,
      failure: { kind: 'rate_limit', retry_after_s: 1800 },
    });
    await until(
      () => taskOf(td, task.task_id),
      (t) => t.waiting_reason === 'agent_error',
      'the host failure',
    );
    let report = await td.operator.get<ReadinessReport>(P('/readiness'));
    const sol = () =>
      report.hosts.find((h) => h.host === 'codex')?.assessments.find((a) => a.model === 'openai/gpt-6.1-sol');
    expect(sol()).toMatchObject({ dispatchable: false, blocking: { stage: 'benched', status: 'failed' } });
    expect(sol()?.reason).toContain('rate_limit: Codex stopped: HTTP 429 Too Many Requests');

    // Recovery reassigns as before; the next route skips the benched host for the next rank.
    expect(await td.daemon.recovery.sweep()).toEqual([`${task.task_id}: reassign`]);
    expect((await taskOf(td, task.task_id)).status).toBe('READY');
    const dry = await td.operator.get<{ dry_run: DryRun }>(P(`/routing/explain/${task.task_id}`));
    expect(dry.dry_run).toMatchObject({ blocked: false, model: 'claude-sonnet-5-5' });
    expect(dry.dry_run.readiness.find((r) => r.host === 'codex')).toMatchObject({ dispatchable: false });
    await td.operator.post(P(`/tasks/${task.task_id}/assign`), { agent_key: 'cc-1' });
    const second = (await cc.waitFor('task.start', 20_000)).params as TaskStartParams;
    expect(second).toMatchObject({ model: 'claude-sonnet-5-5', attempt: 2 });
    const explained = await cli(['--project', dir, 'routing', 'explain', task.task_id]);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.stdout).toContain(
      `failover: attempt ${first.run_id} stopped on codex/openai/gpt-6.1-sol (rate_limit: Codex stopped: HTTP 429 Too Many Requests), benched until`,
    );
    expect(explained.stdout).toContain('excluded openai/gpt-6.1-sol: readiness.benched');

    // A human lifts the bench: the host is tried again.
    const cleared = await cli(['--project', dir, 'readiness', 'clear', 'codex', '--model', 'openai/gpt-6.1-sol']);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(cleared.stdout).toContain('Cleared 1 record(s) for codex/openai/gpt-6.1-sol');
    report = await td.operator.get<ReadinessReport>(P('/readiness'));
    expect(sol()?.dispatchable).toBe(true);
    await cx.close();
    await cc.close();
  }, 120_000);
});
