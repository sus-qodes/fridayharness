/**
 * The bundled hook launcher run as Cursor, Antigravity and Gemini CLI run it (plan M8b.1):
 * `node hook.mjs <vendor> <event>` with the host's input on stdin. The launcher's own rules hold for
 * every host without the daemon; with the daemon, each host's call reaches the same judgment as
 * Claude Code's; and a Claude Code hook that Cursor runs through its import answers nothing.
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { claudeCodeHooks, LAUNCHER_VERSION } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { TaskView, Vendor } from '@friday/protocol';
import { loadProject, privateDirFor, writePrivateFile } from '@friday/sdk';
import { type TestWorkspace, useTestWorkspace } from '@friday/test-support';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initTestProject, startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { bundleLauncher, decisionOf, postHook, runLauncher, toolHook } from '../helpers/hooks.js';
import {
  type HostRun,
  hostFixture,
  hostProjectEnv,
  OTHER_VENDORS,
  type OtherVendor,
  postVendorHook,
  runHost,
} from './host-rig.js';

const ws = useTestWorkspace();
let bundleDir = '';
let bundle = '';

beforeAll(async () => {
  bundleDir = mkdtempSync(path.join(os.tmpdir(), 'fri-hosthook-'));
  bundle = (await bundleLauncher(bundleDir)).file;
});
afterAll(() => {
  rmSync(bundleDir, { recursive: true, force: true });
});

/** Puts the launcher where `friday harness config <host>` puts it. */
function install(w: TestWorkspace, vendor: string): string {
  const dir = path.join(w.projectDir, '.friday', 'harness', vendor);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'hook.mjs');
  copyFileSync(bundle, file);
  return file;
}

/** Runs one fixture of `vendor` through the launcher, as the host would. */
function run(
  w: TestWorkspace,
  vendor: OtherVendor,
  name: string,
  patch: Record<string, unknown> = {},
): Promise<HostRun> {
  const f = hostFixture(vendor, name, w.projectDir, patch);
  return runHost(install(w, vendor), [vendor, f.event], f.input, {
    ...hostProjectEnv(vendor, w.projectDir),
    FRIDAY_STATE_DIR: w.stateDir,
  });
}

/** The decision in any host's reply, as one comparable value. */
function decided(vendor: OtherVendor, r: HostRun): { decision: string | null; reason: string } {
  const j = r.json ?? {};
  if (vendor === 'cursor') {
    return { decision: (j.permission as string | undefined) ?? null, reason: String(j.agent_message ?? '') };
  }
  const d = (j.decision as string | undefined) ?? null;
  return { decision: d === 'force_ask' ? 'ask' : d, reason: String(j.reason ?? '') };
}

const p = (w: TestWorkspace, ...parts: string[]) => path.join(w.projectDir, ...parts);

