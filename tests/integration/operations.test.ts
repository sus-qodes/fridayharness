/**
 * The execution gateway and the credential broker (plan M6c, ADR-0029; spec Part 07 §9, Part 12 §5):
 * an agent that asks for the Stripe key is denied, and Friday runs the sandbox test with it instead.
 * The key reaches neither the agent, the events, the logs, the artifacts nor the database.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GenericHarnessClient } from '@friday/adapter-generic';
import type { OperationResult, TaskStartParams, TaskView, VerificationView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const SECRET = `sk_test_51Hfriday${'Zq9'.repeat(10)}`;
const FORMS = [
  SECRET,
  Buffer.from(SECRET).toString('base64'),
  Buffer.from(SECRET).toString('hex'),
  encodeURIComponent(SECRET),
];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ['FRIDAY_STATE_DIR', 'FRIDAY_TEST_STRIPE_KEY', 'OPENAI_API_KEY']) saved[k] = process.env[k];
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
  process.env.FRIDAY_TEST_STRIPE_KEY = SECRET;
  // A provider key in the daemon's own environment: the profile must not pass it on.
  process.env.OPENAI_API_KEY = 'sk-proj-daemonenvironmentkey0123456789';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** Prints the key as written and encoded, and what else reached its environment. */
const STRIPE_TEST = [
  'const k = process.env.STRIPE_SECRET_KEY;',
  "if (!k) { console.error('no key'); process.exit(2); }",
  "console.log('plain', k);",
  "console.log('b64', Buffer.from(k).toString('base64'));",
  "console.error('hex', Buffer.from(k).toString('hex'));",
  "console.log('url', encodeURIComponent(k));",
  "console.log('mode', process.env.STRIPE_MODE);",
  "console.log('friday-vars', Object.keys(process.env).filter((n) => /^fri.ay_/i.test(n)).length);",
  "console.log('provider-keys', ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'].filter((n) => process.env[n]).length);",
  '',
].join('\n');

const OPERATIONS = [
  'operations:',
  '  stripe-test:',
  '    description: Stripe sandbox checkout test',
  '    command: node',
  '    args: ["test/stripe.mjs"]',
  '    env: { STRIPE_MODE: sandbox }',
  '    credentials: { STRIPE_SECRET_KEY: stripe-test }',
  '    roles: [backend]',
  '',
].join('\n');

const taskOf = (td: TestDaemon, id: string) =>
  td.operator.get<{ task: TaskView; verification: VerificationView | null }>(td.operator.projectPath(`/tasks/${id}`));

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A backend agent (a spawn adapter reporting L1) running a task in its own worktree. */
async function agentOnTask(td: TestDaemon, summary: string, n = 1) {
  const fake = await FakeHarness.connect(td, { agentKey: `backend-${n}`, role: 'backend' });
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary,
    kind: 'chore',
    scope: { write: ['notes/**'], read: [] },
    ready: true,
  });
  await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: `backend-${n}` });
  const start = (await fake.waitFor('task.start', 30_000)).params as TaskStartParams;
  await eventually(
    () => taskOf(td, task.task_id),
    (t) => t.task.status === 'RUNNING',
    'the task to run',
  );
  return { client: fake.client, task, run_id: start.run_id, workdir: start.working_directory };
}

async function settle(client: GenericHarnessClient, r: OperationResult): Promise<OperationResult> {
  let res = r;
  for (let i = 0; res.status === 'running' && i < 10; i++) {
    res = await client.call('operation.status', { operation_run_id: res.operation_run_id as string, wait_ms: 20_000 });
  }
  return res;
}

/** Every text Friday keeps about the project: the database, its artifacts, its logs and its state folder. */
function everythingStored(td: TestDaemon): string {
  const db = td.daemon.state.db;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  const parts = tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all()));
  const walk = (dir: string, skip: (p: string) => boolean = () => false): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (skip(p)) continue;
      if (statSync(p).isDirectory()) walk(p, skip);
      else parts.push(readFileSync(p).toString('utf8'));
    }
  };
  walk(path.join(ws().fridayDir, 'artifacts'));
  walk(path.join(ws().fridayDir, 'logs'));
  // The credential store itself holds the key by design (as a DPAPI blob on Windows).
  walk(ws().stateDir, (p) => path.basename(p) === 'credentials');
  return parts.join('\n');
}

