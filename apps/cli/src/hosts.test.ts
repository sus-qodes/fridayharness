import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyHostPlans,
  codexBlock,
  hostEntry,
  hostFile,
  machineLauncherPath,
  mergeCodexConfig,
  mergeJsonEntry,
  planHost,
  planHosts,
  writeMachineLauncher,
} from './hosts.js';

/** Host setup (ADR-0036) against a temporary home and state folder: never the developer's. */

let home: string;
let state: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'friday-hosts-home-'));
  state = mkdtempSync(path.join(tmpdir(), 'friday-hosts-state-'));
  env = { PATH: '', FRIDAY_HOSTS_HOME: home, FRIDAY_STATE_DIR: state };
  writeFileSync(path.join(state, 'install.json'), JSON.stringify({ mcp_server_entry: 'C:/friday/mcp.mjs' }));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

const L = 'C:/state/hosts/friday-local-mcp.mjs';

describe('mergeJsonEntry', () => {
  it("sets Friday's entry, keeps every other key, and is byte-stable once it is right", () => {
    const entry = hostEntry('claude-code', L) as Record<string, unknown>;
    const first = mergeJsonEntry(null, ['mcpServers', 'friday'], entry);
    expect(first).toMatchObject({ state: 'missing', changed: true });
    expect(JSON.parse(first.text as string)).toEqual({ mcpServers: { friday: entry } });
    const user = '{\n    "theme": "dark",\n    "mcpServers": { "other": { "command": "x" } }\n}\n';
    const merged = mergeJsonEntry(user, ['mcpServers', 'friday'], entry);
    expect(merged.state).toBe('missing');
    expect(JSON.parse(merged.text as string)).toEqual({
      theme: 'dark',
      mcpServers: { other: { command: 'x' }, friday: entry },
    });
    // Right already: the text is returned as it is, formatting and all.
    const again = mergeJsonEntry(merged.text, ['mcpServers', 'friday'], entry);
    expect(again).toEqual({ state: 'configured', text: merged.text, changed: false });
    // A different launcher: outdated, rewritten.
    const moved = mergeJsonEntry(merged.text, ['mcpServers', 'friday'], hostEntry('claude-code', 'D:/x.mjs'));
    expect(moved.state).toBe('outdated');
    expect(moved.text).toContain('D:/x.mjs');
    // Removed: the user's keys stay; a file that held only Friday's part goes.
    const removed = mergeJsonEntry(merged.text, ['mcpServers', 'friday'], null);
    expect(JSON.parse(removed.text as string)).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    expect(mergeJsonEntry(first.text, ['mcpServers', 'friday'], null).text).toBeNull();
    expect(mergeJsonEntry(user, ['mcpServers', 'friday'], null)).toMatchObject({ changed: false, text: user });
  });

  it('leaves a file it cannot read as JSON, or whose section is not an object, alone', () => {
    expect(mergeJsonEntry('{ not json', ['mcpServers', 'friday'], {})).toEqual({
      state: 'manual',
      text: null,
      changed: false,
    });
    expect(mergeJsonEntry('{"mcpServers": []}', ['mcpServers', 'friday'], {})).toMatchObject({ state: 'manual' });
  });
});

describe('mergeCodexConfig', () => {
  it('owns one marked block and keeps the rest byte for byte', () => {
    const user = 'model = "gpt-6"\n\n[sandbox]\nmode = "workspace-write"\n';
    const added = mergeCodexConfig(user, L, true) as string;
    expect(added.startsWith(`${user}\n# >>> friday`)).toBe(true);
    expect(added.endsWith(codexBlock(L))).toBe(true);
    expect(mergeCodexConfig(added, L, true)).toBe(added);
    expect(mergeCodexConfig(added, L, false)).toBe(user);
    expect(mergeCodexConfig(null, L, false)).toBeNull();
    expect(mergeCodexConfig(codexBlock(L), L, false)).toBeNull();
    expect(mergeCodexConfig('[mcp_servers.friday]\ncommand = "mine"\n', L, true)).toBe('manual');
  });
});

