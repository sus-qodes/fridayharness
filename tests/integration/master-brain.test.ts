/**
 * The Master Brain through the daemon (plan M2b): the operator API, the CLI, and the real
 * Anthropic provider wiring against a local stand-in for the Messages API (no network).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import path from 'node:path';
import { createDaemon } from '@friday/daemon';
import { FakePlannerModel } from '@friday/planner';
import type { GoalView, PlanTaskView, PlanVersionView, TaskView } from '@friday/protocol';
import { renderInitialConfig } from '@friday/sdk';
import { deterministicGit, type TestWorkspace, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { initTestProject, rawRequest, startTestDaemon, TEST_PROJECT_ID } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'planner', 'stripe-subscriptions');
const GOAL_WITH_SECRET = (goal: string) => `${goal} (the old key was ${SEEDED.inGoal})`;
const GOAL = 'Add Stripe subscriptions, keep one-time checkout working, add tests';

type LiveTask = PlanTaskView & { status: string | null; agent_key: string | null };
type LiveVersion = Omit<PlanVersionView, 'tasks'> & { tasks: LiveTask[] };
interface GoalDetail {
  goal: GoalView;
  versions: { version: number; status: string }[];
  active: LiveVersion | null;
  proposed: LiveVersion | null;
  escalations: {
    escalation_id: string;
    kind: string | null;
    question: string;
    details: Record<string, unknown> | null;
  }[];
  model_calls: { count: number; cost_usd: number };
}

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

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('Master Brain over the operator API', () => {
  it('serves goals and plan versions with live task state, approval, human revisions, diff and model calls', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      brain: { model: FakePlannerModel.fromDirectory(FIXTURES), autoStart: false },
    });
    const op = td.operator;
    const goal = await op.post<GoalView>(op.projectPath('/goals'), {
      request: GOAL,
      constraints: ['keep one-time checkout working'],
    });
    expect(goal).toMatchObject({ status: 'OPEN', objective: null, constraints: ['keep one-time checkout working'] });

    const pass = await op.post<{ steps: { action: string; result: string }[] }>(op.projectPath('/brain/run-once'), {});
    expect(pass.steps).toContainEqual(
      expect.objectContaining({ action: 'plan', result: expect.stringMatching(/^proposed plan_\w+ v1 with 4 task/) }),
    );
    const d1 = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d1.goal.objective).toMatch(/Stripe subscription billing/);
    expect(d1.active).toBeNull();
    expect(d1.proposed?.tasks.map((t) => [t.key, t.status])).toEqual([
      ['billing-service', null],
      ['subscribe-page', null],
      ['stripe-webhooks', null],
      ['lifecycle-tests', null],
    ]);
    const planId = d1.proposed?.plan_id as string;

    const approved = await op.post<{ created: TaskView[]; plan: LiveVersion }>(
      op.projectPath(`/plans/${planId}/versions/1/approve`),
      { note: 'looks right' },
    );
    expect(approved.created).toHaveLength(4);
    expect(approved.plan).toMatchObject({
      status: 'ACTIVE',
      decision_note: 'looks right',
      decided_by_id: 'local-operator',
    });
    const again = await rawRequest(td.url, {
      method: 'POST',
      path: op.projectPath(`/plans/${planId}/versions/1/approve`),
      headers: {
        host: td.url.replace('http://', ''),
        authorization: `Bearer ${td.daemon.tokens.operator}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(again.status).toBe(409);
    expect((again.json as { error: { code: string } }).error.code).toBe('COS-2002');

    const d2 = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(d2.goal.status).toBe('ACTIVE');
    expect(d2.active?.tasks.map((t) => t.status)).toEqual(['READY', 'READY', 'PROPOSED', 'PROPOSED']);
    const lifecycle = d2.active?.tasks.find((t) => t.key === 'lifecycle-tests')?.task_id as string;

    // A human writes a revision: invalid ones come back with every error, a valid one becomes v2.
    const bad = await rawRequest(td.url, {
      method: 'POST',
      path: op.projectPath(`/goals/${goal.goal_id}/plans`),
      headers: {
        host: td.url.replace('http://', ''),
        authorization: `Bearer ${td.daemon.tokens.operator}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        draft: { summary: 'drop a running task', drop: [{ task_id: 'task_nope', reason: 'not needed' }] },
      }),
    });
    expect(bad.status).toBe(400);
    expect((bad.json as { error: { code: string; details: { errors: string[] } } }).error).toMatchObject({
      code: 'COS-1001',
      details: { errors: [expect.stringContaining('task_nope is not a task of this plan')] },
    });
    const v2 = await op.post<LiveVersion>(op.projectPath(`/goals/${goal.goal_id}/plans`), {
      draft: {
        summary: 'Lifecycle tests move to a later goal',
        drop: [{ task_id: lifecycle, reason: 'covered by the QA team next sprint' }],
      },
    });
    expect(v2).toMatchObject({
      version: 2,
      status: 'PROPOSED',
      trigger: 'written by a human',
      proposed_by: { kind: 'human', id: 'local-operator' },
    });
    const diff = await op.get<{ diff: { dropped: { key: string }[]; unchanged: number } }>(
      op.projectPath(`/plans/${planId}/diff`),
      {
        query: { from: '1', to: '2' },
      },
    );
    expect(diff.diff.dropped.map((t) => t.key)).toEqual(['lifecycle-tests']);
    expect(diff.diff.unchanged).toBe(3);

    const status = await op.get<{ provider: string; planner_available: boolean; key: string }>(
      op.projectPath('/brain'),
    );
    expect(status).toMatchObject({ provider: 'fake', planner_available: true, key: 'not needed' });
    const calls = await op.get<{ calls: { purpose: string; status: string; cost_usd: number }[]; cost_usd: number }>(
      op.projectPath('/model-calls'),
    );
    expect(calls.calls).toMatchObject([{ purpose: 'plan', status: 'ok' }]);
    expect(calls.cost_usd).toBeGreaterThan(0);

    // Goals are operator business: a bootstrap token cannot read them.
    const asBootstrap = await rawRequest(td.url, {
      path: op.projectPath('/goals'),
      headers: { host: td.url.replace('http://', ''), authorization: `Bearer ${td.daemon.tokens.bootstrap}` },
    });
    expect(asBootstrap.status).toBe(403);
  });
});

describe('Master Brain from the CLI', () => {
  it('creates a goal, approves the plan, runs two agents in parallel, and surfaces the revision and the question', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: { model: FakePlannerModel.fromDirectory(FIXTURES) } });
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const fe = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    ws().track({ close: () => Promise.all([be.close(), fe.close()]) });
    const dir = ws().projectDir;

    const created = await cli([
      '--project',
      dir,
      'goal',
      'create',
      GOAL,
      '--constraint',
      'keep one-time checkout working',
      '--wait',
      '20',
    ]);
    expect(created.code, created.stderr).toBe(0);
    for (const s of ['Waiting for your decision:', 'billing-service', 'lifecycle-tests', 'friday plan approve'])
      expect(created.stdout).toContain(s);

    const approve = await cli(['--project', dir, 'plan', 'approve', '--note', 'go']);
    expect(approve.code, approve.stderr).toBe(0);
    expect(approve.stdout).toMatch(/Approved plan_\w+ v1; 4 task\(s\) created\./);

    // The Master Brain delegates the two independent tasks; the FakeHarnesses accept them.
    const goalId = (await td.operator.get<{ goals: GoalView[] }>(td.operator.projectPath('/goals'))).goals[0]
      ?.goal_id as string;
    const detail = () => td.operator.get<GoalDetail>(td.operator.projectPath(`/goals/${goalId}`));
    const running = await eventually(
      detail,
      (d) => d.active?.tasks.filter((t) => t.status === 'RUNNING').length === 2,
      'two running tasks',
    );
    const byKey = Object.fromEntries((running.active?.tasks ?? []).map((t) => [t.key, t]));
    expect([byKey['billing-service']?.agent_key, byKey['subscribe-page']?.agent_key]).toEqual(['be-1', 'fe-1']);
    const shown = await cli(['--project', dir, 'plan']);
    expect(shown.stdout).toMatch(/billing-service\s+RUNNING\s+backend\s+be-1/);

    // Both claim completion; verification passes one and fails the other.
    for (const [h, key] of [
      [be, 'billing-service'],
      [fe, 'subscribe-page'],
    ] as const) {
      const t = await td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${byKey[key]?.task_id}`));
      await h.client.reportResult({
        task_id: t.task.task_id,
        run_id: t.task.current_run_id as string,
        status: 'completed_claim',
        summary: `${key} done`,
        changed_paths: [],
      });
    }
    expect(
      (await cli(['--project', dir, 'verify', byKey['billing-service']?.task_id as string, '--result', 'passed'])).code,
    ).toBe(0);
    expect(
      (
        await cli([
          '--project',
          dir,
          'verify',
          byKey['subscribe-page']?.task_id as string,
          '--result',
          'failed',
          '--note',
          'price test expects VAT',
        ])
      ).code,
    ).toBe(0);

    const revised = await eventually(
      detail,
      (d) => d.proposed?.version === 2 && d.escalations.length > 0,
      'plan v2 and a question',
    );
    expect(revised.proposed?.tasks.find((t) => t.key === 'subscribe-page')?.change).toBe('rework');
    const escalations = await cli(['--project', dir, 'escalations']);
    for (const s of [
      'Should subscription prices on the subscribe page include VAT?',
      'from master_brain',
      'blocked: plan',
      'friday answer',
    ]) {
      expect(escalations.stdout).toContain(s);
    }
    const diff = await cli(['--project', dir, 'plan', 'diff', '1', '2']);
    expect(diff.stdout).toContain('~ subscribe-page (rework)');
    const calls = await cli(['--project', dir, 'brain', 'calls']);
    expect(calls.stdout).toMatch(/replan\s+claude-opus-5-5\s+ok/);
    expect(calls.stdout).toContain('Total: $');
    const status = await cli(['--project', dir, '--json', 'brain', 'status']);
    expect(JSON.parse(status.stdout)).toMatchObject({ provider: 'fake', planner_available: true });
    const goals = await cli(['--project', dir, 'goals']);
    expect(goals.stdout).toContain('ACTIVE');
  });
});

// ---- the Anthropic provider, end to end against a local stand-in --------------------------------

interface Captured {
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

async function fakeAnthropic(w: TestWorkspace, plan: unknown): Promise<{ url: string; seen: Captured[] }> {
  const seen: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      body += c;
    });
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(body || '{}') as Record<string, unknown>,
      });
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_stand_in_1' });
      res.end(
        JSON.stringify({
          id: 'msg_stand_in',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(plan) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 1500,
            output_tokens: 2500,
            cache_creation_input_tokens: 4000,
            cache_read_input_tokens: 0,
            cache_creation: { ephemeral_5m_input_tokens: 4000, ephemeral_1h_input_tokens: 0 },
          },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  w.track({ close: () => new Promise<void>((r) => server.close(() => r())) });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

/** Credentials planted where planning reads (review F03); none may be sent. */
const SEEDED = {
  anthropic: `sk-ant-api03-${'Qx7'.repeat(12)}`,
  aws: 'AKIAABCDEFGHIJKLMNOP',
  password: 'hunter2-is-not-a-password',
  github: `ghp_${'a1B2'.repeat(9)}`,
  inGoal: `sk-ant-api03-${'Gx5'.repeat(12)}`,
  outside: 'TEXT-FROM-OUTSIDE-THE-PROJECT',
};

