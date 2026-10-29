/**
 * The host modules of the hook launcher (plan M8b.1), from hand-written fixtures of each host's
 * documented hook input: each input becomes Friday's one shape, and each of Friday's judgments
 * becomes the host's reply and exit code. Friday only restricts: no reply ever allows or approves.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  actionFromTool,
  CURSOR_LAUNCHER_FILE,
  CURSOR_PERMISSION_HOOKS,
  claudeHookOutput,
  cursorHookFailure,
  cursorRunsFriday,
  HOST_MODULES,
  type HookJudgment,
  type HookVendor,
  hostModule,
  importedByCursor,
  importedCursorCall,
  launcherArgs,
  type NormalizedHook,
  stripHookPayload,
  webFetchUrls,
  wireHook,
  wireHost,
} from '@friday/adapter-claude';
import { evaluate, evaluateSensitive, type PolicyAction } from '@friday/policy';
import { describe, expect, it } from 'vitest';
import { hookFixture, hookFixtureNames } from '../helpers/hooks.js';
import { hostFixture, hostFixtureNames, OTHER_VENDORS, type OtherVendor } from './host-rig.js';

const PROJECT = path.join(os.tmpdir(), 'friday-hosts', 'shop');
const p = (...parts: string[]) => path.join(PROJECT, ...parts);

const load = (vendor: OtherVendor, name: string) => {
  const f = hostFixture(vendor, name, PROJECT);
  return { f, input: hostModule(vendor).normalize(f.input, f.event, {}) };
};

/** What each fixture must become: the fields that matter, everything else as the module says. */
const EXPECTED: Record<OtherVendor, Record<string, Partial<NormalizedHook>>> = {
  cursor: {
    sessionStart: {
      event: 'SessionStart',
      session_id: 'conv_fixture_1',
      host_version: '3.24.0',
      model: 'fixture-model-id',
      source: 'startup',
      project_dir: PROJECT,
    },
    'preToolUse.write': {
      event: 'PreToolUse',
      tool_name: 'Write',
      host_tool_name: 'Write',
      tool_input: { file_path: p('src', 'a.ts') },
      paths: [p('src', 'a.ts')],
      can_ask: false,
      judging: 'full',
      cwd: PROJECT,
    },
    'preToolUse.read': { event: 'PreToolUse', tool_name: 'Read', paths: [p('README.md')], can_ask: false },
    'preToolUse.shell': { event: 'PreToolUse', tool_name: null, host_tool_name: 'Shell', judging: 'defer' },
    'preToolUse.mcp': { event: 'PreToolUse', tool_name: null, host_tool_name: 'MCP:search_code', judging: 'defer' },
    'preToolUse.task': { event: 'PreToolUse', tool_name: null, host_tool_name: 'Task', judging: 'full' },
    'preToolUse.webfetch': { event: 'PreToolUse', tool_name: 'WebFetch', can_ask: false },
    beforeShellExecution: {
      event: 'PreToolUse',
      tool_name: 'Shell',
      command: 'git commit -m "fixture"',
      can_ask: true,
      cwd: PROJECT,
    },
    beforeMCPExecution: {
      event: 'PreToolUse',
      tool_name: 'mcp__github__search_code',
      host_tool_name: 'search_code',
      tool_input: { query: 'checkout' },
      can_ask: true,
    },
    'beforeMCPExecution.friday': { tool_name: 'mcp__friday__friday_whoami' },
    beforeReadFile: {
      event: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: p('.env') },
      judging: 'local',
      can_ask: false,
    },
    postToolUse: { event: 'PostToolUse', tool_name: 'Write', paths: [p('src', 'a.ts')] },
    postToolUseFailure: {
      event: 'PostToolUseFailure',
      tool_name: 'Shell',
      command: 'npm test',
      error: 'Command timed out',
    },
    stop: { event: 'Stop', stop_hook_active: null, stop_completed: true, stop_reason: 'completed' },
    // A human's stop: never held, or Cursor would send Friday's message as the next prompt.
    'stop.aborted': { event: 'Stop', stop_completed: false, stop_reason: 'aborted' },
    sessionEnd: { event: 'SessionEnd', reason: 'user_close', session_id: 'conv_fixture_1' },
  },
  antigravity: {
    SessionStart: {
      event: 'SessionStart',
      session_id: 'conv-fixture-1',
      model: 'fixture-model',
      project_dir: PROJECT,
      source: 'startup',
      host_version: null,
    },
    'PreToolUse.run_command': {
      event: 'PreToolUse',
      tool_name: 'Shell',
      host_tool_name: 'run_command',
      command: 'git commit -m "fixture"',
      cwd: PROJECT,
      can_ask: true,
    },
    'PreToolUse.write_to_file': { tool_name: 'Write', tool_input: { file_path: p('src', 'a.ts') } },
    'PreToolUse.replace_file_content': { tool_name: 'Edit', paths: [p('src', 'a.ts')] },
    'PreToolUse.view_file': {
      tool_name: 'Read',
      tool_input: { file_path: p('README.md'), offset: 1, limit: 40 },
    },
    'PreToolUse.grep_search': { tool_name: 'Grep', paths: [PROJECT] },
    'PreToolUse.invoke_subagent': { tool_name: null, host_tool_name: 'invoke_subagent' },
    'PreToolUse.view_file.friday-db': { tool_name: 'Read', paths: [p('.friday', 'project.db')] },
    'PreToolUse.view_file.lines': {
      tool_name: 'Read',
      tool_input: { file_path: p('src', 'cart.ts'), offset: 10, limit: 20 },
    },
    'PreToolUse.write_to_file.no-path': { tool_name: 'Write', paths: [] },
    'PreToolUse.multi_replace_file_content': { tool_name: 'Edit', paths: [p('src', 'cart.ts')] },
    'PreToolUse.list_dir': { tool_name: 'Glob', tool_input: { path: p('src') } },
    'PreToolUse.find_by_name': { tool_name: 'Glob', tool_input: { pattern: '*.test.ts', path: PROJECT } },
    'PreToolUse.search_web': { tool_name: 'WebSearch', tool_input: { query: 'stripe idempotency keys' } },
    'PreToolUse.read_url_content': { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/docs' } },
    // How Antigravity names MCP tools in hook input is not documented: both spellings are read.
    'PreToolUse.mcp-double': { tool_name: 'mcp__github__search_code', tool_input: { query: 'checkout' } },
    'PreToolUse.mcp-single': { tool_name: 'mcp__github__search_code', host_tool_name: 'mcp_github_search_code' },
    'PreToolUse.mcp-friday': { tool_name: 'mcp__friday__friday_whoami' },
    'PreToolUse.ask_question': { event: 'PreToolUse', tool_name: null, host_tool_name: 'ask_question' },
    PreInvocation: { event: null },
    PostToolUse: { event: 'PostToolUse', tool_name: 'Shell', error: null },
    'PostToolUse.error': { event: 'PostToolUseFailure', tool_name: 'Shell', error: 'exit status 1' },
    Stop: { event: 'Stop', stop_hook_active: null, stop_completed: true, stop_reason: 'model_stop' },
    'Stop.max_steps': { event: 'Stop', stop_completed: false, stop_reason: 'max_steps_exceeded' },
  },
  gemini: {
    SessionStart: {
      event: 'SessionStart',
      session_id: 'gemini-session-fixture-1',
      source: 'startup',
      cwd: PROJECT,
      host_version: null,
      model: null,
    },
    'BeforeTool.run_shell_command': {
      event: 'PreToolUse',
      tool_name: 'Shell',
      host_tool_name: 'run_shell_command',
      command: 'git commit -m "fixture"',
      can_ask: true,
    },
    'BeforeTool.write_file': { tool_name: 'Write', tool_input: { file_path: p('src', 'a.ts') } },
    'BeforeTool.replace': { tool_name: 'Edit', paths: [p('src', 'a.ts')] },
    'BeforeTool.read_file': { tool_name: 'Read', tool_input: { file_path: p('README.md'), offset: 1, limit: 40 } },
    'BeforeTool.mcp': {
      tool_name: 'mcp__github__search_code',
      host_tool_name: 'mcp_github_search_code',
      tool_input: { query: 'checkout' },
    },
    'BeforeTool.mcp-friday': { tool_name: 'mcp__friday__friday_whoami' },
    'BeforeTool.write_todos': { event: 'PreToolUse', tool_name: null, host_tool_name: 'write_todos' },
    // Every URL the prompt names is the one target judged, so an approval covers exactly that set.
    'BeforeTool.web_fetch': {
      tool_name: 'WebFetch',
      tool_input: { url: 'https://docs.example.com/a https://other.example.net/b?d=1' },
    },
    // The folder the command runs in goes with it, so relative names are read from there.
    'BeforeTool.run_shell_command.dir_path': {
      tool_name: 'Shell',
      command: 'Get-Content logs/daemon.log',
      tool_input: { command: 'Get-Content logs/daemon.log', cwd: '.friday' },
    },
    AfterTool: { event: 'PostToolUse', tool_name: 'Write', paths: [p('src', 'a.ts')] },
    'AfterTool.error': { event: 'PostToolUseFailure', tool_name: 'Shell', error: 'exit code 1' },
    AfterAgent: { event: 'Stop', stop_hook_active: false, stop_completed: null },
    SessionEnd: { event: 'SessionEnd', reason: 'exit' },
  },
};

