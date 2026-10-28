/**
 * The bundled hook launcher, run the way Claude Code runs it (plan M1.10, M1.12): `node hook.mjs
 * <Event>` with the hook input on stdin. Covers a live daemon, no daemon, a daemon that hangs or
 * fails, what leaves the launcher, and discovery from a linked git worktree.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeHooks, findRoot, LAUNCHER_VERSION } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { TaskView } from '@friday/protocol';
import { findProjectRoot, loadProject, privateDirFor, writePrivateFile } from '@friday/sdk';
import { deterministicGit, type TestWorkspace, useTestWorkspace } from '@friday/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/cli.js';
import { initTestProject, startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { bundleLauncher, decisionOf, runLauncher, toolHook } from '../helpers/hooks.js';
import { startMcp } from '../helpers/mcp-rig.js';

const ws = useTestWorkspace();
let bundleDir = '';
let bundle = '';

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(os.tmpdir(), 'fri-hook-'));
  bundle = (await bundleLauncher(bundleDir)).file;
});
afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

/** Puts the launcher where `friday harness config` puts it and returns its path. */
function install(w: TestWorkspace): string {
  const dir = path.join(w.projectDir, '.friday', 'harness', 'claude-code');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hook.mjs');
  copyFileSync(bundle, file);
  return file;
}

function launch(
  w: TestWorkspace,
  event: string,
  hook: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
) {
  return runLauncher(install(w), event, hook, {
    CLAUDE_PROJECT_DIR: w.projectDir,
    FRIDAY_STATE_DIR: w.stateDir,
    ...env,
  });
}

const vars = (w: TestWorkspace, sessionId = 'sess-launch-1') => ({ projectDir: w.projectDir, sessionId });
const pre = (w: TestWorkspace, tool: string, input: Record<string, unknown>) =>
  toolHook('PreToolUse', tool, input, vars(w));

/** A stand-in daemon: records what the launcher sends and answers with `reply`. */
async function fakeDaemon(
  w: TestWorkspace,
  reply: (req: IncomingMessage, body: string) => { status: number; json: unknown } | null,
) {
  const seen: Array<{ url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }> = [];
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
      const r = reply(req, body);
      if (!r) return; // hang
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  w.track({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  });
  const port = (server.address() as { port: number }).port;
  const ref = loadProject(w.projectDir);
  const priv = privateDirFor(ref, { FRIDAY_STATE_DIR: w.stateDir });
  writePrivateFile(
    priv,
    'daemon.json',
    JSON.stringify({ url: `http://127.0.0.1:${port}`, project_id: ref.project_id }),
  );
  writePrivateFile(priv, 'bootstrap.token', 'fake-bootstrap-token-for-tests');
  return { seen, priv, ref };
}

async function attachMcp(td: TestDaemon, sessionId: string): Promise<GenericHarnessClient> {
  // The launcher's parent is this test process, just as Claude Code is the parent of both its hooks and friday-mcp.
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `claude-code:${td.project.project_id}:pid:${process.pid}`,
    vendor: 'claude-code',
    name: 'Claude Code',
    attach_mode: 'attach',
    project_id: td.project.project_id,
    capabilities: { hooks: true },
    agent_key: 'dev-1',
    host: { pid: process.pid, session_id: sessionId },
    enforcement_level: 'L1',
  });
  await client.register();
  return client;
}

describe('hook launcher bundle', () => {
  it('is one dependency-free module with a version header and nothing machine-specific in it', () => {
    const text = readFileSync(bundle, 'utf8');
    expect(text.startsWith(`// friday-hook-launcher-version: ${LAUNCHER_VERSION}\n`)).toBe(true);
    const specifiers = [
      ...text.matchAll(
        /\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g,
      ),
    ].map((m) => m[1] ?? m[2] ?? m[3] ?? '');
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !isBuiltin(s))).toEqual([]);
    for (const machine of [
      REPO_ROOT,
      REPO_ROOT.replaceAll('\\', '/'),
      os.homedir(),
      os.homedir().replaceAll('\\', '/'),
    ]) {
      expect(text.includes(machine), `bundle contains ${machine}`).toBe(false);
    }
    expect(text.length).toBeLessThan(400_000);
  });
});