function writeConfig(w: TestWorkspace, anthropic: string): void {
  initTestProject(w);
  writeFileSync(
    path.join(w.projectDir, 'README.md'),
    `# shop\nA small shop with one-time checkout.\nOld notes: ANTHROPIC_API_KEY=${SEEDED.anthropic} aws ${SEEDED.aws}\npassword=${SEEDED.password}\n`,
  );
  // docs/ is a junction (Windows) or symlink to a folder outside the project: never read from there.
  const outside = path.join(w.root, 'outside-docs');
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'DECISIONS.md'), `${SEEDED.outside}\n`);
  const link = path.join(w.projectDir, 'docs');
  if (!existsSync(link)) symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  const base = renderInitialConfig(TEST_PROJECT_ID, 'test-project');
  const text = base.replace(
    /\n# The Master Brain[\s\S]*$/,
    `\nmaster_brain:\n  provider: anthropic\n  model: auto\n\nproviders:\n  anthropic:\n${anthropic}\n`,
  );
  writeFileSync(path.join(w.fridayDir, 'config.yaml'), text);
}

async function startWithConfig(w: TestWorkspace) {
  const daemon = await createDaemon({
    projectRoot: w.projectDir,
    stateDir: w.stateDir,
    tickMs: 0,
    pollIntervalMs: 25,
    logToFile: true,
    brain: { autoStart: false },
  });
  w.track({ close: () => daemon.close('test cleanup') });
  return daemon;
}

