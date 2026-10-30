/**
 * The MVP demonstration (spec Part 12 §18, Part 11 §15; plan M8a) on fixture-shop, deterministic
 * and without a model: two heterogeneous harnesses on one project with one Master Brain.
 * - Claude Code is attached in its task's own worktree through its real Friday MCP server and
 *   hook launcher, started as Claude Code starts them.
 * - Codex works through Friday's Codex adapter against a scripted app-server that speaks the
 *   protocol recorded in M3.5.
 * - A third agent writes the docs.
 * The plan comes from the Master Brain (its fake planner); the change to the shared contract
 * reaches only the agent whose work depends on it; the Codex harness is killed while it works, and
 * recovered; every task is verified by the project's real tests and integrated; the goal branch is
 * verified on its own. The live run with real hosts is manual (docs/integration/mvp-demo.md).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { CodexAdapter } from '@friday/adapter-codex';
import { materializeFixtureShop } from '@friday/cli';
import { createDaemon, type Daemon } from '@friday/daemon';
import { runGit } from '@friday/git';
import type {
  GoalSummary,
  IntegrationView,
  TaskStartParams,
  TaskView,
  UsageReport,
  VerificationView,
} from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import type { TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { decisionOf, hostEnv, runLauncher, toolHook } from '../helpers/hooks.js';

const ws = useTestWorkspace();
const SESSION = 'sess-mvp-claude';
const MCP_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
const PLANS = path.join(REPO_ROOT, 'tests', 'fixtures', 'planner', 'mvp-discounts');
const FAKE_CODEX = path.join(REPO_ROOT, 'tests', 'fixtures', 'codex', 'fake-app-server.mjs');
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

// ---- the work, as the agents write it --------------------------------------------------------

/** The contract the frontend agent changes: a discount code in, the discount out. */
const API_V2 = (v1: string) =>
  v1
    .replace(
      'export interface CheckoutRequest {\n  items: CheckoutItem[];\n}',
      [
        'export interface CheckoutRequest {',
        '  items: CheckoutItem[];',
        '  /** A discount code the customer entered, if any. */',
        '  discountCode?: string;',
        '}',
      ].join('\n'),
    )
    .replace(
      'export interface CheckoutResponse {\n  orderId: string;\n  total: Money;\n}',
      [
        'export interface CheckoutResponse {',
        '  orderId: string;',
        '  total: Money;',
        '  /** What the discount code took off the total. */',
        '  discount?: Money;',
        '}',
      ].join('\n'),
    );

const DISCOUNT_LINE = [
  "import type { Money } from '../../shared/src/api.ts';",
  "import { formatPrice } from './format-price.ts';",
  '',
  '/** The line the checkout page shows for a discount, or none without one. */',
  'export function discountLine(discount: Money | undefined): string | null {',
  '  if (!discount || discount.amount === 0) return null;',
  "  return 'Discount: -' + formatPrice(discount);",
  '}',
  '',
].join('\n');

const DISCOUNT_LINE_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { discountLine } from '../src/discount.ts';",
  '',
  "test('shows the amount saved, and nothing without a discount', () => {",
  "  assert.equal(discountLine({ amount: 250, currency: 'EUR' }), 'Discount: -2.50 EUR');",
  '  assert.equal(discountLine(undefined), null);',
  '});',
  '',
].join('\n');

/** The backend's first draft, before it learns of the contract change. */
const SERVICE_V1 = [
  "import type { Money } from '../../shared/src/api.ts';",
  '',
  'export function applyDiscount(total: Money): Money {',
  '  return total;',
  '}',
  '',
].join('\n');

/** The backend's work once it knows what the contract carries. */
const SERVICE_V2 = [
  "import type { Money } from '../../shared/src/api.ts';",
  '',
  '/** The codes the business defines, as a percentage off. */',
  'const CODES: Record<string, number> = { SAVE10: 10, SAVE25: 25 };',
  '',
  '/** The total after a discount code, in minor units; an unknown code leaves it unchanged. */',
  'export function applyDiscount(total: Money, code?: string): { total: Money; discount: Money } {',
  '  const percent = code ? (CODES[code.toUpperCase()] ?? 0) : 0;',
  '  const off = Math.round((total.amount * percent) / 100);',
  '  return { total: { amount: total.amount - off, currency: total.currency }, discount: { amount: off, currency: total.currency } };',
  '}',
  '',
].join('\n');