describe('execution gateway', () => {
  it('denies the raw secret and runs the trusted, approved operation with it instead (Part 12 §5)', async () => {
    mkdirSync(path.join(ws().projectDir, 'test'), { recursive: true });
    writeFileSync(path.join(ws().projectDir, 'test', 'stripe.mjs'), STRIPE_TEST);
    const td = await startTestDaemon(ws(), { git: true, extraConfig: OPERATIONS });
    const dir = ws().projectDir;
    const { client, task, run_id } = await agentOnTask(td, 'add Stripe subscriptions');

    // The secret is stored for this user: on Windows encrypted with DPAPI.
    const stored = await cli(['secrets', 'set', 'stripe-test', '--from-env', 'FRIDAY_TEST_STRIPE_KEY']);
    expect(stored.code, stored.stderr).toBe(0);
    expect(stored.stdout).not.toContain(SECRET);
    if (process.platform === 'win32') {
      expect(stored.stdout).toContain('DPAPI');
      const blob = readFileSync(path.join(ws().stateDir, 'credentials', 'stripe-test.key'), 'utf8');
      expect(FORMS.some((f) => blob.includes(f))).toBe(false);
    }

    // 1. The agent asks for the key itself: never, and it is pointed at the operation.
    const asked = await client.requestPermission({
      action_class: 'secret.resolve',
      resource: 'STRIPE_SECRET_KEY',
      justification: 'Give me the Stripe secret key so I can test this.',
    });
    expect(asked.status).toBe('denied');
    // Not yet: the operation is repository content nobody trusted on this clone.
    expect(asked.reason).not.toContain('stripe-test');
    const untrusted = await client.call('operation.run', { operation: 'stripe-test', reason: 'test the webhook' });
    expect(untrusted).toMatchObject({ status: 'denied', operation_run_id: null });
    expect(untrusted.reason).toContain('friday policy trust');

    // 2. A human trusts what the project declares, after seeing exactly what the operation runs.
    const shown = await cli(['--project', dir, 'policy', 'trust']);
    expect(shown.stdout).toContain('credentials STRIPE_SECRET_KEY=<secret stripe-test>');
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    const again = await client.requestPermission({
      action_class: 'secret.resolve',
      resource: 'STRIPE_SECRET_KEY',
      justification: 'Give me the Stripe secret key so I can test this.',
    });
    expect(again.status).toBe('denied');
    expect(again.reason).toContain('stripe-test (STRIPE_SECRET_KEY)');
    expect(again.reason).toContain('friday_run_operation');
    const listed = await client.call('operation.list', {});
    expect(listed.operations).toEqual([
      expect.objectContaining({
        name: 'stripe-test',
        risk: 'high',
        needs_approval: true,
        credentials: ['stripe-test'],
      }),
    ]);

    // 3. High risk (it uses a secret): a human approves the run, and sees what the task changed.
    const first = await client.call('operation.run', { operation: 'stripe-test', reason: 'test the webhook' });
    expect(first.status).toBe('approval_required');
    const approvalId = first.approval_id as string;
    const pending = await client.call('operation.run', { operation: 'stripe-test', reason: 'test the webhook' });
    expect(pending).toMatchObject({ status: 'approval_required', approval_id: approvalId });
    const approvals = await cli(['--project', dir, '--json', 'approvals']);
    const approval = (JSON.parse(approvals.stdout) as { approval_id: string; purpose: string }[]).find(
      (a) => a.approval_id === approvalId,
    );
    expect(approval?.purpose).toContain('runs node test/stripe.mjs with stripe-test');
    expect(approval?.purpose).toContain('the task changed no files since its base');
    expect((await cli(['--project', dir, 'approve', approvalId])).code).toBe(0);

    // 4. Friday runs it with the key; the agent gets the outcome and the output without it.
    const done = await settle(
      client,
      await client.call('operation.run', { operation: 'stripe-test', reason: 'test the webhook', run_id }),
    );
    expect(done).toMatchObject({ status: 'passed', exit_code: 0, approval_id: approvalId });
    for (const f of FORMS) expect(done.output).not.toContain(f);
    for (const line of ['plain', 'b64', 'hex', 'url']) expect(done.output).toContain(`${line} [REDACTED:stripe-test]`);
    expect(done.output).toContain('mode sandbox');
    expect(done.output).toContain('friday-vars 0');
    expect(done.output).toContain('provider-keys 0');
    expect(done.redactions).toBeGreaterThanOrEqual(4);

    // The approval was for one run: the next one asks again.
    const next = await client.call('operation.run', { operation: 'stripe-test', reason: 'once more' });
    expect(next.status).toBe('approval_required');
    expect(next.approval_id).not.toBe(approvalId);

    // 5. The record: names, never values; the run is attributable to its task, agent and approval.
    const runs = await cli(['--project', dir, '--json', 'operations', 'runs']);
    const [rec] = (JSON.parse(runs.stdout) as { runs: Record<string, unknown>[] }).runs;
    expect(rec).toMatchObject({
      operation: 'stripe-test',
      task_id: task.task_id,
      status: 'passed',
      credentials: ['stripe-test'],
      approval_id: approvalId,
    });
    // An agent echoing the value afterwards: the event redactor knows it now.
    await client.emitEvent({ task_id: task.task_id, event_type: 'note', summary: `the key is ${SECRET}` });
    const everything = everythingStored(td);
    for (const f of FORMS) expect(everything.includes(f), `stored somewhere: ${f.slice(0, 12)}…`).toBe(false);
    expect(everything).toContain('[REDACTED:stripe-test]');
  }, 120_000);

  it('runs checks in the profile, and verifies claims automatically only once this clone trusts that', async () => {
    const envCheck =
      "console.log('friday-vars', Object.keys(process.env).filter((n) => /^fri.ay_/i.test(n)).length, 'mode', process.env.CHECK_MODE)";
    const checks = [
      '  auto_on_completion: true',
      '  checks:',
      '    - name: env',
      '      command: node',
      `      args: ["-e", ${JSON.stringify(envCheck)}]`,
      '      env: { CHECK_MODE: profile }',
      '    - name: curl',
      '      command: curl',
      '      args: ["--version"]',
      '      required: false',
      '',
    ].join('\n');
    const td = await startTestDaemon(ws(), {
      git: true,
      editConfig: (y) => {
        if (!y.includes('  auto_on_completion: false\n  checks: []\n')) throw new Error('config template changed');
        return y.replace('  auto_on_completion: false\n  checks: []\n', checks);
      },
    });
    const dir = ws().projectDir;
    const claim = async (n: number) => {
      const a = await agentOnTask(td, `task ${n}`, n);
      mkdirSync(path.join(a.workdir, 'notes'), { recursive: true });
      writeFileSync(
        path.join(a.workdir, 'notes', `n${n}.md`),
        `note ${n}
`,
      );
      await a.client.reportResult({
        task_id: a.task.task_id,
        run_id: a.run_id,
        status: 'completed_claim',
        summary: 'done',
        changed_paths: [`notes/n${n}.md`],
        checks: [],
      });
      return a.task.task_id;
    };
    const inspect = (id: string) => taskOf(td, id);
    const status = async (id: string) => (await inspect(id)).task.status;

    // Automatic verification runs agent-written code without a human: it waits for trust.
    const first = await claim(1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await status(first)).toBe('READY_FOR_VERIFICATION');
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);

    const second = await claim(2);
    const s = await eventually(
      () => status(second),
      (x) => x === 'COMPLETED' || x === 'FAILED',
      'the automatic verification',
    );
    expect(s).toBe('COMPLETED');
    const v = await inspect(second);
    const env = v.verification?.checks.find((c) => c.name === 'env');
    expect(env?.status).toBe('PASSED');
    const artifact = (env?.artifact_ref ?? '').replace('artifact:', '');
    const output = readFileSync(path.join(ws().fridayDir, 'artifacts', 'verification', `${artifact}.txt`), 'utf8');
    expect(output).toContain('friday-vars 0 mode profile');
    // A binary off the profile's list fails its check with the reason; advisory, so it passed.
    const curl = v.verification?.checks.find((c) => c.name === 'curl');
    expect(curl?.status).toBe('FAILED');
    expect(curl?.summary).toContain("not on the execution profile's binary list");

    // The claim made before the trust waits for a human, who verifies it as before.
    expect(await status(first)).toBe('READY_FOR_VERIFICATION');
    expect((await cli(['--project', dir, 'verify', first])).code).toBe(0);
    expect(await status(first)).toBe('COMPLETED');
  }, 120_000);
});
