/**
 * The M1 demo (plan M1.14) on fixture-shop, deterministic and without a model: the real
 * `friday-mcp` started through the committed launch-mcp.mjs, and the real hook launcher, both
 * children of this process exactly as they are children of Claude Code. The live run of the same
 * steps with Claude Code is manual (docs/integration/claude-code.md).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import { materializeFixtureShop } from '@friday/cli';
import { createDaemon, type Daemon } from '@friday/daemon';
import type { TaskView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { decisionOf, hostEnv, runLauncher, toolHook } from '../helpers/hooks.js';

const ws = useTestWorkspace();
const SESSION = 'sess-shop-1';
const MCP_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

const DISCOUNT = `import type { Money } from '../../../shared/src/api.ts';

const PERCENT_OFF: Record<string, number> = { SAVE10: 10 };

/** Applies a discount code (case-insensitive); unknown codes leave the total unchanged. */
export function applyDiscount(total: Money, code: string): Money {
  const percent = PERCENT_OFF[code.trim().toUpperCase()];
  if (percent === undefined) return total;
  return { amount: total.amount - Math.floor((total.amount * percent) / 100), currency: total.currency };
}
`;
const BROKEN_DISCOUNT = `import type { Money } from '../../../shared/src/api.ts';

export function applyDiscount(total: Money, _code: string): Money {
  return total;
}
`;
const DISCOUNT_TEST = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscount } from '../src/pricing/discount.ts';

test('SAVE10 takes 10% off, rounding the discount down', () => {
  assert.deepEqual(applyDiscount({ amount: 1999, currency: 'EUR' }, 'SAVE10'), { amount: 1800, currency: 'EUR' });
});

test('codes are case-insensitive', () => {
  assert.deepEqual(applyDiscount({ amount: 1000, currency: 'EUR' }, 'save10'), { amount: 900, currency: 'EUR' });
});

test('unknown codes leave the total unchanged', () => {
  assert.deepEqual(applyDiscount({ amount: 1000, currency: 'EUR' }, 'NOPE'), { amount: 1000, currency: 'EUR' });
});
`;

interface Shop {
  root: string;
  daemon: Daemon;
  operator: DaemonClient;
  bootstrap: DaemonClient;
  write(rel: string, text: string): void;
  git: ReturnType<typeof deterministicGit>;
}

async function startShop(): Promise<Shop> {
  const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
  const daemon = await createDaemon({
    projectRoot: root,
    stateDir: ws().stateDir,
    tickMs: 0,
    pollIntervalMs: 25,
    logToFile: true,
    extensions: [claudeCodeHooks()],
  });
  ws().track({ close: () => daemon.close('test cleanup') });
  const base = { baseUrl: daemon.url, projectId: daemon.project.project_id };
  return {
    root,
    daemon,
    operator: new DaemonClient({ ...base, token: daemon.tokens.operator, tokenClass: 'operator' }),
    bootstrap: new DaemonClient({ ...base, token: daemon.tokens.bootstrap, tokenClass: 'bootstrap' }),
    write(rel, text) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), text);
    },
    git: deterministicGit(root),
  };
}

async function createDiscountTask(shop: Shop): Promise<TaskView> {
  const res = await cli([
    '--project',
    shop.root,
    '--json',
    'task',
    'create',
    'Add discount-code support to pricing',
    '--description',
    'frontend/src/pricing/discount.ts: applyDiscount(total: Money, code: string): Money. SAVE10 takes 10% off.',
    '--criteria',
    'node --test passes',
    '--criteria',
    'codes are case-insensitive',
    '--scope-write',
    'frontend/src/pricing/**',
    '--scope-write',
    'frontend/test/**',
    '--scope-read',
    'frontend/**',
    '--scope-read',
    'shared/**',
    '--assign',
    'dev-1',
    '--ready',
  ]);
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as TaskView;
}

const transitions = async (shop: Shop, taskId: string) =>
  (
    await shop.operator.get<{
      events: Array<{ type: string; payload: { transition?: { from: string; to: string } } }>;
    }>(shop.operator.projectPath(`/tasks/${taskId}/events`))
  ).events
    .filter((e) => e.type.startsWith('task.') && e.payload.transition)
    .map((e) => `${e.type} ${e.payload.transition?.from}->${e.payload.transition?.to}`);

