/**
 * First-run host setup through the CLI (ADR-0036): one machine entry per host, written into a
 * temporary home (`FRIDAY_HOSTS_HOME`), never the developer's; byte-stable; reversible.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';

const ws = useTestWorkspace();
let saved: Record<string, string | undefined>;
let home: string;
beforeEach(() => {
  saved = { FRIDAY_STATE_DIR: process.env.FRIDAY_STATE_DIR, FRIDAY_HOSTS_HOME: process.env.FRIDAY_HOSTS_HOME };
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
  home = mkdtempSync(path.join(tmpdir(), 'friday-hosts-home-'));
  process.env.FRIDAY_HOSTS_HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const ALL = ['claude-code', 'codex', 'gemini', 'opencode', 'cursor', 'deepseek'];
const hostArgs = ALL.flatMap((h) => ['--host', h]);

describe('friday hosts', () => {
  it('needs the machine set up first', async () => {
    const r = await cli(['hosts', 'setup', '--host', 'codex']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('run "friday setup"');
  });

  it('writes one entry per named host, is byte-stable, reports, and removes', async () => {
    expect((await cli(['setup'])).code).toBe(0);
    const launcher = path.join(ws().stateDir, 'hosts', 'friday-local-mcp.mjs');
    expect(existsSync(launcher)).toBe(true);
    // A user file with content of its own, kept through setup and removal.
    writeFileSync(path.join(home, '.claude.json'), '{"numStartups": 7}\n');

    const first = await cli(['hosts', 'setup', ...hostArgs]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain('Written.');
    const claude = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(claude).toEqual({
      numStartups: 7,
      mcpServers: { friday: { command: 'node', args: [launcher], env: { FRIDAY_HARNESS: 'claude-code' } } },
    });
    expect(readdirSync(home).some((f) => f.startsWith('.claude.json.friday-') && f.endsWith('.bak'))).toBe(true);
    const codex = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(codex).toContain('[mcp_servers.friday]');
    expect(codex).toContain(JSON.stringify(launcher));
    expect(existsSync(path.join(home, '.gemini', 'settings.json'))).toBe(true);
    expect(existsSync(path.join(home, '.cursor', 'mcp.json'))).toBe(true);
    expect(existsSync(path.join(home, '.config', 'opencode', 'opencode.json'))).toBe(true);
    expect(existsSync(path.join(home, '.deepseek-harness', 'config.yaml'))).toBe(true);
    const report = JSON.parse(readFileSync(path.join(ws().stateDir, 'hosts', 'report.json'), 'utf8')) as {
      hosts: { host: string; entry: string }[];
    };
    expect(report.hosts.filter((h) => ALL.includes(h.host)).map((h) => h.entry)).toEqual(ALL.map(() => 'configured'));

    // Again: nothing changes, byte for byte.
    const before = Object.fromEntries(
      [
        '.claude.json',
        '.codex/config.toml',
        '.gemini/settings.json',
        '.cursor/mcp.json',
        '.config/opencode/opencode.json',
        '.deepseek-harness/config.yaml',
      ].map((f) => [f, readFileSync(path.join(home, f), 'utf8')]),
    );
    const again = await cli(['hosts', 'setup', ...hostArgs]);
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain('Nothing to write');
    for (const [f, text] of Object.entries(before)) expect(readFileSync(path.join(home, f), 'utf8')).toBe(text);

    const shown = await cli(['hosts']);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toContain('MACHINE ENTRY');
    expect(shown.stdout).toMatch(/codex\s+(?:yes|no)[^\n]*?\s+configured/);
    expect(shown.stdout).toContain(`Machine launcher: ${launcher}`);
    const dry = await cli(['hosts', 'setup', '--host', 'codex', '--dry-run']);
    expect(dry.stdout).toContain('Dry run');

    // Removed: the user's file as it was; files that were only Friday's are gone.
    const removed = await cli(['hosts', 'remove', ...hostArgs]);
    expect(removed.code, removed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'))).toEqual({ numStartups: 7 });
    expect(existsSync(path.join(home, '.codex', 'config.toml'))).toBe(false);
    expect(existsSync(path.join(home, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('friday init sets the hosts up once the machine is, and says so otherwise', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'friday-init-'));
    try {
      const notYet = await cli(['--project', dir, 'init', '--name', 'shop']);
      expect(notYet.code, notYet.stderr).toBe(0);
      expect(notYet.stdout).toContain('Hosts: run "friday setup"');
      expect(readdirSync(home)).toEqual([]);

      expect((await cli(['setup'])).code).toBe(0);
      const dir2 = mkdtempSync(path.join(tmpdir(), 'friday-init-'));
      try {
        const done = await cli(['--project', dir2, 'init', '--name', 'shop2']);
        expect(done.code, done.stderr).toBe(0);
        expect(done.stdout).toContain('Hosts:');
        // Only installed hosts are written; none is written blind. The report exists either way.
        expect(existsSync(path.join(ws().stateDir, 'hosts', 'report.json'))).toBe(true);
        const skipped = await cli([
          '--project',
          mkdtempSync(path.join(tmpdir(), 'friday-init-')),
          'init',
          '--no-hosts',
        ]);
        expect(skipped.code, skipped.stderr).toBe(0);
        expect(skipped.stdout).not.toContain('Hosts:');
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