describe('planHost and applyHostPlans', () => {
  it('writes, keeps the backup, is byte-stable, and removes, per host file', () => {
    const launcher = writeMachineLauncher(env);
    expect(launcher).toBe(machineLauncherPath(env));
    expect(readFileSync(launcher, 'utf8')).toContain(JSON.stringify(state));
    // A user file with its own content, to be kept.
    const claude = hostFile('claude-code', home) as string;
    writeFileSync(claude, '{"numStartups": 3}\n');
    const named = ['claude-code', 'codex', 'gemini', 'opencode', 'cursor', 'deepseek', 'antigravity'] as const;
    const plans = planHosts({ env, mode: 'install', named: [...named] });
    expect(plans.map((p) => [p.host, p.entry, p.change ? 'write' : 'none'])).toEqual([
      ['claude-code', 'missing', 'write'],
      ['codex', 'missing', 'write'],
      ['gemini', 'missing', 'write'],
      ['opencode', 'missing', 'write'],
      ['cursor', 'missing', 'write'],
      ['deepseek', 'missing', 'write'],
      ['antigravity', 'none', 'none'],
    ]);
    const report = applyHostPlans(plans, env);
    expect(report.launcher_present).toBe(true);
    expect(JSON.parse(readFileSync(claude, 'utf8'))).toEqual({
      numStartups: 3,
      mcpServers: { friday: { command: 'node', args: [launcher], env: { FRIDAY_HARNESS: 'claude-code' } } },
    });
    expect(readdirSync(home).some((f) => /^\.claude\.json\.friday-\d{4}-\d{2}-\d{2}\.bak$/.test(f))).toBe(true);
    expect(JSON.parse(readFileSync(hostFile('opencode', home) as string, 'utf8'))).toEqual({
      mcp: {
        friday: {
          type: 'local',
          command: ['node', launcher],
          enabled: true,
          environment: { FRIDAY_HARNESS: 'opencode' },
        },
      },
    });
    expect(readFileSync(hostFile('codex', home) as string, 'utf8')).toBe(codexBlock(launcher));
    expect(readFileSync(hostFile('deepseek', home) as string, 'utf8')).toContain('mcp_servers:');
    expect(report.hosts.map((h) => h.entry)).toEqual([
      'configured',
      'configured',
      'configured',
      'configured',
      'configured',
      'configured',
      'none',
    ]);
    // Again: nothing to write.
    const again = planHosts({ env, mode: 'install', named: [...named] });
    expect(again.every((p) => p.change === null)).toBe(true);
    // Removed: the user's file as it was; files that held only Friday's part are gone.
    const removal = planHosts({ env, mode: 'remove', named: [...named] });
    expect(removal.filter((p) => p.change).map((p) => p.host)).toEqual([
      'claude-code',
      'codex',
      'gemini',
      'opencode',
      'cursor',
      'deepseek',
    ]);
    applyHostPlans(removal, env);
    expect(JSON.parse(readFileSync(claude, 'utf8'))).toEqual({ numStartups: 3 });
    expect(existsSync(hostFile('codex', home) as string)).toBe(false);
    expect(existsSync(hostFile('cursor', home) as string)).toBe(false);
  });

  it('never writes a host that is not installed unless it is named, and never a hand-written entry', () => {
    const codex = hostFile('codex', home) as string;
    mkdirSync(path.dirname(codex), { recursive: true });
    writeFileSync(codex, '[mcp_servers.friday]\ncommand = "mine"\n');
    const manual = planHost('codex', { env, mode: 'install', named: ['codex'] });
    expect(manual).toMatchObject({ entry: 'manual', change: null });
    expect(manual.note).toContain('left alone');
    const skipped = planHost('deepseek', { env, mode: 'install' });
    expect(skipped.detected.installed).toBe(false);
    expect(skipped.change).toBeNull();
    expect(skipped.note).toContain('skipped');
  });
});