describe('every host, with no daemon', () => {
  it('denies protected locations itself, in each host’s reply and exit code', async () => {
    initTestProject(ws());
    const w = ws();
    const cursorWrite = await run(w, 'cursor', 'preToolUse.write', {
      tool_input: { path: p(w, '.claude', 'settings.json'), fileText: '{}' },
    });
    expect([cursorWrite.code, decided('cursor', cursorWrite).decision]).toEqual([2, 'deny']);
    expect(cursorWrite.stderr).toContain('host.config');
    const cursorRead = await run(w, 'cursor', 'beforeReadFile');
    expect([cursorRead.code, decided('cursor', cursorRead)]).toEqual([
      2,
      { decision: 'deny', reason: expect.stringContaining('secrets') },
    ]);
    expect(cursorRead.stdout).not.toContain('SECRET_IN_THE_FILE');
    const agRead = await run(w, 'antigravity', 'PreToolUse.view_file', {
      toolCall: { name: 'view_file', args: { AbsolutePath: p(w, '.friday', 'project.db') } },
    });
    expect([agRead.code, decided('antigravity', agRead)]).toEqual([
      0,
      { decision: 'deny', reason: expect.stringContaining('friday.runtime') },
    ]);
    // The folders where Antigravity and Gemini CLI read hook commands are protected (host.config).
    const agHooks = await run(w, 'antigravity', 'PreToolUse.write_to_file', {
      toolCall: { name: 'write_to_file', args: { TargetFile: p(w, '.agents', 'hooks.json'), CodeContent: '{}' } },
    });
    expect(decided('antigravity', agHooks)).toEqual({
      decision: 'deny',
      reason: expect.stringContaining('host.config'),
    });
    const gemSettings = await run(w, 'gemini', 'BeforeTool.write_file', {
      tool_input: { file_path: p(w, '.gemini', 'settings.json'), content: '{}' },
    });
    expect([gemSettings.code, decided('gemini', gemSettings)]).toEqual([
      2,
      { decision: 'deny', reason: expect.stringContaining('host.config') },
    ]);
    const gemSecret = await run(w, 'gemini', 'BeforeTool.run_shell_command', {
      tool_input: { command: 'cat .env' },
    });
    expect(decided('gemini', gemSecret)).toEqual({ decision: 'deny', reason: expect.stringContaining('secrets') });
  });

  it('applies the failure rules in each host’s terms: edits paused, commands asked where the host can ask', async () => {
    initTestProject(ws());
    const w = ws();
    const expectRun = async (vendor: OtherVendor, name: string, decision: string | null, reason?: string) => {
      const r = await run(w, vendor, name);
      expect(decided(vendor, r).decision, `${vendor} ${name}: ${r.stdout}`).toBe(decision);
      if (reason) expect(decided(vendor, r).reason, `${vendor} ${name}`).toContain(reason);
      return r;
    };
    expect((await expectRun('cursor', 'preToolUse.write', 'deny', 'edits are paused')).code).toBe(2);
    expect((await expectRun('cursor', 'beforeShellExecution', 'ask', 'Friday is unavailable')).code).toBe(0);
    await expectRun('cursor', 'beforeMCPExecution', 'ask');
    // Cursor's preToolUse cannot ask: the web fetch Friday would ask about is declined, saying why,
    // and promising no approval: with Friday down there is none to grant.
    const fetch = await expectRun('cursor', 'preToolUse.webfetch', 'deny', 'this hook cannot ask a human');
    expect(decided('cursor', fetch).reason).toContain('start Friday');
    expect(decided('cursor', fetch).reason).not.toMatch(/approve/);
    // A session Friday's spawn adapter started has nobody to answer an ask: declined at once, not left waiting.
    for (const [vendor, name] of [
      ['gemini', 'BeforeTool.run_shell_command'],
      ['cursor', 'beforeShellExecution'],
      ['antigravity', 'PreToolUse.run_command'],
    ] as const) {
      const fx = hostFixture(vendor, name, w.projectDir);
      const r = await runHost(install(w, vendor), [vendor, fx.event], fx.input, {
        ...hostProjectEnv(vendor, w.projectDir),
        FRIDAY_STATE_DIR: w.stateDir,
        FRIDAY_SPAWN_RUN: 'run_fixture',
      });
      expect(decided(vendor, r), `${vendor} headless`).toEqual({
        decision: 'deny',
        reason: expect.stringContaining('no human is at this session'),
      });
    }
    // Shell and MCP calls are judged in their own hooks; preToolUse leaves them alone.
    expect((await run(w, 'cursor', 'preToolUse.shell')).stdout).toBe('{}');
    expect((await run(w, 'cursor', 'preToolUse.mcp')).stdout).toBe('{}');
    expect((await run(w, 'cursor', 'beforeMCPExecution.friday')).stdout).toBe('{}');
    expect((await run(w, 'cursor', 'preToolUse.read')).stdout).toBe('{}');
    await expectRun('antigravity', 'PreToolUse.write_to_file', 'deny', 'edits are paused');
    expect((await expectRun('antigravity', 'PreToolUse.run_command', 'ask')).json?.decision).toBe('force_ask');
    expect((await run(w, 'antigravity', 'PreToolUse.invoke_subagent')).stdout).toBe('{}');
    expect((await expectRun('gemini', 'BeforeTool.replace', 'deny', 'edits are paused')).code).toBe(2);
    await expectRun('gemini', 'BeforeTool.run_shell_command', 'ask', 'a human must confirm');
    await expectRun('gemini', 'BeforeTool.mcp', 'ask');
    for (const name of ['BeforeTool.mcp-friday', 'BeforeTool.write_todos', 'BeforeTool.read_file']) {
      expect(await run(w, 'gemini', name), name).toMatchObject({ code: 0, stdout: '' });
    }

    const agStart = (await run(w, 'antigravity', 'SessionStart')).json as {
      injectSteps: [{ systemMessage: { systemMessage: string } }];
    } | null;
    const gemStart = (await run(w, 'gemini', 'SessionStart')).json as {
      hookSpecificOutput: { additionalContext: string };
    } | null;
    const starts = {
      cursor: (await run(w, 'cursor', 'sessionStart')).json?.additional_context,
      antigravity: agStart?.injectSteps[0].systemMessage.systemMessage,
      gemini: gemStart?.hookSpecificOutput.additionalContext,
    };
    for (const [vendor, text] of Object.entries(starts)) {
      expect(text, vendor).toMatch(/^Friday is not available for this session/);
    }
    for (const [vendor, name] of [
      ['cursor', 'stop'],
      ['antigravity', 'Stop'],
      ['gemini', 'AfterAgent'],
      ['gemini', 'SessionEnd'],
    ] as const) {
      const r = await run(w, vendor, name);
      expect([r.code, r.stdout], `${vendor} ${name}`).toEqual([0, vendor === 'gemini' ? '' : '{}']);
    }
  });

  it('stays out of the way outside a Friday project, answering no decision in each host’s terms', async () => {
    const other = path.join(ws().root, 'not-friday');
    mkdirSync(other, { recursive: true });
    for (const [vendor, name, empty] of [
      ['cursor', 'preToolUse.write', '{}'],
      ['antigravity', 'PreToolUse.write_to_file', '{}'],
      ['gemini', 'BeforeTool.write_file', ''],
    ] as const) {
      const f = hostFixture(vendor, name, other);
      const r = await runHost(install(ws(), vendor), [vendor, f.event], f.input, {
        ...hostProjectEnv(vendor, other),
        FRIDAY_STATE_DIR: ws().stateDir,
      });
      expect([r.code, r.stdout], vendor).toEqual([0, empty]);
    }
  });
});