describe('hook launcher with no daemon', () => {
  it('fails closed for edits and protected paths, asks for shell and web tools, and leaves reads alone', async () => {
    initTestProject(ws());
    const w = ws();
    const p = (...parts: string[]) => path.join(w.projectDir, ...parts);
    const expectDecision = async (
      tool: string,
      input: Record<string, unknown>,
      decision: string | null,
      reason?: string,
    ) => {
      const run = await launch(w, 'PreToolUse', pre(w, tool, input));
      expect(run.code, run.stderr).toBe(0);
      const d = decisionOf(run.json);
      expect(d?.decision ?? null, `${tool} ${JSON.stringify(input)}: ${run.stdout}`).toBe(decision);
      if (reason) expect(d?.reason).toContain(reason);
    };
    await expectDecision('Read', { file_path: p('.friday', 'project.db') }, 'deny', 'friday.runtime');
    await expectDecision('Grep', { pattern: 'url', path: p('.friday', 'run') }, 'deny', 'friday.runtime');
    await expectDecision('Glob', { pattern: '**/*', path: w.stateDir }, 'deny', 'friday.private');
    await expectDecision('Bash', { command: 'cat .env' }, 'deny', 'secrets');
    await expectDecision(
      'Edit',
      { file_path: p('src', 'a.ts'), old_string: 'a', new_string: 'b' },
      'deny',
      'edits are paused',
    );
    await expectDecision('Write', { file_path: p('src', 'b.ts'), content: 'x' }, 'deny', 'friday run');
    await expectDecision('NotebookEdit', { notebook_path: p('n.ipynb'), new_source: 'x' }, 'deny');
    await expectDecision('Bash', { command: 'node --test' }, 'ask', 'Friday is unavailable');
    await expectDecision('PowerShell', { command: 'Get-ChildItem' }, 'ask');
    await expectDecision('WebFetch', { url: 'https://example.com', prompt: 'x' }, 'ask');
    await expectDecision('WebSearch', { query: 'x' }, 'ask');
    await expectDecision('Read', { file_path: p('README.md') }, null);
    await expectDecision('Glob', { pattern: 'src/**/*.ts' }, null);
    await expectDecision('Agent', { prompt: 'x' }, null);

    const start = await launch(w, 'SessionStart', {
      session_id: 's',
      cwd: w.projectDir,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    expect(start.stdout).toMatch(/^Friday is not available for this session/);
    for (const event of ['PostToolUse', 'Stop', 'SessionEnd']) {
      const run = await launch(w, event, { session_id: 's', cwd: w.projectDir, hook_event_name: event });
      expect([run.code, run.stdout], event).toEqual([0, '']);
    }
  });

  it('stays out of the way outside a Friday project', async () => {
    const other = path.join(ws().root, 'not-friday');
    mkdirSync(other, { recursive: true });
    const run = await runLauncher(
      install(ws()),
      'PreToolUse',
      toolHook('PreToolUse', 'Edit', { file_path: path.join(other, 'a.ts') }, { projectDir: other }),
      {
        CLAUDE_PROJECT_DIR: other,
        FRIDAY_STATE_DIR: ws().stateDir,
      },
    );
    expect([run.code, run.stdout]).toEqual([0, '']);
  });
});

describe('hook launcher with a daemon', () => {
  it('forwards hooks with the bootstrap token and prints the daemon decision', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const w = ws();
    const mcp = await attachMcp(td, 'sess-launch-1');
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Pricing',
      scope: { write: ['src/**'], read: [] },
      assign_agent_key: 'dev-1',
    });

    const start = await launch(w, 'SessionStart', {
      session_id: 'sess-launch-1',
      cwd: w.projectDir,
      hook_event_name: 'SessionStart',
      source: 'startup',
    });
    const ctx = (start.json as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext;
    expect(ctx).toContain('<friday-context');
    expect(ctx).toContain(task.task_id);

    await mcp.claim({ next: true });
    const p = (...parts: string[]) => path.join(w.projectDir, ...parts);
    expect((await launch(w, 'PreToolUse', pre(w, 'Write', { file_path: p('src', 'a.ts'), content: 'x' }))).stdout).toBe(
      '',
    );
    const out = decisionOf(
      (
        await launch(
          w,
          'PreToolUse',
          pre(w, 'Edit', { file_path: p('backend', 'x.ts'), old_string: 'a', new_string: 'b' }),
        )
      ).json,
    );
    expect(out).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining(`outside the scope of ${task.task_id}`),
    });
    const db = decisionOf(
      (await launch(w, 'PreToolUse', pre(w, 'Read', { file_path: p('.friday', 'project.db') }))).json,
    );
    expect(db?.decision).toBe('deny');
    const stop = await launch(w, 'Stop', {
      session_id: 'sess-launch-1',
      cwd: w.projectDir,
      hook_event_name: 'Stop',
      stop_hook_active: false,
    });
    expect(stop.json).toMatchObject({ decision: 'block' });

    const evaluated = td.daemon.state.store
      .readSince(td.project.project_id, 0, { types: ['policy.evaluated'], limit: 100 })
      .map((e) => [
        e.actor.kind,
        (e.payload as { rule: string }).rule,
        (e.payload as { decided_locally: boolean }).decided_locally,
      ]);
    expect(evaluated).toEqual([
      ['agent', 'write.in_scope', false],
      ['agent', 'write.outside_scope', false],
      ['agent', 'sensitive.friday.runtime', true],
    ]);
    for (const run of [start, stop]) {
      expect(run.stdout).not.toContain(td.daemon.tokens.bootstrap);
      expect(run.stdout).not.toContain(td.daemon.tokens.operator);
    }
  });

  it('strips file bodies and long output, and sends identity from the private dir', async () => {
    initTestProject(ws());
    const w = ws();
    const fake = await fakeDaemon(w, () => ({ status: 200, json: { ok: true, hook_output: null } }));
    writePrivateFile(fake.priv, 'agent.json', JSON.stringify({ agent_key: 'dev-7' }));
    const body = 'TOP SECRET FILE BODY';
    await launch(
      w,
      'PreToolUse',
      pre(w, 'Write', { file_path: path.join(w.projectDir, 'src', 'a.ts'), content: body }),
    );
    await launch(
      w,
      'PreToolUse',
      pre(w, 'Edit', { file_path: path.join(w.projectDir, 'src', 'a.ts'), old_string: body, new_string: body }),
      { FRIDAY_AGENT: 'dev-9' },
    );
    await launch(
      w,
      'PostToolUse',
      toolHook('PostToolUse', 'Bash', { command: 'node --test' }, vars(w), {
        tool_response: { stdout: 'x'.repeat(10_000), stderr: '', exitCode: 0 },
      }),
    );

    expect(fake.seen).toHaveLength(3);
    const [write, edit, post] = fake.seen;
    if (!write || !edit || !post) throw new Error('expected three hook requests');
    expect(write.url).toBe(`/api/v1/projects/${fake.ref.project_id}/hooks/claude-code/PreToolUse`);
    expect(write.headers.authorization).toBe('Bearer fake-bootstrap-token-for-tests');
    expect(write.headers['x-friday-client']).toBe(`hook-launcher/${LAUNCHER_VERSION}`);
    expect(write.body).toMatchObject({
      schema_version: 1,
      launcher_version: LAUNCHER_VERSION,
      claude_pid: process.pid,
      agent_key: 'dev-7',
      local_decision: null,
    });
    expect(edit.body.agent_key).toBe('dev-9');
    expect(JSON.stringify(fake.seen)).not.toContain(body);
    expect((write.body.hook as { tool_input: { content: unknown } }).tool_input.content).toMatchObject({
      redacted_body: true,
      bytes: body.length,
    });
    const stdout = (post.body.hook as { tool_response: { stdout: string } }).tool_response.stdout;
    expect(stdout.length).toBeLessThan(2100);
    expect(stdout).toContain('[truncated');
  });

  it('applies the failure rules when the daemon errors, and within its time budget when it hangs', async () => {
    initTestProject(ws());
    const w = ws();
    let hang = false;
    await fakeDaemon(w, () =>
      hang ? null : { status: 500, json: { error: { code: 'COS-9000', message: 'database is locked' } } },
    );
    const edit = pre(w, 'Edit', {
      file_path: path.join(w.projectDir, 'src', 'a.ts'),
      old_string: 'a',
      new_string: 'b',
    });
    const failed = decisionOf((await launch(w, 'PreToolUse', edit)).json);
    expect(failed).toMatchObject({ decision: 'deny', reason: expect.stringContaining('database is locked') });

    hang = true;
    const slow = await launch(w, 'PreToolUse', edit);
    expect(decisionOf(slow.json)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('did not answer in time'),
    });
    // Claude Code's PreToolUse timeout is 5 s; the launcher gives up at 4 s so its own answer wins.
    expect(slow.ms).toBeGreaterThanOrEqual(3900);
    expect(slow.ms).toBeLessThan(8000);
    const bash = decisionOf((await launch(w, 'PreToolUse', pre(w, 'Bash', { command: 'node --test' }))).json);
    expect(bash?.decision).toBe('ask');
  });
});