describe('fixture-shop M1 demo', () => {
  it('runs the Claude Code attach flow from harness config to a verified completion, with nothing secret leaking', async () => {
    const shop = await startShop();
    const config = await cli(['--project', shop.root, 'harness', 'config', 'claude-code', '--agent', 'dev-1']);
    expect(config.code, config.stderr).toBe(0);
    const task = await createDiscountTask(shop);
    expect(task).toMatchObject({ status: 'READY', reserved_for_agent_key: 'dev-1' });

    // What Claude Code would start: hooks from the committed launcher, friday-mcp from the committed .mcp.json entry.
    const hookFile = path.join(shop.root, '.friday', 'harness', 'claude-code', 'hook.mjs');
    const hookEnv = { CLAUDE_PROJECT_DIR: shop.root, FRIDAY_STATE_DIR: ws().stateDir };
    const outputs: string[] = [];
    const hook = async (event: string, input: Record<string, unknown>) => {
      const run = await runLauncher(
        hookFile,
        event,
        { session_id: SESSION, cwd: shop.root, hook_event_name: event, ...input },
        hookEnv,
      );
      expect(run.code, run.stderr).toBe(0);
      outputs.push(run.stdout);
      return run;
    };
    const vars = { projectDir: shop.root, sessionId: SESSION };
    const pre = async (tool: string, input: Record<string, unknown>) =>
      decisionOf((await hook('PreToolUse', toolHook('PreToolUse', tool, input, vars))).json);
    const post = (tool: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      hook('PostToolUse', toolHook('PostToolUse', tool, input, vars, extra));

    const mcpJson = JSON.parse(readFileSync(path.join(shop.root, '.mcp.json'), 'utf8')) as {
      mcpServers: { friday: { command: string; args: string[]; env: Record<string, string> } };
    };
    const entry = mcpJson.mcpServers.friday;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: entry.args,
      cwd: shop.root,
      env: hostEnv({ ...entry.env, ...hookEnv, FRIDAY_MCP_ENTRY: MCP_ENTRY, CLAUDE_CODE_SESSION_ID: SESSION }),
      stderr: 'pipe',
    });
    // Introduces itself the way Claude Code does, so friday-mcp reports the host version (review F09).
    const client = new Client({ name: 'claude-code', version: '2.1.296' });
    await client.connect(transport);
    ws().track({ close: () => client.close() });
    const mcp = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as {
        content?: Array<{ text?: string }>;
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
      outputs.push(text, JSON.stringify(res.structuredContent ?? {}));
      expect(res.isError, `${name}: ${text}`).toBeFalsy();
      return { text, structured: res.structuredContent ?? {} };
    };

    const start = await hook('SessionStart', { source: 'startup' });
    expect(start.stdout).toContain('<friday-context');
    expect(start.stdout).toContain(task.task_id);

    let who = await mcp('friday_whoami');
    for (let i = 0; i < 100 && !who.structured.harness_id; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      who = await mcp('friday_whoami');
    }
    expect(who.structured).toMatchObject({
      agent_key: 'dev-1',
      link_status: 'linked',
      // Earned: the session's hooks reached the daemon from a host that blocks on hook failure.
      enforcement_level: 'L1',
      enforcement_status: 'enforcing',
      shadow: false,
    });

    const claim = await mcp('friday_task_claim', { next: true });
    expect(claim.text).toContain('<friday-context');
    expect(claim.text).toContain('frontend/src/pricing/**');

    // The agent's work, with every tool call passing through the hooks.
    for (const [rel, text] of [
      ['frontend/src/pricing/discount.ts', DISCOUNT],
      ['frontend/test/discount.test.ts', DISCOUNT_TEST],
    ] as const) {
      const file = path.join(shop.root, rel);
      expect(await pre('Write', { file_path: file, content: text })).toBeNull();
      shop.write(rel, text);
      await post('Write', { file_path: file, content: text }, { tool_response: { type: 'create', filePath: file } });
    }
    expect(
      await pre('Edit', {
        file_path: path.join(shop.root, 'backend', 'src', 'checkout.service.ts'),
        old_string: 'import',
        new_string: '// reviewed\nimport',
      }),
    ).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('outside the scope'),
    });
    expect(await pre('Read', { file_path: path.join(shop.root, '.friday', 'run', 'daemon.json') })).toMatchObject({
      decision: 'deny',
    });
    expect(await pre('Read', { file_path: path.join(shop.root, '.friday', 'project.db') })).toMatchObject({
      decision: 'deny',
    });
    expect(await pre('Bash', { command: 'node --test "**/test/*.test.ts"' })).toBeNull();
    await post(
      'Bash',
      { command: 'node --test "**/test/*.test.ts"' },
      { tool_response: { stdout: 'ℹ pass 10\nℹ fail 0', stderr: '', exitCode: 0 } },
    );
    expect(await pre('Bash', { command: 'git commit -am "wip"' })).toMatchObject({ decision: 'ask' });

    // Ending a turn without reporting is nudged once; a completion claim is never inferred from Stop.
    const nudge = await hook('Stop', { stop_hook_active: false });
    expect(nudge.json).toMatchObject({ decision: 'block' });
    await mcp('friday_report_progress', {
      note: 'discount codes implemented with tests',
      changed_paths: ['frontend/src/pricing/discount.ts', 'frontend/test/discount.test.ts'],
    });
    const done = await mcp('friday_claim_done', {
      summary: 'Added applyDiscount with SAVE10 and tests.',
      changed_paths: ['frontend/src/pricing/discount.ts', 'frontend/test/discount.test.ts'],
      checks: [{ name: 'tests', kind: 'test', command: 'node --test "**/test/*.test.ts"', outcome: 'passed' }],
    });
    expect(done.structured.task_status).toBe('READY_FOR_VERIFICATION');
    expect([...(done.structured.observed_changed_paths as string[])].sort()).toEqual([
      'frontend/src/pricing/discount.ts',
      'frontend/test/discount.test.ts',
    ]);
    expect((await hook('Stop', { stop_hook_active: false })).stdout).toBe('');

    const verified = await cli(['--project', shop.root, '--json', 'verify', task.task_id]);
    expect(verified.code, verified.stderr).toBe(0);
    const v = JSON.parse(verified.stdout) as {
      task: TaskView;
      verification: { status: string; checks: Array<{ status: string; exit_code: number }> };
    };
    expect(v.task.status).toBe('COMPLETED');
    expect(v.verification.checks).toMatchObject([{ status: 'PASSED', exit_code: 0 }]);
    await hook('SessionEnd', { reason: 'prompt_input_exit' });

    expect(await transitions(shop, task.task_id)).toEqual([
      'task.ready PROPOSED->READY',
      'task.assigned READY->ASSIGNED',
      'task.started ASSIGNED->RUNNING',
      'task.completion_claimed RUNNING->READY_FOR_VERIFICATION',
      'task.verification_started READY_FOR_VERIFICATION->VERIFYING',
      'task.completed VERIFYING->COMPLETED',
    ]);
    const decisions = shop.daemon.state.store
      .readSince(shop.daemon.project.project_id, 0, { types: ['policy.evaluated'], limit: 1000 })
      .map((e) => (e.payload as { decision: string }).decision);
    expect({
      allow: decisions.filter((d) => d === 'allow').length,
      deny: decisions.filter((d) => d === 'deny').length,
      ask: decisions.filter((d) => d === 'ask').length,
    }).toEqual({ allow: 3, deny: 3, ask: 1 });

    // git sees the agent's two files and the shared Friday setup; nothing from Friday's runtime.
    expect((await shop.git.run(['diff', '--name-only'])).trim()).toBe('');
    const untracked = (await shop.git.run(['ls-files', '--others', '--exclude-standard']))
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(untracked).toEqual(
      [
        '.claude/settings.json',
        '.claude/skills/friday/SKILL.md',
        '.claude/skills/friday/reference.md',
        '.friday/harness/claude-code/README.md',
        '.friday/harness/claude-code/hook.mjs',
        '.friday/harness/claude-code/launch-mcp.mjs',
        '.mcp.json',
        'frontend/src/pricing/discount.ts',
        'frontend/test/discount.test.ts',
      ].sort(),
    );

    // No token in any model-readable file or output, the logs, the status page or the database.
    const tokens = [shop.daemon.tokens.operator, shop.daemon.tokens.bootstrap];
    const ui = await (await fetch(`${shop.daemon.url}/ui`)).text();
    const logs = readdirSync(path.join(shop.root, '.friday', 'logs')).map((f) =>
      readFileSync(path.join(shop.root, '.friday', 'logs', f), 'utf8'),
    );
    const db = ['project.db', 'project.db-wal']
      .map((f) => path.join(shop.root, '.friday', f))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f).toString('latin1'));
    const files = [...untracked, '.friday/config.yaml', '.claude/settings.local.json'].map((f) =>
      readFileSync(path.join(shop.root, f), 'utf8'),
    );
    for (const [where, texts] of Object.entries({ outputs, files, logs, db, ui: [ui] })) {
      for (const t of tokens)
        expect(
          texts.some((x) => x.includes(t)),
          `token found in ${where}`,
        ).toBe(false);
    }
  });

  it('a false completion claim fails verification, and rework leads to a verified completion', async () => {
    const shop = await startShop();
    const task = await createDiscountTask(shop);
    const agent = new GenericHarnessClient(shop.bootstrap, {
      harness_key: 'fixture-shop:fake:1',
      vendor: 'generic',
      name: 'FakeHarness',
      attach_mode: 'attach',
      project_id: shop.daemon.project.project_id,
      agent_key: 'dev-1',
      // Stands in for an adapter with policy hooks; the project requires L1 (review F09).
      enforcement_level: 'L1',
    });
    await agent.register();

    const first = await agent.claim({ next: true });
    expect(first.task.task_id).toBe(task.task_id);
    shop.write('frontend/src/pricing/discount.ts', BROKEN_DISCOUNT);
    shop.write('frontend/test/discount.test.ts', DISCOUNT_TEST);
    const claimed = await agent.reportResult({
      task_id: task.task_id,
      run_id: first.run_id,
      status: 'completed_claim',
      summary: 'done (it is not)',
      changed_paths: ['frontend/src/pricing/discount.ts', 'frontend/test/discount.test.ts'],
      checks: [{ name: 'tests', kind: 'test', outcome: 'passed' }],
    });
    expect(claimed.task_status).toBe('READY_FOR_VERIFICATION');

    const failed = await cli(['--project', shop.root, '--json', 'verify', task.task_id]);
    const f = JSON.parse(failed.stdout) as {
      task: TaskView;
      verification: { checks: Array<{ status: string; exit_code: number }> };
    };
    expect(f.task.status).toBe('FAILED');
    expect(f.verification.checks[0]).toMatchObject({ status: 'FAILED', exit_code: 1 });

    // `friday task rework` sends the task back to READY (FAILED -> REWORK -> READY).
    const rework = await cli(['--project', shop.root, 'task', 'rework', task.task_id]);
    expect(rework.code, rework.stderr).toBe(0);
    const second = await agent.claim({ next: true });
    expect(second.task.task_id).toBe(task.task_id);
    expect(second.run_id).not.toBe(first.run_id);
    shop.write('frontend/src/pricing/discount.ts', DISCOUNT);
    await agent.reportResult({
      task_id: task.task_id,
      run_id: second.run_id,
      status: 'completed_claim',
      summary: 'fixed the discount',
      changed_paths: ['frontend/src/pricing/discount.ts'],
      checks: [{ name: 'tests', kind: 'test', outcome: 'passed' }],
    });
    const passed = await cli(['--project', shop.root, '--json', 'verify', task.task_id]);
    expect((JSON.parse(passed.stdout) as { task: TaskView }).task.status).toBe('COMPLETED');

    expect(await transitions(shop, task.task_id)).toEqual([
      'task.ready PROPOSED->READY',
      'task.assigned READY->ASSIGNED',
      'task.started ASSIGNED->RUNNING',
      'task.completion_claimed RUNNING->READY_FOR_VERIFICATION',
      'task.verification_started READY_FOR_VERIFICATION->VERIFYING',
      'task.failed VERIFYING->FAILED',
      'task.rework FAILED->REWORK',
      'task.ready REWORK->READY',
      'task.assigned READY->ASSIGNED',
      'task.started ASSIGNED->RUNNING',
      'task.completion_claimed RUNNING->READY_FOR_VERIFICATION',
      'task.verification_started READY_FOR_VERIFICATION->VERIFYING',
      'task.completed VERIFYING->COMPLETED',
    ]);
  });
});
