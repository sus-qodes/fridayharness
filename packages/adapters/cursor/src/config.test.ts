import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { hostModule, LAUNCHER_BUDGET_MS, LAUNCHER_DEFAULT_BUDGET_MS, launcherArgs } from '@friday/adapter-claude';
import { createFridayTools, type FridaySession } from '@friday/mcp-server';
import { renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyCursorPlan, mergeCursorHooks, planCursor } from './config.js';
import {
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_SCRIPT,
  CURSOR_LAUNCH_MCP,
  CURSOR_MCP_ENTRY,
  CURSOR_RULE_MDC,
  cursorHookCommand,
  fridayCursorHooks,
  SPAWN_RUN_ENV,
} from './templates.js';

const ws = useTestWorkspace();
const PROJECT_ID = `proj_${'0'.repeat(24)}c1`;
const HOOK = '// friday-hook-launcher-version: 0.2.0\n// a stand-in launcher for these tests\n';

function project(): string {
  const dir = ws().projectDir;
  mkdirSync(path.join(dir, '.friday'), { recursive: true });
  writeFileSync(path.join(dir, '.friday', 'config.yaml'), renderInitialConfig(PROJECT_ID, 'cursor-test'));
  return dir;
}
const env = () => ({ FRIDAY_STATE_DIR: ws().stateDir });
const plan = (opts: { remove?: boolean; agentKey?: string } = {}) =>
  planCursor({ projectDir: ws().projectDir, hookSource: HOOK, env: env(), ...opts });
const readJson = (...p: string[]) =>
  JSON.parse(readFileSync(path.join(ws().projectDir, ...p), 'utf8')) as Record<string, unknown>;
const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name],
      )
    : [];

describe('the Cursor hook templates', () => {
  it('configures each Cursor event Friday judges, each mapped by the launcher and waiting longer than its budget', () => {
    const hooks = fridayCursorHooks();
    expect(Object.keys(hooks)).toEqual([
      'sessionStart',
      'preToolUse',
      'beforeShellExecution',
      'beforeMCPExecution',
      'beforeReadFile',
      'postToolUse',
      'postToolUseFailure',
      'stop',
    ]);
    for (const event of CURSOR_HOOK_EVENTS) {
      const [entry, ...rest] = hooks[event];
      expect(rest).toEqual([]);
      expect(entry).toEqual({
        type: 'command',
        command: cursorHookCommand(event),
        timeout: entry?.timeout,
        failClosed: true,
      });
      // The launcher reads the command's arguments as Cursor's vendor and this event.
      const argv = ['node', ...(entry?.command.split(' ').slice(1) ?? [])];
      expect(argv[1]).toBe(CURSOR_HOOK_SCRIPT);
      expect(launcherArgs(argv)).toEqual({ vendor: 'cursor', event });
      const friday = hostModule('cursor').normalize({}, event, {}).event;
      expect(friday, event).not.toBeNull();
      const budget = LAUNCHER_BUDGET_MS[friday as string] ?? LAUNCHER_DEFAULT_BUDGET_MS;
      expect((entry?.timeout ?? 0) * 1000, event).toBeGreaterThan(budget);
    }
  });

  it('names the MCP server friday and starts it from the tracked launcher, with no machine path', () => {
    expect(CURSOR_MCP_ENTRY).toEqual({
      type: 'stdio',
      command: 'node',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's placeholder, written as is.
      args: ['${workspaceFolder}/.friday/harness/cursor/launch-mcp.mjs'],
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor's placeholder, written as is.
      env: { FRIDAY_HARNESS: 'cursor', FRIDAY_PROJECT_DIR: '${workspaceFolder}' },
    });
  });

  it('writes a rule Cursor applies to every request, naming only tools Friday has', () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(CURSOR_RULE_MDC);
    expect(m?.[1]).toMatch(/^description: .+$/m);
    expect(m?.[1]).toMatch(/^alwaysApply: true$/m);
    const tools = new Set(createFridayTools({} as FridaySession).map((t) => t.name));
    const named = [...new Set(CURSOR_RULE_MDC.match(/friday_[a-z_]+/g) ?? [])];
    expect(named.filter((t) => !tools.has(t))).toEqual([]);
    expect(named).toEqual(expect.arrayContaining(['friday_whoami', 'friday_task_claim', 'friday_claim_done']));
    // Read on every request: kept short (about 400 tokens).
    expect(CURSOR_RULE_MDC.length).toBeLessThan(2600);
  });

  it("starts the MCP server as Claude Code's launcher does, worded for Cursor, and not in a session Friday spawned", () => {
    expect(CURSOR_LAUNCH_MCP).not.toMatch(/Claude Code|claude-code/);
    expect(CURSOR_LAUNCH_MCP).toContain('"friday harness config cursor"');
    expect(CURSOR_LAUNCH_MCP.indexOf(SPAWN_RUN_ENV)).toBeLessThan(CURSOR_LAUNCH_MCP.indexOf('install.json'));
    const file = path.join(ws().root, 'launch-mcp.mjs');
    writeFileSync(file, CURSOR_LAUNCH_MCP);
    const run = (extra: Record<string, string>) =>
      spawnSync(process.execPath, [file], {
        env: { ...process.env, FRIDAY_STATE_DIR: ws().stateDir, FRIDAY_MCP_ENTRY: '', ...extra },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 15_000,
      });
    const spawned = run({ [SPAWN_RUN_ENV]: 'run_x' });
    expect(spawned.status).toBe(0);
    expect(spawned.stderr).toMatch(/started by Friday, which gives it Friday's tools itself/);
    const unset = run({});
    expect(unset.status).toBe(1);
    expect(unset.stderr).toMatch(/Friday is not set up on this machine.*then restart Cursor/);
  });
});