describe('host modules read their hosts’ hook input', () => {
  for (const vendor of OTHER_VENDORS) {
    it(`${vendor}: every fixture becomes the expected Friday input, and every fixture is covered`, () => {
      const names = hostFixtureNames(vendor).filter((n) => !n.endsWith('.claude-import'));
      expect(names.sort()).toEqual(Object.keys(EXPECTED[vendor]).sort());
      for (const name of names) {
        const { input } = load(vendor, name);
        expect(input.vendor, name).toBe(vendor);
        expect(input, name).toMatchObject(EXPECTED[vendor][name] ?? {});
      }
    });

    it(`${vendor}: every key of every fixture is one the module knows (drift check)`, () => {
      const known = HOST_MODULES[vendor].knownKeys;
      for (const name of hostFixtureNames(vendor).filter((n) => !n.endsWith('.claude-import'))) {
        const { f, input } = load(vendor, name);
        const keys = known[f.event];
        // An event Friday does nothing with (Antigravity's PreInvocation) has no keys to drift from.
        if (!keys && input.event === null) continue;
        expect(keys, `${name}: unknown event ${f.event}`).toBeDefined();
        expect(
          Object.keys(f.input).filter((k) => !keys?.includes(k)),
          `${name}: keys the module does not know`,
        ).toEqual([]);
      }
    });

    it(`${vendor}: what is sent to the daemon carries no file body, e-mail or transcript path`, () => {
      for (const name of hostFixtureNames(vendor).filter((n) => !n.endsWith('.claude-import'))) {
        const { f, input } = load(vendor, name);
        const sent = JSON.stringify({ hook: stripHookPayload(wireHook(input)), host: wireHost(input) });
        const machine = ['transcript_path', 'transcriptPath', 'artifactDirectoryPath']
          .map((k) => f.input[k])
          .filter((v): v is string => typeof v === 'string')
          .map((v) => JSON.stringify(v).slice(1, -1));
        for (const leak of ['FILE BODY', 'OLD BODY', 'NEW BODY', 'SECRET_IN_THE_FILE', 'example.invalid', ...machine]) {
          expect(sent.includes(leak), `${name} sends ${leak}`).toBe(false);
        }
        if (input.event) expect(JSON.parse(sent).hook.hook_event_name).toBe(input.event);
      }
    });
  }

  it('Claude Code: its own input is already Friday’s vocabulary', () => {
    const vars = { projectDir: PROJECT, sessionId: 'sess-hosts-1' };
    for (const name of hookFixtureNames()) {
      const raw = hookFixture(name, vars);
      const event = String(raw.hook_event_name);
      const input = hostModule('claude-code').normalize(raw, event, { CLAUDE_PROJECT_DIR: PROJECT });
      expect(input, name).toMatchObject({
        vendor: 'claude-code',
        event,
        host_event: event,
        session_id: 'sess-hosts-1',
        tool_name: (raw.tool_name as string | undefined) ?? null,
        host_tool_name: (raw.tool_name as string | undefined) ?? null,
        project_dir: PROJECT,
        judging: 'full',
        can_ask: true,
        shape_error: null,
      });
    }
  });

  it('a write whose path cannot be found is marked unreadable, so the launcher declines it', () => {
    const cursor = hostModule('cursor').normalize(
      { conversation_id: 'c', tool_name: 'Write', tool_input: { contents: 'x' } },
      'preToolUse',
      {},
    );
    expect(cursor.shape_error).toContain('Cursor Write');
    const gemini = hostModule('gemini').normalize(
      { session_id: 's', tool_name: 'write_file', tool_input: {} },
      'BeforeTool',
      {},
    );
    expect(gemini.shape_error).toContain('Gemini CLI write_file');
    const ag = hostModule('antigravity').normalize(
      { conversationId: 'c', toolCall: { name: 'write_to_file', args: { CodeContent: 'x' } } },
      'PreToolUse',
      {},
    );
    expect(ag.shape_error).toContain('Antigravity write_to_file');
    // After the call there is nothing to decline.
    expect(
      hostModule('gemini').normalize({ tool_name: 'write_file', tool_input: {} }, 'AfterTool', {}).shape_error,
    ).toBeNull();
  });

  it('Gemini CLI: web_fetch is judged by every URL it would fetch, read as the host reads them', () => {
    expect(
      webFetchUrls({ prompt: 'see https://b.example.com/x and https://a.example.com/y, then https://b.example.com/x' }),
    ).toEqual(['https://a.example.com/y,', 'https://b.example.com/x']);
    // Its `url` argument counts too; schemes it does not fetch, and words that are no URL, do not.
    expect(
      webFetchUrls({ url: 'https://c.example.com/', prompt: 'ftp://d.example.com/f http//e plain words' }),
    ).toEqual(['https://c.example.com/']);
    const one = hostModule('gemini').normalize(
      { session_id: 's', tool_name: 'web_fetch', tool_input: { prompt: 'read https://docs.example.com/a please' } },
      'BeforeTool',
      {},
    );
    expect(one.tool_input).toEqual({ url: 'https://docs.example.com/a' });
    // A grant for the first URL alone is not the target of a call that also fetches another.
    const two = load('gemini', 'BeforeTool.web_fetch').input;
    const action = actionFromTool(two.tool_name as string, two.tool_input ?? {});
    const approved = (_c: string, target: string) => target === 'https://docs.example.com/a';
    expect(
      evaluate({ action: action as PolicyAction, ctx: { projectRoot: PROJECT }, task: null, approved }).decision,
    ).toBe('ask');
  });

  it('a shell call’s working folder is judged: inside .friday, .git or Friday’s state it is refused', () => {
    const ctx = { projectRoot: PROJECT, stateDir: path.join(os.tmpdir(), 'friday-hosts', 'state') };
    const judged = (vendor: OtherVendor, name: string, patch: Record<string, unknown>) => {
      const input = hostModule(vendor).normalize(
        hostFixture(vendor, name, PROJECT, patch).input,
        hostFixture(vendor, name, PROJECT).event,
        {},
      );
      const action = actionFromTool(input.tool_name as string, input.tool_input ?? {});
      return action ? evaluateSensitive(action, ctx) : null;
    };
    expect(judged('gemini', 'BeforeTool.run_shell_command.dir_path', {})).toMatchObject({
      decision: 'deny',
      sensitive_class: 'friday.runtime',
    });
    expect(
      judged('antigravity', 'PreToolUse.run_command', {
        toolCall: { name: 'run_command', args: { CommandLine: 'type sessions\\x.json', Cwd: p('.friday') } },
      }),
    ).toMatchObject({ decision: 'deny', sensitive_class: 'friday.runtime' });
    expect(judged('cursor', 'beforeShellExecution', { command: 'cat config', cwd: p('.git') })).toMatchObject({
      decision: 'deny',
      sensitive_class: 'git.internal',
    });
    expect(judged('cursor', 'beforeShellExecution', { command: 'ls', cwd: ctx.stateDir })).toMatchObject({
      sensitive_class: 'friday.private',
    });
    // The project's own folders, and a folder whose name only starts the same way, are fine.
    expect(judged('cursor', 'beforeShellExecution', { command: 'ls', cwd: p('src') })).toBeNull();
    expect(
      judged('gemini', 'BeforeTool.run_shell_command.dir_path', {
        tool_input: { command: 'ls', dir_path: '.friday-notes' },
      }),
    ).toBeNull();
  });

  it('Cursor: whether the project’s hooks fail closed, read from .cursor/hooks.json for the level rule', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'friday-cursor-hooks-'));
    try {
      expect(cursorHookFailure(root)).toBeNull();
      expect(cursorRunsFriday(root)).toBe(false);
      mkdirSync(path.join(root, '.cursor'));
      const write = (failClosed: boolean | undefined, events = CURSOR_PERMISSION_HOOKS) =>
        writeFileSync(
          path.join(root, '.cursor', 'hooks.json'),
          JSON.stringify({
            version: 1,
            hooks: Object.fromEntries(
              events.map((e) => [
                e,
                [
                  { type: 'command', command: 'node other-tool.mjs' },
                  {
                    type: 'command',
                    command: `node ${CURSOR_LAUNCHER_FILE.replaceAll('/', '\\')} cursor ${e}`,
                    ...(failClosed === undefined ? {} : { failClosed }),
                  },
                ],
              ]),
            ),
          }),
        );
      write(true);
      expect(cursorHookFailure(root)).toBe('fail-closed');
      expect(cursorRunsFriday(root)).toBe(true);
      write(undefined);
      expect(cursorHookFailure(root)).toBe('fail-open');
      write(
        true,
        CURSOR_PERMISSION_HOOKS.filter((e) => e !== 'beforeShellExecution'),
      );
      expect(cursorHookFailure(root)).toBeNull();
      writeFileSync(path.join(root, '.cursor', 'hooks.json'), '{ not json');
      expect(cursorHookFailure(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('Cursor’s import of Claude Code’s hooks: the call in Friday’s terms, for the launcher’s own rules', () => {
    const f = hostFixture('cursor', 'PreToolUse.claude-import', PROJECT);
    expect(importedCursorCall(f.input, f.env ?? {})).toMatchObject({
      tool_name: 'Write',
      judging: 'local',
      paths: [p('src', 'a.ts')],
    });
    // A shell call there has no dedicated hook to defer to: its command is read here.
    expect(
      importedCursorCall({ ...f.input, tool_name: 'Shell', tool_input: { command: 'cat .env' } }, f.env ?? {}),
    ).toMatchObject({ tool_name: 'Shell', command: 'cat .env', judging: 'local' });
    expect(importedCursorCall({ ...f.input, hook_event_name: 'stop' }, f.env ?? {})).toBeNull();
  });

  it('host events Friday does nothing with have no Friday event', () => {
    expect(hostModule('cursor').normalize({}, 'afterAgentThought', {}).event).toBeNull();
    expect(hostModule('antigravity').normalize({}, 'PreInvocation', {}).event).toBeNull();
    expect(hostModule('gemini').normalize({}, 'BeforeModel', {}).event).toBeNull();
    // The launcher's argument names the event; the input's own name is the fallback.
    expect(hostModule('gemini').normalize({ hook_event_name: 'SessionEnd' }, '', {}).event).toBe('SessionEnd');
  });
});

const JUDGMENTS: HookJudgment[] = [
  { decision: 'none' },
  { decision: 'deny', reason: 'outside the scope' },
  { decision: 'ask', reason: 'a human decides git.mutate' },
  { decision: 'context', text: '<friday-context>packet</friday-context>' },
  { decision: 'context', text: 'Friday is not available', brief: true },
  { decision: 'continue', reason: 'report progress' },
];

/** A reply for `event` of `vendor` from a minimal input of that event. */
function renderFor(vendor: HookVendor, hostEvent: string, j: HookJudgment) {
  const m = hostModule(vendor);
  return m.render(j, m.normalize({}, hostEvent, {}));
}
const parsed = (s: string) => (s ? (JSON.parse(s) as Record<string, unknown>) : null);

describe('host modules write their hosts’ replies', () => {
  it('Cursor: deny blocks with exit 2 and says why; ask only where Cursor honours it; no decision is {}', () => {
    const deny = renderFor('cursor', 'preToolUse', { decision: 'deny', reason: 'outside the scope' });
    expect(deny.exit_code).toBe(2);
    expect(parsed(deny.stdout)).toEqual({
      permission: 'deny',
      user_message: 'Friday: outside the scope',
      agent_message: 'Friday: outside the scope',
    });
    expect(deny.stderr).toBe('Friday: outside the scope');
    // preToolUse and beforeReadFile cannot ask: a human's decision becomes a refusal that says so.
    for (const e of ['preToolUse', 'beforeReadFile']) {
      const ask = renderFor('cursor', e, { decision: 'ask', reason: 'network access needs a human' });
      expect(ask.exit_code, e).toBe(2);
      expect(parsed(ask.stdout)?.permission, e).toBe('deny');
      expect(String(parsed(ask.stdout)?.agent_message)).toContain('Cursor cannot ask a human from this hook');
    }
    for (const e of ['beforeShellExecution', 'beforeMCPExecution']) {
      const ask = renderFor('cursor', e, { decision: 'ask', reason: 'git.mutate' });
      expect([ask.exit_code, parsed(ask.stdout)], e).toEqual([
        0,
        { permission: 'ask', user_message: 'Friday: git.mutate', agent_message: 'Friday: git.mutate' },
      ]);
    }
    for (const e of ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile']) {
      expect(renderFor('cursor', e, { decision: 'none' }), e).toEqual({ stdout: '{}', stderr: '', exit_code: 0 });
    }
    expect(parsed(renderFor('cursor', 'sessionStart', { decision: 'context', text: 'ctx' }).stdout)).toEqual({
      additional_context: 'ctx',
    });
    expect(parsed(renderFor('cursor', 'stop', { decision: 'continue', reason: 'report' }).stdout)).toEqual({
      followup_message: 'Friday: report',
    });
    expect(renderFor('cursor', 'postToolUse', { decision: 'none' }).stdout).toBe('{}');
  });

  it('Antigravity: deny, force_ask for this call, no decision as {}; context as an injected step; always exit 0', () => {
    expect(renderFor('antigravity', 'PreToolUse', { decision: 'deny', reason: 'r' })).toEqual({
      stdout: JSON.stringify({ decision: 'deny', reason: 'Friday: r' }),
      stderr: '',
      exit_code: 0,
    });
    expect(parsed(renderFor('antigravity', 'PreToolUse', { decision: 'ask', reason: 'r' }).stdout)).toEqual({
      decision: 'force_ask',
      reason: 'Friday: r',
    });
    expect(renderFor('antigravity', 'PreToolUse', { decision: 'none' }).stdout).toBe('{}');
    expect(parsed(renderFor('antigravity', 'SessionStart', { decision: 'context', text: 'ctx' }).stdout)).toEqual({
      injectSteps: [{ systemMessage: { systemMessage: 'ctx' } }],
    });
    expect(parsed(renderFor('antigravity', 'Stop', { decision: 'continue', reason: 'report' }).stdout)).toEqual({
      decision: 'continue',
      reason: 'Friday: report',
    });
  });

  it('Gemini CLI: deny with exit 2 and the reason on stderr, ask, nothing for no decision; a refused answer to continue', () => {
    const deny = renderFor('gemini', 'BeforeTool', { decision: 'deny', reason: 'r' });
    expect([deny.exit_code, parsed(deny.stdout), deny.stderr]).toEqual([
      2,
      { decision: 'deny', reason: 'Friday: r' },
      'Friday: r',
    ]);
    expect(parsed(renderFor('gemini', 'BeforeTool', { decision: 'ask', reason: 'r' }).stdout)).toEqual({
      decision: 'ask',
      reason: 'Friday: r',
      systemMessage: 'Friday: r',
    });
    expect(renderFor('gemini', 'BeforeTool', { decision: 'none' })).toEqual({ stdout: '', stderr: '', exit_code: 0 });
    expect(parsed(renderFor('gemini', 'SessionStart', { decision: 'context', text: 'ctx' }).stdout)).toEqual({
      hookSpecificOutput: { additionalContext: 'ctx' },
    });
    expect(renderFor('gemini', 'AfterAgent', { decision: 'continue', reason: 'report' })).toEqual({
      stdout: JSON.stringify({ decision: 'deny', reason: 'Friday: report' }),
      stderr: '',
      exit_code: 0,
    });
    expect(renderFor('gemini', 'AfterTool', { decision: 'none' }).stdout).toBe('');
  });

  it('Claude Code: the shapes its router has always returned', () => {
    expect(claudeHookOutput({ decision: 'none' })).toBeNull();
    expect(claudeHookOutput({ decision: 'deny', reason: 'r' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Friday: r',
      },
    });
    expect(claudeHookOutput({ decision: 'context', text: 'note', brief: true })).toBe('note');
    expect(claudeHookOutput({ decision: 'context', text: 'ctx' })).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'ctx' },
    });
    expect(claudeHookOutput({ decision: 'continue', reason: 'r' })).toEqual({ decision: 'block', reason: 'Friday: r' });
    expect(renderFor('claude-code', 'PreToolUse', { decision: 'none' })).toEqual({
      stdout: '',
      stderr: '',
      exit_code: 0,
    });
  });

  it('no host module ever answers allow or approve, for any event and any judgment', () => {
    const APPROVING = new Set(['allow', 'auto_approve', 'approve', 'allow-once', 'allow-always']);
    for (const vendor of OTHER_VENDORS) {
      const m = HOST_MODULES[vendor];
      for (const hostEvent of Object.keys(m.knownKeys)) {
        for (const j of JUDGMENTS) {
          const out = parsed(renderFor(vendor, hostEvent, j).stdout);
          const values = [out?.permission, out?.decision].filter((v) => v !== undefined);
          for (const v of values)
            expect(APPROVING.has(String(v)), `${vendor} ${hostEvent} ${j.decision} → ${v}`).toBe(false);
        }
      }
    }
  });
});

