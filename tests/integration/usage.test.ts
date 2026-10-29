/**
 * The token baseline through the daemon (plan M10a): `GET /usage` and `friday usage` join each run
 * attempt's host usage, delivered packets, tool calls and verification into one row, and show an
 * attempt whose host reported nothing with unknown values, never zeros.
 */
import { claudeCodeHooks } from '@friday/adapter-claude';
import type { ContextPacket, TaskStartParams, TaskView, UsageReport } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSession } from '../helpers/claude-session.js';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

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

const usage = (td: TestDaemon, query = '') => td.operator.get<UsageReport>(td.operator.projectPath(`/usage${query}`));

describe('friday usage (plan M10a)', () => {
  it('shows one row per attempt: a reporting spawned host in full, an attached session as unknown', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: { autoStart: false }, extensions: [claudeCodeHooks()] });
    const dir = ws().projectDir;
    const pid = td.project.project_id;

    // A goal with one planned task, so the row carries its goal and the goal filter has something to find.
    const goal = await td.operator.post<{ goal_id: string }>(td.operator.projectPath('/goals'), {
      request: 'Measure what an attempt costs',
      plan: false,
    });
    const v1 = await td.operator.post<{ plan_id: string; version: number }>(
      td.operator.projectPath(`/goals/${goal.goal_id}/plans`),
      {
        draft: {
          objective: 'Measure what an attempt costs',
          summary: 'one task',
          tasks: [
            {
              key: 'row',
              summary: 'Build the usage row',
              acceptance_criteria: ['tests pass'],
              scope: { write: ['src/**'], read: ['**'] },
              depends_on: [],
            },
          ],
        },
      },
    );
    await td.operator.post(td.operator.projectPath(`/plans/${v1.plan_id}/versions/${v1.version}/approve`), {});
    const planned = td.daemon.state.q.goalTasks(pid, goal.goal_id)[0] as TaskView;
    if (planned.status === 'PROPOSED')
      await td.operator.post(td.operator.projectPath(`/tasks/${planned.task_id}/ready`), {});

    // 1. A spawned host runs it, asks Friday for context, calls tools, reports its usage and claims.
    const fake = await FakeHarness.connect(td, { agentKey: 'spawned' });
    await td.operator.post(td.operator.projectPath(`/tasks/${planned.task_id}/assign`), { agent_key: 'spawned' });
    const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
    const ids = { task_id: planned.task_id, run_id: start.run_id };
    const packet = (await fake.client.requestContext({ ...ids, kind: 'task' })) as ContextPacket;
    expect(packet.recipient.run_id).toBe(start.run_id);
    // A request the compiler refuses (the task's protected context does not fit the size asked
    // for) leaves no packet, and is still a request the attempt made.
    await expect(fake.client.requestContext({ ...ids, kind: 'scope_files', max_chars: 500 })).rejects.toMatchObject({
      code: 'COS-5002',
    });
    for (const tool of ['Read', 'Grep', 'Edit', 'Bash', 'mcp__friday__context_request']) {
      await fake.client.emitEvent({ ...ids, event_type: 'tool.completed', data: { tool } });
    }
    await fake.client.emitEvent({ ...ids, event_type: 'tool.failed', data: { tool: 'Bash', error: 'exit code 1' } });
    await fake.client.emitEvent({
      ...ids,
      event_type: 'host.usage',
      data: {
        cost_usd: 0.0123,
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        turns: 3,
        model: 'claude-haiku-5-5',
      },
    });
    await fake.client.reportResult({
      ...ids,
      status: 'completed_claim',
      summary: 'done',
      changed_paths: [],
      checks: [],
    });
    const verified = await cli(['--project', dir, 'verify', planned.task_id, '--result', 'passed']);
    expect(verified.code, verified.stderr).toBe(0);

    // 2. An attached session holds a task; its host reports nothing.
    const s = await claudeSession(td, ws(), { write: ['docs/**'], summary: 'Document the checkout flow' });

    const report = await usage(td);
    expect(report.rows.map((r) => r.run_id).sort()).toEqual([start.run_id, s.run_id].sort());
    expect(report).toMatchObject({ truncated: false, limit: 500 });
    const run = td.daemon.state.q.run(start.run_id);
    const sourceTokens = packet.sections.flatMap((x) => x.sources).reduce((a, x) => a + x.estimated_tokens, 0);
    const full = report.rows.find((r) => r.run_id === start.run_id);
    expect(full).toMatchObject({
      task_id: planned.task_id,
      task_summary: 'Build the usage row',
      goal_id: goal.goal_id,
      attempt: 1,
      agent_key: 'spawned',
      harness_vendor: 'generic',
      harness_mode: 'spawn',
      packets: {
        count: 1,
        tokens: packet.budget.tokens,
        chars: packet.budget.chars ?? null,
        source_tokens: sourceTokens,
      },
      context_requests: { count: 2, kinds: { scope_files: 1, task: 1 } },
      host: {
        reported: true,
        input_tokens: 1200,
        output_tokens: 80,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        cost_usd: 0.0123,
        turns: 3,
        model: 'claude-haiku-5-5',
      },
      tool_calls: { total: 6, failed: 1, by_kind: { read: 2, edit: 1, shell: 2, web: 0, friday: 1, other: 0 } },
      verification: { status: 'PASSED', checks_passed: 1, checks_total: 1 },
      started_at: run.accepted_at,
      ended_at: run.ended_at,
    });
    expect(full?.duration_ms).toBe(
      run.ended_at ? Date.parse(run.ended_at) - Date.parse(run.accepted_at ?? run.created_at) : null,
    );

    // The attached session's claim delivered a packet that names its run; the host said nothing else.
    const unknown = report.rows.find((r) => r.run_id === s.run_id);
    expect(unknown).toMatchObject({
      task_id: s.task.task_id,
      goal_id: null,
      agent_key: s.agent,
      harness_vendor: 'claude-code',
      harness_mode: 'attach',
      packets: { count: 1 },
      host: {
        reported: false,
        input_tokens: null,
        output_tokens: null,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: null,
        cost_usd: null,
        turns: null,
        model: null,
      },
      tool_calls: { total: 0, failed: 0 },
      verification: null,
      ended_at: null,
      duration_ms: null,
    });
    expect(unknown?.packets.tokens).toBeGreaterThan(0);
    expect(report.totals).toEqual({
      attempts: 2,
      host_reported: 1,
      reporters: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 1,
        cost_usd: 1,
      },
      input_tokens: 1200,
      output_tokens: 80,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
      cost_usd: 0.0123,
      tool_calls: 6,
    });

    // Filters: by goal, by task; something that does not exist is the usual not-found error.
    expect((await usage(td, `?goal=${goal.goal_id}`)).rows.map((r) => r.run_id)).toEqual([start.run_id]);
    expect((await usage(td, `?task=${s.task.task_id}`)).rows.map((r) => r.run_id)).toEqual([s.run_id]);
    await expect(usage(td, '?goal=goal_00000000000000000000000000')).rejects.toMatchObject({ code: 'COS-2006' });
    await expect(usage(td, '?task=task_00000000000000000000000000')).rejects.toMatchObject({ code: 'COS-2001' });

    // The CLI: the same report as JSON, and a table with "-" where the host reported nothing.
    const asJson = await cli(['--project', dir, 'usage', '--json']);
    expect(asJson.code, asJson.stderr).toBe(0);
    expect(JSON.parse(asJson.stdout)).toEqual(report);
    const byTask = await cli(['--project', dir, 'usage', '--task', planned.task_id, '--json']);
    expect((JSON.parse(byTask.stdout) as UsageReport).rows.map((r) => r.run_id)).toEqual([start.run_id]);
    const text = await cli(['--project', dir, 'usage']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('TASK');
    expect(text.stdout).toMatch(
      new RegExp(
        `${planned.task_id}\\s+1\\s+spawned\\s+claude-haiku-5-5\\s+${packet.budget.tokens}\\s+1200\\s+80\\s+900\\s+100\\s+\\$0\\.0123\\s+2/1/2/1\\s+PASSED 1/1`,
      ),
    );
    expect(text.stdout).toMatch(
      new RegExp(`${s.task.task_id}\\s+1\\s+${s.agent}\\s+.*\\s-\\s+-\\s+-\\s+-\\s+-\\s+0/0/0/0\\s+-$`, 'm'),
    );
    expect(text.stdout).toContain(
      '2 attempt(s), 1 of 2 reported host usage: in 1200, out 80, cache read 900, cache write 100, cost $0.0123; 6 tool call(s).',
    );
    // The legend tells a host that did not report from a column with nothing to show.
    expect(text.stdout).toContain(
      '"-" under IN, OUT, CACHE and COST: the host did not report it; elsewhere: nothing to show',
    );
    await fake.close();
  }, 120_000);
});