/** A stand-in daemon that records what the launcher sends and answers with `reply`. */
async function fakeDaemon(w: TestWorkspace, reply: (body: Record<string, unknown>) => unknown) {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
    });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply(body)));
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
  const ref = loadProject(w.projectDir);
  const priv = privateDirFor(ref, { FRIDAY_STATE_DIR: w.stateDir });
  const port = (server.address() as { port: number }).port;
  writePrivateFile(
    priv,
    'daemon.json',
    JSON.stringify({ url: `http://127.0.0.1:${port}`, project_id: ref.project_id }),
  );
  writePrivateFile(priv, 'bootstrap.token', 'fake-bootstrap-token-for-tests');
  return { seen, ref };
}

describe('what the launcher sends for another host', () => {
  it('posts Friday’s vocabulary to /hooks/<vendor>/<event>, with the host’s own names beside it and no bodies', async () => {
    initTestProject(ws());
    const w = ws();
    const fake = await fakeDaemon(w, () => ({ ok: true, hook_output: null, judgment: { decision: 'none' } }));
    expect((await run(w, 'gemini', 'BeforeTool.write_file')).stdout).toBe('');
    await run(w, 'cursor', 'beforeShellExecution');
    await run(w, 'antigravity', 'PreToolUse.replace_file_content');
    expect(fake.seen.map((s) => s.url)).toEqual([
      `/api/v1/projects/${fake.ref.project_id}/hooks/gemini/PreToolUse`,
      `/api/v1/projects/${fake.ref.project_id}/hooks/cursor/PreToolUse`,
      `/api/v1/projects/${fake.ref.project_id}/hooks/antigravity/PreToolUse`,
    ]);
    const [gem, cur, ag] = fake.seen;
    expect(gem?.body).toMatchObject({
      schema_version: 1,
      launcher_version: LAUNCHER_VERSION,
      host_pid: process.pid,
      agent_key: null,
      local_decision: null,
      hook: {
        hook_event_name: 'PreToolUse',
        session_id: 'gemini-session-fixture-1',
        tool_name: 'Write',
        tool_input: { file_path: p(w, 'src', 'a.ts') },
      },
      host: { vendor: 'gemini', event: 'BeforeTool', tool_name: 'write_file', version: null, can_ask: true },
    });
    expect(gem?.body.claude_pid).toBeUndefined();
    expect(cur?.body).toMatchObject({
      hook: { tool_name: 'Shell', tool_input: { command: 'git commit -m "fixture"' }, session_id: 'conv_fixture_1' },
      host: { vendor: 'cursor', event: 'beforeShellExecution', version: '3.24.0', can_ask: true },
    });
    expect(ag?.body).toMatchObject({ hook: { tool_name: 'Edit', session_id: 'conv-fixture-1' } });
    const all = JSON.stringify(fake.seen);
    for (const leak of ['BODY', 'example.invalid', 'transcript']) expect(all).not.toContain(leak);
  });

  it('sends nothing for a call another of the host’s hooks carries, and sends a local denial to be recorded', async () => {
    initTestProject(ws());
    const w = ws();
    const fake = await fakeDaemon(w, () => ({ ok: true, hook_output: null, judgment: { decision: 'none' } }));
    expect((await run(w, 'cursor', 'preToolUse.shell')).stdout).toBe('{}');
    expect((await run(w, 'cursor', 'preToolUse.mcp')).stdout).toBe('{}');
    expect((await run(w, 'cursor', 'beforeReadFile', { file_path: p(w, 'README.md') })).stdout).toBe('{}');
    expect(fake.seen).toEqual([]);
    const denied = await run(w, 'cursor', 'beforeReadFile');
    expect(decided('cursor', denied).decision).toBe('deny');
    expect(fake.seen).toHaveLength(1);
    expect(fake.seen[0]?.body).toMatchObject({ local_decision: 'deny', hook: { tool_name: 'Read' } });
    expect(JSON.stringify(fake.seen)).not.toContain('SECRET_IN_THE_FILE');
  });

  it('applies its own rules to a call Cursor sends through the Claude Code hook, and stands down where Cursor runs Friday’s hooks', async () => {
    initTestProject(ws());
    const w = ws();
    const fake = await fakeDaemon(w, () => ({ ok: true, hook_output: null }));
    const claudeFile = install(w, 'claude-code');
    const f = hostFixture('cursor', 'PreToolUse.claude-import', w.projectDir);
    const viaImport = (input: Record<string, unknown>) =>
      runHost(claudeFile, f.launcher_args ?? [], input, { ...f.env, FRIDAY_STATE_DIR: w.stateDir });
    const protectedInput = { ...f.input, tool_input: { path: p(w, '.claude', 'settings.json') } };
    const shellInput = { ...f.input, tool_name: 'Shell', tool_input: { command: 'cat .env' } };

    // No Friday hook in .cursor/hooks.json: nothing else judges Cursor's calls, so the launcher's
    // own rules do, in Claude Code's reply format, and nothing is sent to the daemon.
    expect(await viaImport(f.input)).toMatchObject({ code: 0, stdout: '', stderr: '' });
    for (const input of [protectedInput, shellInput]) {
      const r = await viaImport(input);
      expect(r.code).toBe(0);
      expect(decisionOf(r.json)).toMatchObject({ decision: 'deny' });
    }
    expect(fake.seen).toEqual([]);

    // With Friday's Cursor hooks in place, those judge each call: the import answers nothing, even
    // for a call the launcher would deny itself, so each call is judged once.
    mkdirSync(p(w, '.cursor'), { recursive: true });
    writeFileSync(
      p(w, '.cursor', 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          preToolUse: [
            { type: 'command', command: 'node .friday/harness/cursor/hook.mjs cursor preToolUse', failClosed: true },
          ],
        },
      }),
    );
    expect(await viaImport(f.input)).toMatchObject({ code: 0, stdout: '', stderr: '' });
    for (const input of [protectedInput, shellInput]) expect((await viaImport(input)).stdout).toBe('');
    expect(fake.seen).toEqual([]);
    // A Claude Code session started from a terminal inside Cursor inherits Cursor's variables, and is still judged.
    const claude = await runLauncher(
      claudeFile,
      'PreToolUse',
      toolHook('PreToolUse', 'Write', { file_path: p(w, 'src', 'a.ts'), content: 'x' }, { projectDir: w.projectDir }),
      { CLAUDE_PROJECT_DIR: w.projectDir, FRIDAY_STATE_DIR: w.stateDir, CURSOR_VERSION: '3.24.0' },
    );
    expect(claude.code).toBe(0);
    expect(fake.seen.map((s) => s.url)).toEqual([
      `/api/v1/projects/${fake.ref.project_id}/hooks/claude-code/PreToolUse`,
    ]);
  });
});