describe('friday harness config cursor', () => {
  it('writes every file once, keeps the user’s entries, and takes out only what it added', () => {
    const root = project();
    mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const userHook = { command: './scripts/format.sh', timeout: 3 };
    writeFileSync(
      path.join(root, '.cursor', 'hooks.json'),
      JSON.stringify({ version: 1, hooks: { afterFileEdit: [userHook], preToolUse: [userHook] } }),
    );
    writeFileSync(
      path.join(root, '.cursor', 'mcp.json'),
      JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example.invalid/mcp' } } }),
    );
    const first = plan({ agentKey: 'cu-dev' });
    expect(first.map((c) => c.display).sort()).toEqual(
      [
        '(private) agent.json',
        '.cursor/hooks.json',
        '.cursor/mcp.json',
        '.cursor/rules/friday.mdc',
        '.friday/harness/cursor/README.md',
        '.friday/harness/cursor/hook.mjs',
        '.friday/harness/cursor/launch-mcp.mjs',
      ].sort(),
    );
    applyCursorPlan(first, root);
    // A second run changes nothing.
    expect(plan({ agentKey: 'cu-dev' })).toEqual([]);
    const hooks = readJson('.cursor', 'hooks.json') as { version: number; hooks: Record<string, unknown[]> };
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.afterFileEdit).toEqual([userHook]);
    // The user's own preToolUse hook stays first; Friday's comes after it.
    expect(hooks.hooks.preToolUse).toEqual([userHook, ...fridayCursorHooks().preToolUse]);
    expect((readJson('.cursor', 'mcp.json') as { mcpServers: Record<string, unknown> }).mcpServers).toEqual({
      docs: { url: 'https://docs.example.invalid/mcp' },
      friday: CURSOR_MCP_ENTRY,
    });
    // One backup of each user file Friday rewrote today.
    const backups = files(path.join(root, '.cursor')).filter((f) => f.endsWith('.bak'));
    expect(backups.map((f) => f.replace(/\.friday-\d{4}-\d{2}-\d{2}\.bak$/, '')).sort()).toEqual([
      'hooks.json',
      'mcp.json',
    ]);
    // Nothing Friday wrote into the project names this machine's folders.
    for (const dir of [path.join(root, '.cursor'), path.join(root, '.friday', 'harness')]) {
      for (const f of files(dir)) {
        const text = readFileSync(path.join(dir, f), 'utf8');
        expect(text.includes(ws().root) || text.includes(ws().root.replaceAll('\\', '/')), f).toBe(false);
      }
    }
    expect(
      JSON.parse(readFileSync(first.find((c) => c.display === '(private) agent.json')?.path as string, 'utf8')),
    ).toEqual({
      agent_key: 'cu-dev',
    });

    const removal = plan({ remove: true });
    applyCursorPlan(removal, root);
    expect(readJson('.cursor', 'hooks.json')).toEqual({
      version: 1,
      hooks: { afterFileEdit: [userHook], preToolUse: [userHook] },
    });
    expect(readJson('.cursor', 'mcp.json')).toEqual({
      mcpServers: { docs: { url: 'https://docs.example.invalid/mcp' } },
    });
    expect(existsSync(path.join(root, '.cursor', 'rules'))).toBe(false);
    expect(existsSync(path.join(root, '.friday', 'harness', 'cursor'))).toBe(false);
    expect(plan({ remove: true })).toEqual([]);
  });

  it('removes the files it created whole, and the folders they leave empty', () => {
    const root = project();
    applyCursorPlan(plan(), root);
    applyCursorPlan(plan({ remove: true }), root);
    expect(existsSync(path.join(root, '.cursor'))).toBe(false);
    expect(existsSync(path.join(root, '.friday', 'harness'))).toBe(false);
  });

  it('leaves a friday.mdc that is not Friday’s alone, and refuses a hooks file of another version', () => {
    const root = project();
    mkdirSync(path.join(root, '.cursor', 'rules'), { recursive: true });
    writeFileSync(path.join(root, '.cursor', 'rules', 'friday.mdc'), '---\nalwaysApply: false\n---\nmy own notes\n');
    expect(plan().some((c) => c.display === '.cursor/rules/friday.mdc')).toBe(false);
    writeFileSync(path.join(root, '.cursor', 'hooks.json'), JSON.stringify({ version: 2, hooks: {} }));
    expect(() => plan()).toThrow(/version 2; Friday writes version 1 only/);
    expect(() => mergeCursorHooks({ version: 1, hooks: {} }, true)).not.toThrow();
  });
});
