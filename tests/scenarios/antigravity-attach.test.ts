/**
 * A rehearsal of one Antigravity session on fixture-shop, without Antigravity: this test plays its
 * part and Friday is real. It sends what CLI 1.5 sends, where it sends it from: the hook inputs
 * with the tool names of 1.5, each hook command run in `.agents/` (the folder of `hooks.json`); the
 * friday MCP server started as `.agents/mcp_config.json` names it, from the workspace root; and the
 * steps in the order the `/friday` skill gives them.
 *
 * It exists because the first live sessions (2026-11-16) each stopped at something a rehearsal
 * would have met first: no route for a task on this host, a prompt at every step, a claim nothing
 * could complete. A person tries Antigravity itself after this passes, not instead of it.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { materializeFixtureShop } from '@friday/cli';
import { createDaemon, type Daemon } from '@friday/daemon';
import type { TaskView, VerificationView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import type { TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { hostEnv } from '../helpers/hooks.js';

const ws = useTestWorkspace();
const MCP_ENTRY = path.join(REPO_ROOT, 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
const CONVERSATION = 'conv-rehearsal-1';
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

const text = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

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

interface HookReply {
  decision: string | null;
  reason: string;
  json: Record<string, unknown>;
}

/** Antigravity, played: its hooks and its friday MCP server, each started as CLI 1.5 starts it. */
async function antigravitySession(root: string) {
  const env = { FRIDAY_STATE_DIR: ws().stateDir };
  const hooks = JSON.parse(text(path.join(root, '.agents', 'hooks.json'))).friday as Record<
    string,
    ({ command: string } & { hooks?: { command: string }[] })[]
  >;
  const commandOf = (event: string): string => {
    const entry = hooks[event]?.[0];
    const command = entry?.hooks ? entry.hooks[0]?.command : entry?.command;
    if (!command) throw new Error(`no ${event} hook in .agents/hooks.json`);
    return command;
  };
  /** One hook: its command's words, run in the folder of hooks.json, the input on stdin. */
  const hook = (event: string, input: Record<string, unknown> = {}): Promise<HookReply> =>
    new Promise((resolve, reject) => {
      const [program, ...args] = commandOf(event).split(' ');
      if (program !== 'node') throw new Error(`the ${event} hook does not run node: ${program}`);
      const child = spawn(process.execPath, args, {
        cwd: path.join(root, '.agents'),
        env: hostEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (c: string) => {
        stdout += c;
      });
      child.stderr.setEncoding('utf8').on('data', (c: string) => {
        stderr += c;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0 || stderr) return reject(new Error(`${event} hook: exit ${code}: ${stderr || stdout}`));
        const json = JSON.parse(stdout || '{}') as Record<string, unknown>;
        resolve({ decision: (json.decision as string | undefined) ?? null, reason: String(json.reason ?? ''), json });
      });
      child.stdin.end(
        JSON.stringify({
          conversationId: CONVERSATION,
          workspacePaths: [root],
          transcriptPath: path.join(ws().root, 'transcript.jsonl'),
          artifactDirectoryPath: path.join(ws().root, 'artifacts'),
          modelName: 'gemini-3.8-flash-high',
          lastUserInput: '/friday',
          hookEventName: event,
          cwd: root,
          ...input,
        }),
      );
    });

  // The server of .agents/mcp_config.json. Antigravity starts it in the workspace root (the first
  // live session's server reported that folder).
  const entry = (
    JSON.parse(text(path.join(root, '.agents', 'mcp_config.json'))) as {
      mcpServers: { friday: { command: string; args: string[]; env: Record<string, string> } };
    }
  ).mcpServers.friday;
  expect(entry.command).toBe('node');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: entry.args,
    cwd: root,
    env: hostEnv({ ...entry.env, ...env, FRIDAY_MCP_ENTRY: MCP_ENTRY }),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'antigravity', version: '1.5.9' });
  await client.connect(transport);
  ws().track({ close: () => client.close() });

  let step = 0;
  /** A tool call as CLI 1.5 makes it: the PreToolUse hook decides; a call that goes ahead is done and reported. */
  const tool = async (name: string, args: Record<string, unknown>, act?: () => void): Promise<HookReply> => {
    step += 1;
    const toolCall = { id: `call_${step}`, name, args };
    const pre = await hook('PreToolUse', { toolCall, stepIdx: step });
    if (pre.decision !== 'allow') return pre;
    act?.();
    await hook('PostToolUse', { toolCall, stepIdx: step });
    return pre;
  };
  /** One of Friday's tools the lazy way (the default of CLI 1.5): `call_mcp_tool` carries the server and the tool. */
  const friday = async (name: string, args: Record<string, unknown> = {}) => {
    const pre = await tool('call_mcp_tool', { ServerName: 'friday', ToolName: name, Arguments: args });
    expect(pre.decision, `${name}: ${pre.reason}`).toBe('allow');
    const res = (await client.callTool({ name, arguments: args })) as {
      content?: { text?: string }[];
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    const said = (res.content ?? []).map((c) => c.text ?? '').join('\n');
    return { ok: !res.isError, text: said, structured: res.structuredContent ?? {} };
  };
  return { hook, tool, friday };
}