const SERVICE_TEST = [
  "import assert from 'node:assert/strict';",
  "import { test } from 'node:test';",
  "import { applyDiscount } from '../src/discount.ts';",
  '',
  "test('a known code lowers the total, case-insensitively; an unknown one does not', () => {",
  "  assert.deepEqual(applyDiscount({ amount: 1000, currency: 'EUR' }, 'save10').total, { amount: 900, currency: 'EUR' });",
  "  assert.deepEqual(applyDiscount({ amount: 1000, currency: 'EUR' }, 'NOPE').total, { amount: 1000, currency: 'EUR' });",
  '});',
  '',
].join('\n');

const README_NOTE =
  '\n## Discount codes\n\n`SAVE10` takes 10% and `SAVE25` takes 25% off the checkout total; an unknown code changes nothing.\n';

// ---- helpers ---------------------------------------------------------------------------------

const text = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const size = (f: string) => (existsSync(f) ? statSync(f).size : 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function eventually<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${String(JSON.stringify(v)).slice(0, 400)}`);
    await sleep(50);
  }
}

function wrap(daemon: Daemon): TestDaemon {
  const base = { baseUrl: daemon.url, projectId: daemon.project.project_id };
  return {
    daemon,
    url: daemon.url,
    project: daemon.project,
    operator: new DaemonClient({ ...base, token: daemon.tokens.operator, tokenClass: 'operator' }),
    bootstrap: new DaemonClient({ ...base, token: daemon.tokens.bootstrap, tokenClass: 'bootstrap' }),
    ws: ws(),
  };
}

interface GoalDetail {
  goal: { goal_id: string; status: string };
  proposed: { tasks: { key: string; role: string | null }[] } | null;
  active: { tasks: { key: string; task_id: string | null; status: string | null; agent_key?: string | null }[] } | null;
  /** What Friday did for the goal, from its records (plan M12.7). */
  summary: GoalSummary;
}

/** The Codex adapter, its host scripted; started again on the same folder, it is the same harness. */
function codexAgent(td: TestDaemon, dir: string) {
  const script = {
    turns: [
      [
        { op: 'write', path: 'backend/src/discount.ts', text: SERVICE_V1 },
        // A long test run: the work the harness is doing when it is killed.
        { op: 'command', command: 'node --test', long: true },
      ],
    ],
    resume: [
      { op: 'write', path: 'backend/src/discount.ts', text: SERVICE_V2 },
      { op: 'write', path: 'backend/test/discount.test.ts', text: SERVICE_TEST },
      { op: 'command', command: 'node --test' },
      {
        op: 'final',
        status: 'completed',
        summary: 'discount codes applied in the checkout service, from the new contract',
        changed_paths: ['backend/src/discount.ts', 'backend/test/discount.test.ts'],
      },
    ],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
  const log = path.join(dir, 'log.jsonl');
  const adapter = new CodexAdapter({
    bootstrap: td.bootstrap,
    projectId: td.project.project_id,
    agentKey: 'cx-1',
    role: 'backend',
    harnessKey: `codex:${td.project.project_id}:cx-1`,
    host: { command: process.execPath, args: [FAKE_CODEX], version: '0.162.1' },
    hostEnv: {
      ...process.env,
      FAKE_CODEX_SCRIPT: path.join(dir, 'script.json'),
      FAKE_CODEX_LOG: log,
      FAKE_CODEX_WORK: path.join(dir, 'work'),
    },
    sandbox: 'workspace-write',
  });
  ws().track({ close: () => adapter.close() });
  const entries = (): Record<string, unknown>[] =>
    existsSync(log)
      ? text(log)
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  return { adapter, entries, workFile: (taskId: string) => path.join(dir, 'work', `${taskId}.work`) };
}

/** An attached Claude Code session in `root`: its hooks and its Friday MCP server, as Claude Code runs them. */
async function claudeSession(root: string) {
  const env = { CLAUDE_PROJECT_DIR: root, FRIDAY_STATE_DIR: ws().stateDir };
  const hookFile = path.join(root, '.friday', 'harness', 'claude-code', 'hook.mjs');
  const vars = { projectDir: root, sessionId: SESSION };
  const hook = async (event: string, input: Record<string, unknown>) => {
    const run = await runLauncher(
      hookFile,
      event,
      { session_id: SESSION, cwd: root, hook_event_name: event, ...input },
      env,
    );
    expect(run.code, run.stderr).toBe(0);
    return run;
  };
  const mcpJson = JSON.parse(text(path.join(root, '.mcp.json'))) as {
    mcpServers: { friday: { args: string[]; env: Record<string, string> } };
  };
  const entry = mcpJson.mcpServers.friday;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: entry.args,
    cwd: root,
    env: hostEnv({ ...entry.env, ...env, FRIDAY_MCP_ENTRY: MCP_ENTRY, CLAUDE_CODE_SESSION_ID: SESSION }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'claude-code', version: '2.1.300' });
  await client.connect(transport);
  ws().track({ close: () => client.close() });
  const mcp = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: Array<{ text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const t = (res.content ?? []).map((c) => c.text ?? '').join('\n');
    expect(res.isError, `${name}: ${t}`).toBeFalsy();
    return { text: t, structured: res.structuredContent ?? {} };
  };
  /** A tool call as Claude Code makes it: Friday decides first; an allowed edit happens, then is reported. */
  const tool = async (name: string, input: Record<string, unknown>, act?: () => void) => {
    const pre = decisionOf((await hook('PreToolUse', toolHook('PreToolUse', name, input, vars))).json);
    if (pre && pre.decision !== 'allow') return pre;
    act?.();
    await hook('PostToolUse', toolHook('PostToolUse', name, input, vars, { tool_response: { success: true } }));
    return { decision: 'allow', reason: '' };
  };
  const write = (rel: string, content: string) =>
    tool('Write', { file_path: path.join(root, rel), content }, () => {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), content);
    });
  return { hook, mcp, tool, write };
}

const verify = (td: TestDaemon, id: string) =>
  td.operator.post<{ task: TaskView; verification: VerificationView }>(
    td.operator.projectPath(`/tasks/${id}/verify`),
    {},
    { timeoutMs: 120_000 },
  );

const integrationOf = (td: TestDaemon, taskId: string) =>
  eventually(
    () => td.daemon.state.q.latestIntegration(td.project.project_id, taskId),
    (i): i is IntegrationView => i !== undefined,
    `the integration of ${taskId}`,
    60_000,
  ) as Promise<IntegrationView>;

const coordinate = async (td: TestDaemon) => {
  await td.operator.post(td.operator.projectPath('/brain/run-once'), {});
  await td.operator.post(td.operator.projectPath('/brain/run-once'), {});
};

describe('the MVP demonstration (Part 12 §18)', () => {
  it('two harnesses, one Master Brain: plan → parallel worktrees → packets → a contract change routed → tests → a harness killed and recovered → verified, integrated goal', async () => {
    // 1. Friday on a real repository, with short leases so a lost harness is noticed in seconds.
    const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
    appendFileSync(
      path.join(root, '.friday', 'config.yaml'),
      [
        '',
        'leases:',
        '  heartbeat_interval_ms: 1000',
        '  lease_ttl_ms: 3000',
        '  reconnect_window_ms: 60000',
        'master_brain:',
        '  provider: fake',
        `  fake_responses: ${JSON.stringify(PLANS)}`,
        '',
      ].join('\n'),
    );
    const friday = (...args: string[]) => cli(['--project', root, ...args]);
    // Claude Code's Friday files, committed, so every worktree carries the hook launcher.
    const configured = await friday('harness', 'config', 'claude-code', '--agent', 'fe-1');
    expect(configured.code, configured.stderr).toBe(0);
    await deterministicGit(root, { startEpoch: 1_767_300_000 }).commitAll('Friday for Claude Code');
    const daemon = await createDaemon({
      projectRoot: root,
      stateDir: ws().stateDir,
      tickMs: 0,
      pollIntervalMs: 25,
      logToFile: true,
      extensions: [claudeCodeHooks()],
      brain: { autoStart: false },
    });
    ws().track({ close: () => daemon.close('test cleanup') });
    const td = wrap(daemon);
    const op = td.operator;
    const pid = td.project.project_id;

    // 2–3. Harness B (Codex, through Friday's adapter) and a docs agent register.
    const codexDir = path.join(ws().root, 'codex');
    const codex = codexAgent(td, codexDir);
    await codex.adapter.start();
    const docs = await FakeHarness.connect(td, { agentKey: 'dc-1', role: 'docs' });
    docs.client.startHeartbeat();
    ws().track({ close: () => docs.close() });

    // 4–5. A complex request: the Master Brain plans it; a human approves the plan.
    const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), {
      request: 'Add discount codes to checkout: the backend applies a code, the frontend shows the discount',
    });
    await coordinate(td);
    const shown = await friday('plan', '--goal', goal.goal_id);
    expect(shown.code, shown.stderr).toBe(0);
    for (const key of ['discount-contract', 'discount-service', 'discount-docs']) expect(shown.stdout).toContain(key);
    const proposed = await op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    expect(proposed.proposed?.tasks.map((t) => [t.key, t.role])).toEqual([
      ['discount-contract', 'frontend'],
      ['discount-service', 'backend'],
      ['discount-docs', 'docs'],
    ]);
    const approved = await friday('plan', 'approve');
    expect(approved.code, approved.stderr).toBe(0);
    const detail = () => op.get<GoalDetail>(op.projectPath(`/goals/${goal.goal_id}`));
    const ids = Object.fromEntries(
      ((await detail()).active?.tasks ?? []).map((t) => [t.key, t.task_id as string]),
    ) as Record<'discount-contract' | 'discount-service' | 'discount-docs', string>;
    const branch = `friday/goal-${goal.goal_id}`;

    // Harness A: Claude Code, started by a human in the frontend task's own worktree.
    const made = await op.post<{ worktree: { path: string } }>(
      op.projectPath(`/tasks/${ids['discount-contract']}/worktree`),
      {},
    );
    const front = made.worktree.path;
    const claude = await claudeSession(front);
    const started = await claude.hook('SessionStart', { source: 'startup' });
    expect(started.stdout).toContain('<friday-context');

    // 6. Two harnesses, three agents, three tasks at once, each in its own worktree.
    await coordinate(td);
    const claim = await claude.mcp('friday_task_claim', { task_id: ids['discount-contract'] });
    expect((claim.structured.task as { task_id: string }).task_id).toBe(ids['discount-contract']);
    const docsStart = (await docs.waitFor('task.start', 30_000)).params as TaskStartParams;
    expect(docsStart.task_id).toBe(ids['discount-docs']);
    await eventually(
      () =>
        [ids['discount-contract'], ids['discount-service'], ids['discount-docs']].map(
          (t) => daemon.state.q.task(pid, t).status,
        ),
      (s) => s.every((x) => x === 'RUNNING'),
      'the three tasks to run',
    );
    const checkoutOf = (t: string) =>
      daemon.state.q.findRun(daemon.state.q.task(pid, t).current_run_id as string)?.execution_root as string;
    const back = checkoutOf(ids['discount-service']);
    expect(new Set([front, back, checkoutOf(ids['discount-docs'])]).size).toBe(3);
    expect(checkoutOf(ids['discount-contract'])).toBe(front);

    // 7. Each agent's own compiled context names its task, and on request what its task touches and
    // what depends on it (plan M14.7: the first packet names no files).
    for (const key of ['discount-service', 'discount-contract'] as const) {
      const explained = await friday('context', 'explain', ids[key]);
      expect(explained.code, explained.stderr).toBe(0);
      expect(explained.stdout).toContain('Files: none related through the code graph.');
      const files = await friday('context', 'explain', ids[key], '--files');
      expect(files.code, files.stderr).toBe(0);
      expect(files.stdout).toContain('shared/src/api.ts');
    }
    // Codex got its packet as its thread's instructions, in its own worktree; Claude Code with its claim.
    const thread = codex.entries().find((e) => e.request === 'thread/start')?.params as {
      developerInstructions: string;
      cwd: string;
    };
    expect(thread.developerInstructions).toContain(ids['discount-service']);
    expect(path.resolve(thread.cwd)).toBe(path.resolve(back));
    expect(JSON.stringify(claim.structured)).toContain('shared/src/api.ts');

    // 8. Claude Code changes the shared contract: its first write takes the contract's reservation.
    const apiFile = path.join(front, 'shared', 'src', 'api.ts');
    const v1 = text(apiFile);
    const edited = await claude.tool(
      'Edit',
      {
        file_path: apiFile,
        old_string: 'items: CheckoutItem[];',
        new_string: 'items: CheckoutItem[];\n  discountCode?: string;',
      },
      () => writeFileSync(apiFile, API_V2(v1)),
    );
    expect(edited.decision).toBe('allow');
    expect(text(apiFile)).toContain('discountCode?: string;');
    const reserved = await op.get<{ reservations: { task_id: string; pattern: string }[] }>(
      op.projectPath('/file-reservations'),
    );
    expect(reserved.reservations.map((r) => [r.task_id, r.pattern])).toEqual([
      [ids['discount-contract'], 'shared/src/api.ts'],
    ]);
    expect((await claude.write('frontend/src/discount.ts', DISCOUNT_LINE)).decision).toBe('allow');
    expect((await claude.write('frontend/test/discount.test.ts', DISCOUNT_LINE_TEST)).decision).toBe('allow');
    // Outside its scope, nothing happens.
    expect((await claude.write('backend/src/shortcut.ts', 'export {};\n')).decision).toBe('deny');
    expect(existsSync(path.join(front, 'backend', 'src', 'shortcut.ts'))).toBe(false);

    // 9. The change is routed to the agent whose work depends on the contract, and to no one else.
    const sent = await claude.mcp('friday_communicate', {
      to: 'role:backend',
      mode: 'notification',
      subject: 'the checkout contract changed',
      content: 'CheckoutRequest has discountCode; CheckoutResponse has discount (Money, in minor units).',
      facts: [
        {
          fact: 'CheckoutRequest.discountCode is optional',
          area: 'shared/src/api.ts',
          impact: 'the checkout service applies it',
        },
      ],
    });
    const messageId = sent.structured.message_id as string;
    const message = () =>
      op.get<{ deliveries: { agent_key: string | null; state: string }[] }>(op.projectPath(`/messages/${messageId}`));
    expect((await message()).deliveries.map((d) => d.agent_key)).toEqual(['cx-1']);
    // Codex receives it in its running turn, as a colleague's information, and acknowledges it.
    const steer = (await eventually(
      () => codex.entries().find((e) => e.request === 'turn/steer'),
      (e) => Boolean(e),
      'the notice in the Codex turn',
    )) as { params: { input: { text: string }[] } };
    expect(steer.params.input[0]?.text).toContain('CheckoutRequest has discountCode');
    await eventually(message, (m) => m.deliveries.every((d) => d.state === 'acknowledged'), 'the acknowledgement');
    expect((await op.get<{ items: unknown[] }>(op.projectPath('/inbox/dc-1'))).items).toEqual([]);

    // 10. Tests: Claude Code runs them, keeps a decision for the others, and claims its work.
    expect((await claude.tool('Bash', { command: 'node --test "**/test/*.test.ts"' })).decision).toBe('allow');
    const ran = spawnSync(process.execPath, ['--test', '**/test/*.test.ts'], { cwd: front, encoding: 'utf8' });
    expect(ran.status, `${ran.stdout}\n${ran.stderr}`).toBe(0);
    await claude.mcp('friday_remember', {
      kind: 'decision',
      subject: 'discount codes',
      content: 'Discount codes are case-insensitive, and a discount is a percentage of the total in minor units.',
    });
    await claude.mcp('friday_claim_done', {
      summary: 'a discount code in the contract; the checkout client shows the discount line',
      changed_paths: ['shared/src/api.ts', 'frontend/src/discount.ts', 'frontend/test/discount.test.ts'],
      checks: [{ name: 'tests', kind: 'test', command: 'node --test', outcome: 'passed' }],
    });
    expect(daemon.state.q.task(pid, ids['discount-contract']).status).toBe('READY_FOR_VERIFICATION');

    // 11. The Codex harness is killed while it works: its work stops with it, and its lease runs out.
    const service = ids['discount-service'];
    const run1 = daemon.state.q.task(pid, service).current_run_id as string;
    await eventually(
      () => size(codex.workFile(service)),
      (n) => n > 5,
      'Codex at work',
    );
    await codex.adapter.crash();
    const settled = size(codex.workFile(service));
    await sleep(300);
    expect(size(codex.workFile(service))).toBe(settled);
    await sleep(3500);
    daemon.tick();
    expect(daemon.state.q.task(pid, service).status).toBe('HARNESS_LOST');
    // The other harness and the docs agent keep their leases and their work.
    expect(daemon.state.q.task(pid, ids['discount-docs']).status).toBe('RUNNING');
    expect(daemon.state.q.task(pid, ids['discount-contract']).status).toBe('READY_FOR_VERIFICATION');

    // 12. Recovery: Friday's assessment, then the same harness back within its window resumes the run.
    const assessed = await friday('recover', service);
    expect(assessed.code, assessed.stderr).toBe(0);
    expect(assessed.stdout).toContain('reconnect');
    const restarted = codexAgent(td, codexDir);
    await restarted.adapter.start();
    const resumeMsg = await eventually(
      () => restarted.adapter.received.find((m) => m.method === 'task.resume'),
      (m) => Boolean(m),
      'task.resume',
    );
    const resume = { params: (resumeMsg?.params ?? {}) as TaskStartParams };
    expect(resume.params).toMatchObject({ task_id: service, run_id: run1 });
    await eventually(
      () => daemon.state.q.task(pid, service).status,
      (x) => x === 'READY_FOR_VERIFICATION',
      'the Codex claim after recovery',
    );
    const resumed = restarted.entries().find((e) => e.request === 'thread/resume')?.params as { threadId: string };
    expect(resumed.threadId).toBe(resume.params.session_ref);
    expect(daemon.state.q.task(pid, service).current_run_id).toBe(run1);

    // 13. The docs agent finishes too.
    const readme = path.join(docsStart.working_directory, 'README.md');
    writeFileSync(readme, text(readme) + README_NOTE);
    await docs.client.reportResult({
      task_id: docsStart.task_id,
      run_id: docsStart.run_id,
      status: 'completed_claim',
      summary: 'discount codes documented',
      changed_paths: ['README.md'],
    });

    // 14. Verification: each task by the project's real tests in its own worktree, then integration.
    for (const key of ['discount-contract', 'discount-service', 'discount-docs'] as const) {
      const v = await verify(td, ids[key]);
      expect(v.task.status, JSON.stringify(v.verification.checks).slice(0, 1500)).toBe('COMPLETED');
      expect(v.verification.checks.find((c) => c.name === 'tests')?.status).toBe('PASSED');
      expect((await integrationOf(td, ids[key])).status).toBe('integrated');
    }

    // 15. The goal is verified: its branch, checked out on its own, passes the tests and holds every change.
    await coordinate(td);
    await eventually(detail, (d) => d.goal.status === 'COMPLETED', 'the goal to complete');
    const where = path.join(ws().root, 'goal-check');
    await runGit(root, ['worktree', 'add', '-q', '--detach', where, branch]);
    try {
      const r = spawnSync(process.execPath, ['--test', '**/test/*.test.ts'], { cwd: where, encoding: 'utf8' });
      expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
      expect(text(path.join(where, 'shared', 'src', 'api.ts'))).toContain('discountCode?: string;');
      expect(text(path.join(where, 'frontend', 'src', 'discount.ts'))).toContain('discountLine');
      expect(text(path.join(where, 'backend', 'src', 'discount.ts'))).toContain('SAVE10');
      expect(text(path.join(where, 'README.md'))).toContain('## Discount codes');
    } finally {
      await runGit(root, ['worktree', 'remove', '--force', where]).catch(() => undefined);
    }
    // The main checkout is untouched.
    expect((await runGit(root, ['status', '--porcelain'])).stdout.trim()).toBe('');

    // 16. What the project keeps: the decision, the models that ran, and the checks' output.
    const remembered = await friday('memory', 'search', 'discount');
    expect(remembered.code, remembered.stderr).toBe(0);
    expect(remembered.stdout).toContain('case-insensitive');
    const ranModel = daemon.state.q.findRun(run1)?.model_observed;
    expect(ranModel).toBeTruthy();
    const models = await friday('models');
    expect(models.code, models.stderr).toBe(0);
    expect(models.stdout).toContain(ranModel as string);
    const kept = daemon.state.q.latestVerification(service)?.checks.find((c) => c.name === 'tests');
    expect(kept?.artifact_ref).toMatch(/^artifact:/);

    // 17. The token baseline (plan M10a): one usage row per attempt of the goal, from Friday's own
    // log. Of the three hosts, the Codex thread alone counts what it spent, and its adapter records
    // the host's last count with the claim (plan M11.4); the attached session and the plain harness
    // report nothing, so their host fields are unknown, never 0. What Friday saw itself (the packets
    // it delivered, the tool calls it judged, the verdict) is complete for every row.
    const usage = await friday('usage', '--goal', goal.goal_id, '--json');
    expect(usage.code, usage.stderr).toBe(0);
    const report = JSON.parse(usage.stdout) as UsageReport;
    const attempts = Object.values(ids).flatMap((t) => daemon.state.q.attemptsOf(t).map((r) => r.run_id));
    expect(report.rows.map((r) => r.run_id).sort()).toEqual([...attempts].sort());
    // Each task ran once: the Codex attempt was resumed after the crash, not started again.
    expect(report.rows).toHaveLength(3);
    const rowOf = (key: keyof typeof ids) => {
      const row = report.rows.find((r) => r.task_id === ids[key]);
      if (!row) throw new Error(`no usage row for ${key}`);
      return row;
    };
    for (const row of report.rows) {
      expect(row).toMatchObject({ goal_id: goal.goal_id, attempt: 1, verification: { status: 'PASSED' } });
      expect(row.verification?.checks_passed).toBeGreaterThanOrEqual(1);
      expect(row.verification?.checks_total).toBeGreaterThanOrEqual(row.verification?.checks_passed ?? 0);
      // Verified attempts have ended.
      expect(row.ended_at).not.toBeNull();
      expect(row.duration_ms).not.toBeNull();
    }
    /** A host that said nothing about what it spent. */
    const unknownHost = {
      reported: false,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cost_usd: null,
      turns: null,
      model: null,
    };
    // Claude Code's claim delivered its packet; its edits and its test run came through Friday's
    // hooks (the denied write never ran, so it is not a call); an attached session reports no spend.
    const contract = rowOf('discount-contract');
    expect(contract).toMatchObject({
      agent_key: 'fe-1',
      harness_vendor: 'claude-code',
      harness_mode: 'attach',
      host: unknownHost,
    });
    expect(contract.packets.count).toBeGreaterThanOrEqual(1);
    expect(contract.packets.tokens).toBeGreaterThan(0);
    expect(contract.tool_calls.total).toBeGreaterThan(0);
    expect(contract.tool_calls.by_kind.edit).toBeGreaterThanOrEqual(3);
    expect(contract.tool_calls.by_kind.shell).toBeGreaterThanOrEqual(1);
    // Codex asked Friday for its packet as its thread began; the adapter reported its file changes
    // and commands, before the crash and after the resume, against the one run.
    const serviceRow = rowOf('discount-service');
    expect(serviceRow).toMatchObject({
      run_id: run1,
      agent_key: 'cx-1',
      harness_vendor: 'codex',
      harness_mode: 'spawn',
      model_observed: ranModel,
    });
    expect(serviceRow.packets.count).toBeGreaterThanOrEqual(1);
    expect(serviceRow.packets.tokens).toBeGreaterThan(0);
    expect(serviceRow.tool_calls.total).toBeGreaterThan(0);
    expect(serviceRow.tool_calls.by_kind.edit).toBeGreaterThanOrEqual(2);
    expect(serviceRow.tool_calls.by_kind.shell).toBeGreaterThanOrEqual(1);
    // What the Codex thread cost, as its host counted it (plan M11.4): the `total` of the last token
    // count the resumed app-server sent before the turn ended (the thread's count so far, which the
    // scripted host carries across the resume), the one turn the adapter started after the restart
    // (the turn the first adapter ran ended with it, before any report), and the model the thread
    // reported; the app-server names no cost. The scripted host logs every count it sends.
    const counted = restarted
      .entries()
      .filter((e) => e.tokenUsage)
      .at(-1)?.tokenUsage as Record<string, number>;
    expect(counted.inputTokens).toBeGreaterThan(0);
    expect(serviceRow.host).toMatchObject({
      reported: true,
      input_tokens: counted.inputTokens,
      output_tokens: counted.outputTokens,
      cache_read_input_tokens: counted.cachedInputTokens,
      cache_creation_input_tokens: counted.cacheWriteInputTokens,
      cost_usd: null,
      turns: 1,
      model: ranModel,
    });
    // The docs agent asked for nothing, reported no tool call and no spend: nothing is made up for it.
    expect(rowOf('discount-docs')).toMatchObject({
      agent_key: 'dc-1',
      harness_vendor: 'generic',
      host: unknownHost,
      packets: { count: 0, tokens: 0, chars: null, source_tokens: 0 },
      tool_calls: { total: 0, failed: 0 },
    });
    // The totals sum the one host that reported, and say so per field; no host named a cost.
    expect(report.totals).toMatchObject({
      attempts: 3,
      host_reported: 1,
      reporters: {
        input_tokens: 1,
        output_tokens: 1,
        cache_read_input_tokens: 1,
        cache_creation_input_tokens: 1,
        cost_usd: 0,
      },
      input_tokens: counted.inputTokens,
      output_tokens: counted.outputTokens,
      cache_read_input_tokens: counted.cachedInputTokens,
      cache_creation_input_tokens: counted.cacheWriteInputTokens,
      cost_usd: null,
      tool_calls: contract.tool_calls.total + serviceRow.tool_calls.total,
    });

    // 18. What Friday did for the goal (plan M12.7), counted from the records above: every task
    // verified at its first claim; the write outside Claude Code's scope refused by policy; the
    // Codex session lost and resumed; the tokens the one host that counted them reported, from one
    // of three attempts, and no cost since no host named one; the planner's calls for the plan.
    const did = (await detail()).summary;
    expect(did).toMatchObject({
      tasks: { total: 3, verified: 3 },
      claims_refused: 0,
      reworked: 0,
      held_for_human: 0,
      refused_by_policy: 1,
      sessions_lost: 1,
      sessions_recovered: 1,
      hosts: {
        attempts: 3,
        reported: 1,
        tokens: Number(counted.inputTokens) + Number(counted.outputTokens),
        tokens_reporters: 1,
        cost_usd: null,
        cost_reporters: 0,
      },
    });
    expect(did.planning.calls).toBeGreaterThanOrEqual(1);
    const line = await friday('goal', 'show', goal.goal_id);
    expect(line.code, line.stderr).toBe(0);
    expect(line.stdout).toContain('tasks verified: 3 of 3');
    expect(line.stdout).toContain('actions refused by policy: 1');
    expect(line.stdout).toContain('sessions lost: 1, recovered');
    expect(line.stdout).toMatch(/hosts reported: \S+ tokens \(1 of 3 attempts\)\r?\n/);
  });
});