describe('every host, with the daemon', () => {
  /** One attached session per host, each holding a task of its own scope (one live writer per area). */
  async function sessions(td: TestDaemon) {
    const pid = td.project.project_id;
    const out: Record<string, { task: TaskView; sessionId: string }> = {};
    const sessionOf: Record<string, string> = {
      'claude-code': 'sess-hosts-claude',
      cursor: 'conv_fixture_1',
      antigravity: 'conv-fixture-1',
      gemini: 'gemini-session-fixture-1',
    };
    for (const vendor of ['claude-code', ...OTHER_VENDORS] as const) {
      // The launcher's parent is this test process, as the host is the parent of its hooks.
      const client = new GenericHarnessClient(td.bootstrap, {
        harness_key: `${vendor}:${pid}:pid:${process.pid}`,
        vendor: vendor as Vendor,
        name: vendor,
        attach_mode: 'attach',
        project_id: pid,
        capabilities: { hooks: true },
        agent_key: `dev-${vendor}`,
        host: { pid: process.pid, session_id: sessionOf[vendor] as string },
        // Claimed, and ignored: an attached session's level comes from its hooks reaching the daemon.
        enforcement_level: 'L1',
      });
      await client.register();
      // Every host's session takes work once its hooks reach the daemon (ADR-0016, plan M8b).
      const daemon = { url: td.url, projectId: pid, token: td.daemon.tokens.bootstrap };
      const start = { session_id: sessionOf[vendor], cwd: td.project.root, hook_event_name: 'SessionStart' };
      if (vendor === 'claude-code') {
        expect((await postHook(daemon, 'SessionStart', start, { claudePid: process.pid })).status).toBe(200);
      } else {
        const before = td.daemon.state.q.harnessBySession(pid, vendor, sessionOf[vendor] as string);
        expect(before?.enforcement_level, vendor).toBe('L0');
        const posted = await postVendorHook(daemon, vendor, 'SessionStart', {
          host_pid: process.pid,
          hook: start,
          host: { vendor, event: 'SessionStart', version: vendor === 'cursor' ? '3.24.0' : null, can_ask: true },
        });
        expect(posted.status, vendor).toBe(200);
      }
      const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
        summary: `Work for ${vendor}`,
        scope: { write: [`src/${vendor}/**`], read: [] },
        assign_agent_key: `dev-${vendor}`,
      });
      await client.claim({ next: true });
      out[vendor] = { task, sessionId: sessionOf[vendor] as string };
    }
    return out;
  }

  it('reaches the same judgment for each host’s call as for Claude Code’s, and links each session by its own id', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const w = ws();
    const s = await sessions(td);
    const pid = td.project.project_id;

    // Claude Code first, the reference.
    const claudeFile = install(w, 'claude-code');
    const claudeEdit = await runLauncher(
      claudeFile,
      'PreToolUse',
      toolHook(
        'PreToolUse',
        'Edit',
        { file_path: p(w, 'backend', 'x.ts'), old_string: 'a', new_string: 'b' },
        {
          projectDir: w.projectDir,
          sessionId: 'sess-hosts-claude',
        },
      ),
      { CLAUDE_PROJECT_DIR: w.projectDir, FRIDAY_STATE_DIR: w.stateDir },
    );
    expect(decisionOf(claudeEdit.json)).toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining(`outside the scope of ${s['claude-code']?.task.task_id}`),
    });

    const outside = {
      cursor: () => run(w, 'cursor', 'preToolUse.write', { tool_input: { path: p(w, 'backend', 'x.ts') } }),
      antigravity: () =>
        run(w, 'antigravity', 'PreToolUse.replace_file_content', {
          toolCall: { name: 'replace_file_content', args: { TargetFile: p(w, 'backend', 'x.ts') } },
        }),
      gemini: () => run(w, 'gemini', 'BeforeTool.replace', { tool_input: { file_path: p(w, 'backend', 'x.ts') } }),
    };
    const inside = {
      cursor: () => run(w, 'cursor', 'preToolUse.write', { tool_input: { path: p(w, 'src', 'cursor', 'a.ts') } }),
      antigravity: () =>
        run(w, 'antigravity', 'PreToolUse.write_to_file', {
          toolCall: { name: 'write_to_file', args: { TargetFile: p(w, 'src', 'antigravity', 'a.ts') } },
        }),
      gemini: () =>
        run(w, 'gemini', 'BeforeTool.write_file', { tool_input: { file_path: p(w, 'src', 'gemini', 'a.ts') } }),
    };
    for (const vendor of OTHER_VENDORS) {
      const out = await outside[vendor]();
      expect(decided(vendor, out), vendor).toEqual({
        decision: 'deny',
        reason: expect.stringContaining(`outside the scope of ${s[vendor]?.task.task_id}`),
      });
      if (vendor !== 'antigravity') expect(out.code, vendor).toBe(2);
      const ok = await inside[vendor]();
      expect([ok.code, decided(vendor, ok).decision], vendor).toEqual([0, null]);
    }
    // One rule decided all four, each recorded once with the session's agent as the actor.
    const evaluated = td.daemon.state.store
      .readSince(pid, 0, { types: ['policy.evaluated'], limit: 1000 })
      .map((e) => (e.payload as { rule: string }).rule);
    expect(evaluated.filter((r) => r === 'write.outside_scope')).toHaveLength(4);
    expect(evaluated.filter((r) => r === 'write.in_scope')).toHaveLength(3);

    // A command a human decides: asked in the hosts' own way, as Claude Code is asked.
    const claudeCommit = await runLauncher(
      claudeFile,
      'PreToolUse',
      toolHook(
        'PreToolUse',
        'Bash',
        { command: 'git commit -m "fixture"' },
        {
          projectDir: w.projectDir,
          sessionId: 'sess-hosts-claude',
        },
      ),
      { CLAUDE_PROJECT_DIR: w.projectDir, FRIDAY_STATE_DIR: w.stateDir },
    );
    expect(decisionOf(claudeCommit.json)?.decision).toBe('ask');
    expect(decided('cursor', await run(w, 'cursor', 'beforeShellExecution')).decision).toBe('ask');
    expect((await run(w, 'antigravity', 'PreToolUse.run_command')).json?.decision).toBe('force_ask');
    expect(decided('gemini', await run(w, 'gemini', 'BeforeTool.run_shell_command')).decision).toBe('ask');

    // Each session is the host's own, linked by the host's session id, at the level its hooks give:
    // Cursor without Friday's .cursor/hooks.json is unverified, what Antigravity does with a failing
    // hook is not documented, and Gemini CLI fails open.
    const levels: Record<OtherVendor, string> = { cursor: 'unverified', antigravity: 'unverified', gemini: 'degraded' };
    for (const vendor of OTHER_VENDORS) {
      const h = td.daemon.state.q.harnessBySession(pid, vendor, s[vendor]?.sessionId as string);
      expect(h?.vendor, vendor).toBe(vendor);
      expect(h?.hooks_seen_at, vendor).toBeTruthy();
      expect([h?.enforcement_level, h?.enforcement_status], vendor).toEqual(['L1', levels[vendor]]);
    }
  });

  it('gives each host its context at session start, asks through a pending approval where the hook cannot ask, and nudges a stop once', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const w = ws();
    const s = await sessions(td);
    const cursorStart = (await run(w, 'cursor', 'sessionStart')).json?.additional_context;
    expect(cursorStart).toContain('<friday-context');
    expect(cursorStart).toContain(s.cursor?.task.task_id);
    const agStart = (await run(w, 'antigravity', 'SessionStart')).json?.injectSteps as [
      { systemMessage: { systemMessage: string } },
    ];
    expect(agStart[0].systemMessage.systemMessage).toContain(s.antigravity?.task.task_id);
    const gemStart = (await run(w, 'gemini', 'SessionStart')).json?.hookSpecificOutput as { additionalContext: string };
    expect(gemStart.additionalContext).toContain(s.gemini?.task.task_id);

    // Cursor's preToolUse cannot ask: a human's decision is one pending approval, and the call waits for it.
    const fetch1 = await run(w, 'cursor', 'preToolUse.webfetch');
    expect(decided('cursor', fetch1)).toEqual({
      decision: 'deny',
      reason: expect.stringMatching(/A human decides this \(approval [a-z]+_[0-9a-z]+\)/),
    });
    const fetch2 = await run(w, 'cursor', 'preToolUse.webfetch');
    expect(decided('cursor', fetch2).reason).toBe(decided('cursor', fetch1).reason);
    expect(td.daemon.state.q.approvals(td.project.project_id, 'pending')).toHaveLength(1);

    // A stop the human made (Cursor's "aborted"), or one at a step limit, is never held: the host
    // would send Friday's message as the next prompt, against the human's decision.
    expect((await run(w, 'cursor', 'stop.aborted')).stdout).toBe('{}');
    expect((await run(w, 'antigravity', 'Stop.max_steps')).stdout).toBe('{}');
    // Stops: a RUNNING task with nothing reported holds the session once; the next stop passes.
    const followups = [];
    for (let i = 0; i < 3; i += 1) followups.push((await run(w, 'cursor', 'stop')).json?.followup_message ?? null);
    expect(followups[0]).toContain(s.cursor?.task.task_id);
    expect(followups[1]).toBeNull();
    expect(followups[2]).toContain('nothing was reported this turn');
    const agStop = await run(w, 'antigravity', 'Stop');
    expect(agStop.json).toMatchObject({
      decision: 'continue',
      reason: expect.stringContaining('friday_report_progress'),
    });
    // Gemini CLI says when it is already continuing for a stop hook.
    const gemStop = await run(w, 'gemini', 'AfterAgent');
    expect(gemStop.json).toMatchObject({ decision: 'deny', reason: expect.stringContaining('friday_report_progress') });
    expect((await run(w, 'gemini', 'AfterAgent', { stop_hook_active: true })).stdout).toBe('');
  });

  it('serves only the hosts it knows', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    const unknown = await postVendorHook(daemon, 'october', 'PreToolUse', { hook: {} });
    expect(unknown.status).toBe(400);
    const gem = await postVendorHook(daemon, 'gemini', 'PreToolUse', {
      host_pid: 1234,
      hook: {
        hook_event_name: 'PreToolUse',
        session_id: 'g-1',
        tool_name: 'Write',
        tool_input: { file_path: 'src/a.ts' },
      },
      host: { vendor: 'gemini', event: 'BeforeTool', tool_name: 'write_file', version: null, can_ask: true },
    });
    expect(gem.status).toBe(200);
    // An unknown session's write is judged as Claude Code's is; Claude Code's output stays empty for another host.
    const claude = await postHook(daemon, 'PreToolUse', {
      hook_event_name: 'PreToolUse',
      session_id: 'c-1',
      tool_name: 'Write',
      tool_input: { file_path: 'src/a.ts' },
    });
    const claudeDecision = decisionOf(claude.body.hook_output);
    expect(claudeDecision).not.toBeNull();
    expect(gem.body).toMatchObject({
      ok: true,
      hook_output: null,
      judgment: { decision: claudeDecision?.decision, reason: claudeDecision?.reason.replace(/^Friday: /, '') },
    });
    const protectedWrite = await postVendorHook(daemon, 'gemini', 'PreToolUse', {
      host_pid: 1234,
      hook: {
        hook_event_name: 'PreToolUse',
        session_id: 'g-1',
        tool_name: 'Write',
        tool_input: { file_path: path.join(td.project.root, '.gemini', 'settings.json') },
      },
    });
    expect(protectedWrite.body).toMatchObject({
      judgment: { decision: 'deny', reason: expect.stringContaining('host.config') },
    });
    const mismatch = await postVendorHook(daemon, 'cursor', 'Stop', { hook: { hook_event_name: 'PreToolUse' } });
    expect(mismatch.status).toBe(400);
  });
});