describe('a plan with a task for Antigravity, beside an agent Friday runs', () => {
  it('keeps that task for Antigravity while the free agent takes the other, and Antigravity claims it with /friday', async () => {
    const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
    const configured = await cli(['--project', root, 'harness', 'config', 'antigravity', '--agent', 'dev-1']);
    expect(configured.code, configured.stderr).toBe(0);
    await deterministicGit(root, { startEpoch: 1_767_300_000 }).commitAll('Friday for Antigravity');
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

    // An agent Friday runs, free and of a role that fits both tasks: before plans could name an
    // agent, it was given whichever task came first, the one meant for Antigravity included.
    const free = await FakeHarness.connect(td, { agentKey: 'cc-1', role: 'developer' });
    free.client.startHeartbeat();
    ws().track({ close: () => free.close() });

    // The person's plan: the docs for Antigravity (first, so it would be first to go), the API for anyone.
    const goal = await op.post<{ goal_id: string }>(op.projectPath('/goals'), {
      request: 'Document how to run the tests, and tidy the checkout service',
      plan: false,
    });
    const task = (key: string, write: string, assign_to?: string) => ({
      key,
      kind: 'implementation',
      summary: `Do the ${key}`,
      acceptance_criteria: [`the ${key} is done`],
      scope: { write: [write] },
      role: 'developer',
      ...(assign_to ? { assign_to } : {}),
    });
    const proposed = await op.post<{ plan_id: string; version: number }>(
      op.projectPath(`/goals/${goal.goal_id}/plans`),
      {
        draft: {
          objective: 'Document how to run the tests, and tidy the checkout service',
          summary: 'Two independent tasks',
          tasks: [task('docs', 'README.md', 'dev-1'), task('service', 'backend/**')],
        },
      },
    );
    await op.post(op.projectPath(`/plans/${proposed.plan_id}/versions/${proposed.version}/approve`), {});
    await op.post(op.projectPath('/brain/run-once'), {});
    await op.post(op.projectPath('/brain/run-once'), {});

    const byKey = () => new Map(daemon.state.q.goalTasks(pid, goal.goal_id).map((t) => [t.plan_key, t]));
    // The free agent got the task anyone could take, and only that one.
    const started = await free.waitFor('task.start', 30_000);
    expect((started.params as { task_id: string }).task_id).toBe(byKey().get('service')?.task_id);
    expect(byKey().get('docs')).toMatchObject({
      status: 'READY',
      reserved_for_agent_key: 'dev-1',
      reserved_by: 'human',
    });
    expect(free.received.filter((m) => m.method === 'task.start')).toHaveLength(1);

    // The person opens Antigravity and types /friday: it takes its task.
    const ag = await antigravitySession(root);
    await ag.hook('SessionStart');
    const claim = await ag.friday('friday_task_claim', { next: true });
    expect(claim.ok, claim.text).toBe(true);
    expect((claim.structured.task as { task_id: string }).task_id).toBe(byKey().get('docs')?.task_id);
    expect(byKey().get('docs')?.status).toBe('RUNNING');
  }, 180_000);
});