describe('the launcher’s host argument and Cursor’s import of Claude Code’s hooks', () => {
  it('reads `<vendor> <event>`, and a first argument that is not a vendor as Claude Code’s event', () => {
    expect(launcherArgs(['node', 'hook.mjs', 'PreToolUse'])).toEqual({ vendor: 'claude-code', event: 'PreToolUse' });
    expect(launcherArgs(['node', 'hook.mjs', 'claude-code', 'Stop'])).toEqual({ vendor: 'claude-code', event: 'Stop' });
    expect(launcherArgs(['node', 'hook.mjs', 'gemini', 'BeforeTool'])).toEqual({
      vendor: 'gemini',
      event: 'BeforeTool',
    });
    expect(launcherArgs(['node', 'hook.mjs', 'cursor', 'preToolUse'])).toEqual({
      vendor: 'cursor',
      event: 'preToolUse',
    });
    expect(launcherArgs(['node', 'hook.mjs', 'antigravity', 'Stop'])).toEqual({ vendor: 'antigravity', event: 'Stop' });
    expect(launcherArgs(['node', 'hook.mjs'])).toEqual({ vendor: 'claude-code', event: 'unknown' });
  });

  it('knows Cursor’s import only when both the environment and the input say Cursor', () => {
    const f = hostFixture('cursor', 'PreToolUse.claude-import', PROJECT);
    expect(importedByCursor(f.env ?? {}, f.input)).toBe(true);
    expect(importedByCursor({ CURSOR_PROJECT_DIR: PROJECT }, { conversation_id: 'c' })).toBe(true);
    // A real Claude Code session started from a terminal inside Cursor: still judged.
    const claude = hookFixture('pre-tool-use.read', { projectDir: PROJECT });
    expect(importedByCursor(f.env ?? {}, claude)).toBe(false);
    // Cursor's input without Cursor's environment is not the import either.
    expect(importedByCursor({}, f.input)).toBe(false);
  });
});