describe('Anthropic provider through the daemon', () => {
  it('plans only with consent here and a stored key, sends the key only where you chose, and never leaks it', async () => {
    const plan = (JSON.parse(readFileSync(path.join(FIXTURES, '01-plan.json'), 'utf8')) as { output: unknown }).output;
    const api = await fakeAnthropic(ws(), plan);
    // A tracked config that names this endpoint must not receive the user's key (review F03).
    const untrusted = await fakeAnthropic(ws(), plan);
    const dir = ws().projectDir;

    // 1. Remote calls are off: the request is refused before any network call, and a human is asked.
    writeConfig(ws(), `    allow_remote: false\n    base_url: "${untrusted.url}"`);
    const repo = deterministicGit(dir);
    await repo.init();
    await repo.commitAll(`chore: rotate the deploy token ${SEEDED.github}`);
    let daemon = await startWithConfig(ws());
    const created = await cli(['--project', dir, '--json', 'goal', 'create', GOAL_WITH_SECRET(GOAL), '--no-wait']);
    const goalId = (JSON.parse(created.stdout) as GoalDetail).goal.goal_id;
    await cli(['--project', dir, 'brain', 'run-once']);
    expect(api.seen).toHaveLength(0);
    const off = await cli(['--project', dir, 'escalations']);
    expect(off.stdout).toContain('planner_unavailable');
    expect(off.stdout).toContain('allow_remote: true');
    await daemon.close();

    // 2. The project asks for remote planning, but this clone was not allowed on this machine.
    writeConfig(ws(), `    allow_remote: true\n    base_url: "${untrusted.url}"`);
    daemon = await startWithConfig(ws());
    const status = async () =>
      JSON.parse((await cli(['--project', dir, '--json', 'brain', 'status'])).stdout) as {
        key: string;
        planner_available: boolean;
        reason: string;
        approved_here: boolean;
        endpoint: string;
        ignored_base_url: string | null;
        daily_budget_usd: number;
      };
    expect(await status()).toMatchObject({
      planner_available: false,
      approved_here: false,
      reason: expect.stringContaining('friday brain allow-remote'),
      ignored_base_url: untrusted.url,
      endpoint: 'https://api.anthropic.com',
    });
    const allowed = await cli(['--project', dir, 'brain', 'allow-remote', '--budget', '3']);
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(await status()).toMatchObject({
      approved_here: true,
      key: 'missing',
      daily_budget_usd: 3,
      reason: expect.stringContaining('friday secrets set anthropic'),
    });

    // 3. The key is stored for this user with an endpoint chosen here; asking again plans through it.
    const key = `sk-ant-api03-${'Zq9'.repeat(30)}`;
    process.env.FRIDAY_TEST_ANTHROPIC_KEY = key;
    const stored = await cli([
      'secrets',
      'set',
      'anthropic',
      '--from-env',
      'FRIDAY_TEST_ANTHROPIC_KEY',
      '--base-url',
      api.url,
    ]);
    expect(stored.code, stored.stderr).toBe(0);
    expect(stored.stdout).not.toContain(key);
    expect((await cli(['secrets', 'list'])).stdout.trim()).toBe('anthropic');
    const replanned = await cli(['--project', dir, 'goal', 'replan', goalId]);
    expect(replanned.code, replanned.stderr).toBe(0);
    expect(replanned.stdout).toMatch(/proposed plan_\w+ v1 with 4 task/);

    expect(untrusted.seen).toHaveLength(0);
    expect(api.seen).toHaveLength(1);
    const req = api.seen[0] as Captured;
    expect(req.url).toBe('/v1/messages');
    expect(req.headers['x-api-key']).toBe(key);
    expect(req.headers['anthropic-version']).toBeTruthy();
    // Friday's rules first, the repository's text marked as untrusted source material (cached), then the job.
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 16_000,
      output_config: { format: { type: 'json_schema' } },
      system: [{ type: 'text' }, { type: 'text', cache_control: { type: 'ephemeral' } }, { type: 'text' }],
    });
    expect(req.body.temperature).toBeUndefined();
    expect(req.body.tools).toBeUndefined();
    const system = req.body.system as { text: string }[];
    expect(system[0]?.text).toContain('You are the Master Brain of Friday');
    const context = system[1]?.text ?? '';
    expect(context).toContain('<project_context source="repository" trust="untrusted">');
    expect(context).toContain('## README.md');
    expect(context).toContain('one-time checkout');
    expect(system[2]?.text).toContain('Your job now: turn a new goal into the first plan');

    // Outbound boundary (review F03): seeded secrets are masked, a document linked outside the
    // project is not read, and the key itself never appears in the body.
    const body = JSON.stringify(req.body);
    for (const seeded of [
      SEEDED.anthropic,
      SEEDED.aws,
      SEEDED.password,
      SEEDED.github,
      SEEDED.inGoal,
      SEEDED.outside,
    ]) {
      expect(body.includes(seeded), `${seeded} was sent`).toBe(false);
    }
    expect(body).toContain('[REDACTED:');
    expect(context).not.toContain('## docs/DECISIONS.md');
    expect(body.includes(key)).toBe(false);

    const calls = await daemon.state.q.modelCalls(daemon.project.project_id);
    expect(calls[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      status: 'ok',
      remote: true,
      request_id: 'req_stand_in_1',
      input_tokens: 1500,
      cache_creation_input_tokens: 4000,
    });
    // $4/M input, $20/M output, $5/M 5-minute cache writes.
    expect(calls[0]?.cost_usd).toBeCloseTo((1500 * 4 + 2500 * 20 + 4000 * 5) / 1_000_000, 6);

    // The key never reaches the event log, the logs, the database or any output.
    const events = JSON.stringify(daemon.state.store.readSince(daemon.project.project_id, 0, { limit: 10_000 }));
    const logs = readdirSync(path.join(ws().fridayDir, 'logs')).map((f) =>
      readFileSync(path.join(ws().fridayDir, 'logs', f), 'utf8'),
    );
    const db = ['project.db', 'project.db-wal']
      .map((f) => path.join(ws().fridayDir, f))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f).toString('latin1'));
    for (const [where, text] of Object.entries({
      events,
      logs: logs.join('\n'),
      db: db.join('\n'),
      replanned: replanned.stdout,
    })) {
      expect(text.includes(key), `key found in ${where}`).toBe(false);
    }
    expect((await cli(['--project', dir, 'brain', 'deny-remote'])).stdout).toContain('no longer uses');
    expect((await status()).planner_available).toBe(false);
    expect((await cli(['secrets', 'remove', 'anthropic'])).stdout).toContain('Removed');
  });
});
