/**
 * Runtime readiness through the daemon (ADR-0035 §1–§2; plan Phase 2.1): a connected session
 * makes its host ready, a doctor check makes a host ready for a day, a dry run judges each
 * candidate on its own host, the receipt records the checks, and `friday readiness` shows it all.
 */
import type { ReadinessEvidenceView, ReadinessReport, RoutingDecisionView, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';
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
});
