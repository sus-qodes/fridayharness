/**
 * Antigravity's hooks end to end without a daemon (plan M8b.3): hand-made inputs of the shapes on
 * Antigravity's hooks page (tests/fixtures/hooks/antigravity/, the launcher's one set) become Friday's one shape, and the
 * launcher, run exactly as the `.agents/hooks.json` Friday writes runs it, answers deny, force_ask
 * or nothing, never an approval. No Antigravity is started: the launcher gets the input on stdin.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostModule, type NormalizedHook } from '@friday/adapter-claude';
import { newId } from '@friday/protocol';
import { renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyAntigravityPlan, planAntigravity } from './config.js';
import { type AntigravityHookEvent, HOOK_EVENTS, hookCommand } from './templates.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURES = path.join(REPO, 'tests', 'fixtures', 'hooks', 'antigravity', 'v1.4');

interface Fixture {
  host: string;
  host_version: string;
  event: string;
  note: string;
  input: Record<string, unknown>;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in the fixtures.
const PROJECT_DIR = '${PROJECT_DIR}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in the fixtures.
const HOME = '${HOME}';

const fixtureNames = () =>
  readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();

/** A fixture with its placeholders filled in, paths with this OS's separator. */
function fixture(name: string, projectDir: string): Fixture {
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') {
      for (const [ph, value] of [
        [PROJECT_DIR, projectDir],
        [HOME, os.homedir()],
      ] as const)
        if (v.startsWith(ph)) return value + v.slice(ph.length).replace(/[\\/]/g, path.sep);
      return v;
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'))) as Fixture;
}

const SHOP = path.join(os.tmpdir(), 'friday-ag', 'shop');
const at = (...parts: string[]) => path.join(SHOP, ...parts);