describe('an Antigravity session, rehearsed', () => {
  it.each([
    ['with Fridayâ€™s files committed, as the Connect dialog asks', true],
    ['with Fridayâ€™s files not committed yet, as the Connect dialog leaves them', false],
  ])(
    'connects, takes the task reserved for it, edits inside its scope without a prompt, claims it, and Friday verifies it: %s',
    async (_state, committed) => {
      // A project as the Connect dialog leaves it: Friday's files for Antigravity, and one task a
      // person reserved for this session. A person who has not committed those files yet (the first
      // live sessions were all in such a project) also edited config.yaml; neither is the task's work.
      const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
      const friday = (...args: string[]) => cli(['--project', root, ...args]);
      const configured = await friday('harness', 'config', 'antigravity', '--agent', 'dev-1');
      expect(configured.code, configured.stderr).toBe(0);
      if (committed) await deterministicGit(root, { startEpoch: 1_767_300_000 }).commitAll('Friday for Antigravity');
      else appendFileSync(path.join(root, '.friday', 'config.yaml'), '\n# edited by its owner, not committed\n');
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
      const pid = td.project.project_id;
      const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
        summary: "Add a 'Running the tests' section to README.md",
        kind: 'docs',
        role: 'documentation',
        description: "Add a short section named 'Running the tests' to README.md that names node --test.",
        acceptance_criteria: ["README.md has a 'Running the tests' section that names node --test"],
        scope: { write: ['README.md'], read: ['README.md', 'package.json'] },
        assign_agent_key: 'dev-1',
      });

      // The person opens Antigravity on the folder and types /friday.
      const ag = await antigravitySession(root);
      const started = await ag.hook('SessionStart');
      const context = (started.json.injectSteps as [{ systemMessage: { systemMessage: string } }])[0].systemMessage
        .systemMessage;
      expect(context).toContain('<friday-context');
      expect(context).toContain(task.task_id);

      // Skill step 1: who am I. One of Friday's own tools: it goes ahead, unasked.
      const who = await ag.friday('friday_whoami');
      expect(who.ok, who.text).toBe(true);
      expect(who.text).toContain('dev-1');

      // Step 2: take the task. The first live session ended here: "no dispatchable candidate".
      const claim = await ag.friday('friday_task_claim', { next: true });
      expect(claim.ok, claim.text).toBe(true);
      expect((claim.structured.task as { task_id: string }).task_id).toBe(task.task_id);
      expect(daemon.state.q.task(pid, task.task_id).status).toBe('RUNNING');
      const run = daemon.state.q.findRun(daemon.state.q.task(pid, task.task_id).current_run_id as string);
      const where = run?.execution_root as string;
      expect(where, 'where the claim says to work').toBeTruthy();

      // Step 3: read, then edit inside the scope. Friday's rules pass both, so neither is a prompt.
      const readme = path.join(where, 'README.md');
      expect(existsSync(readme)).toBe(true);
      expect((await ag.tool('read_file', { Path: readme })).decision).toBe('allow');
      const edited = await ag.tool('edit_file', { Path: readme }, () =>
        writeFileSync(readme, `${text(readme)}\n## Running the tests\n\nRun \`node --test\` in the project folder.\n`),
      );
      expect(edited, 'an edit inside the task').toMatchObject({ decision: 'allow' });
      expect(edited.reason).toMatch(/^Friday: /);

      // What Friday's rules do not pass is still refused, in this session as in any other.
      const outside = await ag.tool('edit_file', { Path: path.join(where, 'backend', 'src', 'checkout.service.ts') });
      expect(outside).toMatchObject({ decision: 'deny' });
      expect(outside.reason).toContain('outside the scope');
      const secret = await ag.tool('read_file', { Path: path.join(root, '.friday', 'project.db') });
      expect(secret).toMatchObject({ decision: 'deny' });
      const ownSettings = await ag.tool('write_file', { Path: path.join(root, '.agents', 'hooks.json') });
      expect(ownSettings).toMatchObject({ decision: 'deny' });
      // A tool Friday has no rule for: the person decides, as before.
      expect((await ag.tool('run_workflow', { Script: 'print(1)' })).decision).toBe('ask');
      // Friday's own command line is not the agent's to run.
      expect(
        (await ag.tool('run_command', { CommandLine: 'friday routing pin --task x --model y', Cwd: where })).decision,
      ).toBe('deny');

      // Steps 4 and 5: report, run the check, claim.
      const progress = await ag.friday('friday_report_progress', { note: 'README section written', percent: 80 });
      expect(progress.ok, progress.text).toBe(true);
      const tests = await ag.tool('run_command', { CommandLine: 'node --test "**/test/*.test.ts"', Cwd: where });
      // The project's own test command is one Friday's rules pass (test.local): no prompt.
      expect(tests, 'the projectâ€™s own test command').toMatchObject({ decision: 'allow' });
      const done = await ag.friday('friday_claim_done', {
        summary: "Added a 'Running the tests' section to README.md",
        changed_paths: ['README.md'],
        checks: [{ name: 'tests', kind: 'test', command: 'node --test', outcome: 'passed' }],
      });
      expect(done.ok, done.text).toBe(true);
      expect(daemon.state.q.task(pid, task.task_id).status).toBe('READY_FOR_VERIFICATION');
      // The turn ends: Friday holds nothing, it has no say in when this session goes on.
      expect(
        (await ag.hook('Stop', { executionNum: 1, terminationReason: 'NO_TOOL_CALL', fullyIdle: true })).json,
      ).toEqual({});

      // Friday checks the claim against the work.
      const verified = await td.operator.post<{ task: TaskView; verification: VerificationView }>(
        td.operator.projectPath(`/tasks/${task.task_id}/verify`),
        {},
        { timeoutMs: 120_000 },
      );
      expect(verified.verification.status, JSON.stringify(verified.verification).slice(0, 1500)).toBe('PASSED');
      expect(verified.task.status).toBe('COMPLETED');

      // What the person was asked along the way: nothing Friday judged. The one prompt of this
      // session was the tool Friday has no rule for (run_workflow), which is Antigravity's to ask.
      const asked = daemon.state.store
        .readSince(pid, 0, { types: ['policy.evaluated'], limit: 1000 })
        .map((e) => e.payload as { decision: string; tool: string })
        .filter((p) => p.decision === 'ask');
      expect(asked).toEqual([]);
    },
    180_000,
  );
});