describe('discovery from a linked git worktree', () => {
  it('finds the main worktree, its private dir and the same daemon from the hook launcher and friday-mcp', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const w = ws();
    // startTestDaemon committed .friday/config.yaml; the daemon's runtime files are ignored.
    const git = deterministicGit(w.projectDir);
    expect(await git.run(['status', '--porcelain'])).toBe('');
    const wt = path.join(w.root, 'wt');
    await git.run(['worktree', 'add', '--quiet', '-b', 'feature', wt]);
    writeFileSync(path.join(wt, 'note.txt'), 'in the worktree\n');

    const main = realpathSync.native(w.projectDir);
    expect(findRoot(wt)).toBe(main);
    expect(findRoot(path.join(wt, '.friday'))).toBe(main);
    expect(realpathSync.native(findProjectRoot(wt) ?? '')).toBe(main);
    expect(loadProject(wt).project_key).toBe(td.project.project_key);

    const install = path.join(w.projectDir, '.friday', 'harness', 'claude-code', 'hook.mjs');
    mkdirSync(path.dirname(install), { recursive: true });
    copyFileSync(bundle, install);
    const start = await runLauncher(
      install,
      'SessionStart',
      { session_id: 'sess-wt', cwd: wt, hook_event_name: 'SessionStart', source: 'startup' },
      {
        CLAUDE_PROJECT_DIR: wt,
        FRIDAY_STATE_DIR: w.stateDir,
        FRIDAY_AGENT: 'dev-1',
      },
    );
    expect(start.stdout).toContain('<friday-context');

    const mcp = await startMcp(w, { CLAUDE_PROJECT_DIR: wt, CLAUDE_CODE_SESSION_ID: 'sess-wt-mcp' });
    for (let i = 0; i < 100; i += 1) {
      const who = await mcp.call('friday_whoami');
      if ((who.structured.daemon as { reachable?: boolean } | undefined)?.reachable && who.structured.harness_id) {
        expect(who.structured.project).toMatchObject({ project_id: td.project.project_id });
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('friday-mcp in the worktree never reached the daemon');
  });
});