/** What each fixture must become (the fields that matter). */
const EXPECTED: Record<string, Partial<NormalizedHook>> = {
  SessionStart: {
    event: 'SessionStart',
    session_id: 'conv-fixture-1',
    model: 'fixture-model',
    project_dir: SHOP,
    source: 'startup',
    host_version: null,
    tool_name: null,
  },
  'PreToolUse.run_command': {
    event: 'PreToolUse',
    tool_name: 'Shell',
    command: 'git commit -m "fixture"',
    cwd: SHOP,
    can_ask: true,
  },
  'PreToolUse.view_file.friday-db': { tool_name: 'Read', paths: [at('.friday', 'project.db')] },
  'PreToolUse.view_file.lines': {
    tool_name: 'Read',
    tool_input: { file_path: at('src', 'cart.ts'), offset: 10, limit: 20 },
  },
  'PreToolUse.write_to_file': {
    tool_name: 'Write',
    tool_input: { file_path: at('src', 'a.ts') },
    shape_error: null,
  },
  'PreToolUse.replace_file_content': { tool_name: 'Edit', paths: [at('src', 'a.ts')] },
  'PreToolUse.view_file': { tool_name: 'Read', tool_input: { file_path: at('README.md'), offset: 1, limit: 40 } },
  'PreToolUse.grep_search': { tool_name: 'Grep', paths: [SHOP] },
  'PreToolUse.invoke_subagent': { tool_name: null, host_tool_name: 'invoke_subagent' },
  'PreToolUse.write_to_file.no-path': { tool_name: 'Write', paths: [] },
  'PreToolUse.multi_replace_file_content': { tool_name: 'Edit', paths: [at('src', 'cart.ts')] },
  'PreToolUse.list_dir': { tool_name: 'Glob', tool_input: { path: at('src') } },
  'PreToolUse.find_by_name': { tool_name: 'Glob', tool_input: { pattern: '*.test.ts', path: SHOP } },
  'PreToolUse.search_web': { tool_name: 'WebSearch', tool_input: { query: 'stripe idempotency keys' } },
  'PreToolUse.read_url_content': { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/docs' } },
  'PreToolUse.mcp-double': { tool_name: 'mcp__github__search_code', tool_input: { query: 'checkout' } },
  'PreToolUse.mcp-single': { tool_name: 'mcp__github__search_code', host_tool_name: 'mcp_github_search_code' },
  'PreToolUse.mcp-friday': { tool_name: 'mcp__friday__friday_whoami' },
  'PreToolUse.ask_question': { event: 'PreToolUse', tool_name: null, host_tool_name: 'ask_question' },
  PostToolUse: { event: 'PostToolUse', tool_name: 'Shell', error: null, command: 'npm test' },
  'PostToolUse.error': { event: 'PostToolUseFailure', tool_name: 'Shell', error: 'exit status 1' },
  Stop: { event: 'Stop', stop_hook_active: null, session_id: 'conv-fixture-1', stop_completed: true },
  // A turn that ended at its step limit is not the model's own end of it: Friday never holds it.
  'Stop.max_steps': { event: 'Stop', stop_completed: false, stop_reason: 'max_steps_exceeded' },
  PreInvocation: { event: null },
};

/** The reply each fixture gets from the launcher with Friday down: a decision, or none (`{}`). */
const WITH_FRIDAY_DOWN: Record<string, 'deny' | 'force_ask' | 'none' | 'context'> = {
  SessionStart: 'context',
  'PreToolUse.run_command': 'force_ask',
  'PreToolUse.view_file.friday-db': 'deny',
  'PreToolUse.view_file.lines': 'none',
  'PreToolUse.write_to_file': 'deny',
  'PreToolUse.write_to_file.no-path': 'deny',
  'PreToolUse.replace_file_content': 'deny',
  'PreToolUse.view_file': 'none',
  'PreToolUse.grep_search': 'none',
  'PreToolUse.invoke_subagent': 'none',
  'PreToolUse.multi_replace_file_content': 'deny',
  'PreToolUse.list_dir': 'none',
  'PreToolUse.find_by_name': 'none',
  'PreToolUse.search_web': 'force_ask',
  'PreToolUse.read_url_content': 'force_ask',
  'PreToolUse.mcp-double': 'force_ask',
  'PreToolUse.mcp-single': 'force_ask',
  'PreToolUse.mcp-friday': 'none',
  'PreToolUse.ask_question': 'none',
  PostToolUse: 'none',
  'PostToolUse.error': 'none',
  Stop: 'none',
  'Stop.max_steps': 'none',
  PreInvocation: 'none',
};

describe('the Antigravity module reads the documented hook input', () => {
  it('every fixture becomes the expected Friday input, and every fixture is covered', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(fixtureNames());
    expect(Object.keys(WITH_FRIDAY_DOWN).sort()).toEqual(fixtureNames());
    for (const name of fixtureNames()) {
      const f = fixture(name, SHOP);
      expect(f.host, name).toBe('antigravity');
      const got = hostModule('antigravity').normalize(f.input, f.event, {});
      expect(got, name).toMatchObject(EXPECTED[name] as object);
      expect(got.vendor).toBe('antigravity');
      expect(got.judging, name).toBe('full');
    }
  });

  it('every key of every fixture of a configured event is one the module knows (drift check)', () => {
    const known = hostModule('antigravity').knownKeys;
    for (const name of fixtureNames()) {
      const f = fixture(name, SHOP);
      if (!HOOK_EVENTS.includes(f.event as AntigravityHookEvent)) continue;
      for (const key of Object.keys(f.input)) expect(known[f.event], `${name}: ${key}`).toContain(key);
    }
  });

  it('a write whose target is missing is declined with a reason, and no file body is kept', () => {
    const missing = hostModule('antigravity').normalize(
      fixture('PreToolUse.write_to_file.no-path', SHOP).input,
      'PreToolUse',
      {},
    );
    expect(missing.shape_error).toMatch(/could not find the file/);
    const write = hostModule('antigravity').normalize(
      fixture('PreToolUse.write_to_file', SHOP).input,
      'PreToolUse',
      {},
    );
    expect(JSON.stringify(write)).not.toContain('FILE BODY');
  });
});

describe('the launcher as .agents/hooks.json runs it, with Friday down', () => {
  const ws = useTestWorkspace({ prefix: 'fri-agh-' });

  /** A Friday project with Antigravity configured; returns the commands its hooks.json runs. */
  function attached(): Record<string, string> {
    mkdirSync(path.join(ws().projectDir, '.friday'), { recursive: true });
    writeFileSync(path.join(ws().projectDir, '.friday', 'config.yaml'), renderInitialConfig(newId('proj'), 'ag-hooks'));
    applyAntigravityPlan(planAntigravity({ projectDir: ws().projectDir, env: { FRIDAY_STATE_DIR: ws().stateDir } }));
    const group = JSON.parse(readFileSync(path.join(ws().projectDir, '.agents', 'hooks.json'), 'utf8')).friday;
    const commands: Record<string, string> = {};
    for (const event of HOOK_EVENTS) {
      const entry = group[event][0];
      commands[event] = (entry.hooks ? entry.hooks[0] : entry).command;
    }
    return commands;
  }

  /** The environment of a hook: this process's, without another host's variables, Friday's state dir. */
  const hookEnv = () => {
    const env: NodeJS.ProcessEnv = { ...process.env, FRIDAY_STATE_DIR: ws().stateDir };
    for (const k of Object.keys(env)) if (/^(CLAUDE|CURSOR_|GEMINI_|AGY_|FRIDAY_AGENT$)/.test(k)) delete env[k];
    return env;
  };

  /** Runs one hook command from the workspace root, as Antigravity's own examples assume. */
  function run(command: string, input: Record<string, unknown>) {
    const [program, ...args] = command.split(' ');
    expect(program).toBe('node');
    const r = spawnSync(process.execPath, args, {
      cwd: ws().projectDir,
      input: JSON.stringify(input),
      env: hookEnv(),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: JSON.parse(r.stdout || 'null') };
  }

  it('answers each fixture deny, force_ask or nothing, always on stdout with exit code 0', () => {
    const commands = attached();
    expect(commands.PreToolUse).toBe(hookCommand('PreToolUse'));
    for (const name of fixtureNames()) {
      const f = fixture(name, ws().projectDir);
      const command = commands[f.event] ?? `node .friday/harness/antigravity/hook.mjs antigravity ${f.event}`;
      const r = run(command, f.input);
      expect(r.code, name).toBe(0);
      expect(r.stderr, name).toBe('');
      const want = WITH_FRIDAY_DOWN[name];
      if (want === 'none') expect(r.json, name).toEqual({});
      else if (want === 'context') {
        const text = r.json.injectSteps?.[0]?.systemMessage?.systemMessage;
        expect(text, name).toMatch(/^Friday is not available for this session \(the daemon is not running\)/);
      } else {
        expect(r.json.decision, name).toBe(want);
        expect(r.json.reason, name).toMatch(/^Friday: /);
      }
      // Friday restricts; it never answers for the human or the host's own policy.
      expect(['allow', 'auto_approve', 'ask', 'deny_unless_prior_grant'], name).not.toContain(r.json.decision);
      expect(r.stdout, name).not.toContain('FILE BODY');
    }
  });

  it('says why: a protected file, paused edits, a missing target, a human to confirm', () => {
    const commands = attached();
    const reason = (name: string) =>
      run(commands.PreToolUse as string, fixture(name, ws().projectDir).input).json.reason;
    expect(reason('PreToolUse.view_file.friday-db')).toMatch(/\.friday\/project\.db is protected by Friday/);
    expect(reason('PreToolUse.write_to_file')).toMatch(/edits are paused because Friday is unavailable/);
    expect(reason('PreToolUse.write_to_file.no-path')).toMatch(
      /could not find the file this Antigravity write_to_file/,
    );
    expect(reason('PreToolUse.run_command')).toMatch(/a human must confirm this/);
  });

  it('works when a shell runs the command string, as Antigravity runs hook commands', () => {
    const commands = attached();
    const input = JSON.stringify(fixture('PreToolUse.run_command', ws().projectDir).input);
    // Antigravity's CLI runs its commands in PowerShell on Windows; the hook's shell is not documented.
    const [shell, args] =
      process.platform === 'win32'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', commands.PreToolUse as string]]
        : ['/bin/sh', ['-c', commands.PreToolUse as string]];
    const r = spawnSync(shell, args, {
      cwd: ws().projectDir,
      input,
      env: hookEnv(),
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).decision).toBe('force_ask');
  });
});
