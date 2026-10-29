/**
 * `friday harness config claude-code` (plan Appendix 4): what it writes, that nothing committed
 * holds a secret, a port or a machine path, idempotency, merging with user configuration,
 * backups, --print, --scope local and --remove.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_ALLOW_RULE, MCP_ENTRY, PRE_TOOL_MATCHER } from '@friday/adapter-claude';
import { loadProject, privateDirFor } from '@friday/sdk';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { initTestProject, startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

const read = (...parts: string[]) => readFileSync(path.join(ws().projectDir, ...parts), 'utf8');
const readJson = (...parts: string[]) => JSON.parse(read(...parts)) as Record<string, unknown>;
const exists = (...parts: string[]) => existsSync(path.join(ws().projectDir, ...parts));

async function gitProject(files: Record<string, string> = {}) {
  initTestProject(ws());
  writeFileSync(path.join(ws().projectDir, 'README.md'), '# shop\n');
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(ws().projectDir, rel)), { recursive: true });
    writeFileSync(path.join(ws().projectDir, rel), text);
  }
  const git = deterministicGit(ws().projectDir);
  await git.init();
  await git.commitAll('init');
  return git;
}

function config(...args: string[]) {
  return cli(['--project', ws().projectDir, 'harness', 'config', 'claude-code', ...args]);
}

/** Untracked (not ignored) and modified tracked files, as git reports them. */
async function gitChanges(git: ReturnType<typeof deterministicGit>) {
  const lines = async (args: string[]) => (await git.run(args)).split('\n').filter(Boolean).sort();
  return {
    untracked: await lines(['ls-files', '--others', '--exclude-standard']),
    modified: await lines(['diff', '--name-only']),
  };
}

async function configJson(...args: string[]) {
  const res = await cli(['--project', ws().projectDir, '--json', 'harness', 'config', 'claude-code', ...args]);
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as {
    applied: boolean;
    removed: boolean;
    changes: Array<{ path: string; action: string; tracked: boolean }>;
  };
}

describe('friday harness config claude-code', () => {
  it('writes the attach files with no secret, port or machine path in anything committed, and a re-run changes nothing', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const first = await configJson('--agent', 'dev-1');
    expect(first.applied).toBe(true);
    const changed = Object.fromEntries(first.changes.map((c) => [c.path, c]));
    expect(Object.keys(changed).sort()).toEqual(
      [
        '(git) info/exclude',
        '(private) agent.json',
        '.claude/settings.json',
        '.claude/settings.local.json',
        '.claude/skills/friday/SKILL.md',
        '.claude/skills/friday/reference.md',
        '.friday/harness/claude-code/README.md',
        '.friday/harness/claude-code/hook.mjs',
        '.friday/harness/claude-code/launch-mcp.mjs',
        '.mcp.json',
      ].sort(),
    );
    expect(changed['.claude/settings.local.json']?.tracked).toBe(false);
    expect(changed['(private) agent.json']?.tracked).toBe(false);

    expect(readJson('.mcp.json')).toEqual({ mcpServers: { friday: MCP_ENTRY } });
    const settings = readJson('.claude', 'settings.json') as {
      hooks: Record<string, Array<{ matcher?: string }>>;
      permissions: { allow: string[] };
    };
    expect(Object.keys(settings.hooks).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
    expect(settings.hooks.PreToolUse?.[0]?.matcher).toBe(PRE_TOOL_MATCHER);
    expect(settings.permissions.allow).toEqual([MCP_ALLOW_RULE]);
    expect(readJson('.claude', 'settings.local.json')).toEqual({ enabledMcpjsonServers: ['friday'] });
    const priv = privateDirFor(loadProject(ws().projectDir));
    expect(JSON.parse(readFileSync(path.join(priv, 'agent.json'), 'utf8'))).toEqual({ agent_key: 'dev-1' });
    expect(read('.git', 'info', 'exclude')).toContain('/.claude/settings.local.json');

    // What git sees: the shared files, never settings.local.json or runtime files.
    const { untracked: status, modified } = await gitChanges(deterministicGit(ws().projectDir));
    expect(modified).toEqual([]);
    expect(status).toEqual(
      [
        '.claude/settings.json',
        '.claude/skills/friday/SKILL.md',
        '.claude/skills/friday/reference.md',
        '.friday/harness/claude-code/README.md',
        '.friday/harness/claude-code/hook.mjs',
        '.friday/harness/claude-code/launch-mcp.mjs',
        '.mcp.json',
      ].sort(),
    );
    const forbidden = [
      td.daemon.tokens.operator,
      td.daemon.tokens.bootstrap,
      td.url,
      td.url.replace('http://', ''),
      ws().stateDir,
      ws().root,
      REPO_ROOT,
      os.homedir(),
    ].flatMap((s) => [s, s.replaceAll('\\', '/'), s.replaceAll('\\', '\\\\')]);
    for (const file of status) {
      const text = read(file);
      for (const s of forbidden) expect(text.includes(s), `${file} contains ${s}`).toBe(false);
    }

    const before = read('.mcp.json');
    expect((await configJson()).changes).toEqual([]);
    const human = await config();
    expect(human.code, human.stderr).toBe(0);
    expect(human.stdout).toContain('nothing to change');
    expect(read('.mcp.json')).toBe(before);
  });

  it('keeps user configuration, backs it up once, and --remove takes out exactly what Friday added', async () => {
    const userMcp = { mcpServers: { other: { command: 'npx', args: ['-y', 'other-mcp'] } } };
    const userSettings = {
      model: 'opus',
      permissions: { allow: ['Bash(npm test:*)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }] },
    };
    const userClaudeMd = '# Shop\n\nUse pnpm.\n';
    const git = await gitProject({
      '.mcp.json': `${JSON.stringify(userMcp, null, 4)}\n`,
      '.claude/settings.json': `${JSON.stringify(userSettings, null, 4)}\n`,
      'CLAUDE.md': userClaudeMd,
    });
    await configJson('--claude-md');
    const settings = readJson('.claude', 'settings.json') as typeof userSettings;
    expect(settings.model).toBe('opus');
    expect(settings.permissions.allow).toEqual(['Bash(npm test:*)', MCP_ALLOW_RULE]);
    expect(settings.hooks.PreToolUse.map((e) => e.matcher)).toEqual(['Bash', PRE_TOOL_MATCHER]);
    expect(Object.keys((readJson('.mcp.json').mcpServers as object) ?? {})).toEqual(['other', 'friday']);
    expect(read('CLAUDE.md').startsWith(userClaudeMd)).toBe(true);
    expect(read('CLAUDE.md')).toContain('<!-- friday:begin -->');
    const day = new Date().toISOString().slice(0, 10);
    expect(read(`.mcp.json.friday-${day}.bak`)).toBe(`${JSON.stringify(userMcp, null, 4)}\n`);
    expect(read('.claude', `settings.json.friday-${day}.bak`)).toBe(`${JSON.stringify(userSettings, null, 4)}\n`);
    expect(read(`CLAUDE.md.friday-${day}.bak`)).toBe(userClaudeMd);

    // Re-running with --claude-md is exact, too.
    const claudeMd = read('CLAUDE.md');
    expect((await configJson('--claude-md')).changes).toEqual([]);
    expect(read('CLAUDE.md')).toBe(claudeMd);

    const removed = await configJson('--remove');
    expect(removed.removed).toBe(true);
    expect(readJson('.claude', 'settings.json')).toEqual(userSettings);
    expect(readJson('.mcp.json')).toEqual(userMcp);
    expect(read('CLAUDE.md')).toBe(userClaudeMd);
    for (const gone of ['.claude/settings.local.json', '.claude/skills', '.friday/harness'])
      expect(exists(gone), gone).toBe(false);
    // Only the backups remain as new files. The JSON files hold the user's content again (re-indented).
    const { untracked, modified } = await gitChanges(git);
    expect(untracked).toEqual(
      [`.claude/settings.json.friday-${day}.bak`, `.mcp.json.friday-${day}.bak`, `CLAUDE.md.friday-${day}.bak`].sort(),
    );
    expect(modified).toEqual(['.claude/settings.json', '.mcp.json']);
  });

  it('--print shows the plan with diffs and writes nothing', async () => {
    await gitProject({ '.claude/settings.json': '{\n  "model": "opus"\n}\n' });
    const res = await config('--print');
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout).toContain('Would change Claude Code');
    expect(res.stdout).toContain('+ .mcp.json');
    expect(res.stdout).toContain('~ .claude/settings.json');
    expect(res.stdout).toMatch(/\+ {3}"hooks": \{/);
    for (const f of ['.mcp.json', '.claude/settings.local.json', '.claude/skills', '.friday/harness'])
      expect(exists(f), f).toBe(false);
    expect(read('.claude', 'settings.json')).toBe('{\n  "model": "opus"\n}\n');
    expect(existsSync(path.join(privateDirFor(loadProject(ws().projectDir)), 'agent.json'))).toBe(false);
  });

  it('--scope local keeps hooks out of committed files, and switching scope never runs them twice', async () => {
    const git = await gitProject();
    await configJson('--scope', 'local');
    expect(exists('.claude', 'settings.json')).toBe(false);
    const local = readJson('.claude', 'settings.local.json') as {
      hooks: object;
      permissions: { allow: string[] };
      enabledMcpjsonServers: string[];
    };
    expect(Object.keys(local.hooks)).toHaveLength(6);
    expect(local.permissions.allow).toEqual([MCP_ALLOW_RULE]);
    expect(local.enabledMcpjsonServers).toEqual(['friday']);
    const { untracked } = await gitChanges(git);
    expect(untracked).not.toContain('.claude/settings.local.json');
    expect(untracked).toContain('.mcp.json');

    await configJson('--scope', 'project');
    expect(Object.keys((readJson('.claude', 'settings.json') as { hooks: object }).hooks)).toHaveLength(6);
    expect(readJson('.claude', 'settings.local.json')).toEqual({ enabledMcpjsonServers: ['friday'] });

    await configJson('--scope', 'local');
    expect(exists('.claude', 'settings.json')).toBe(false);
    expect(Object.keys((readJson('.claude', 'settings.local.json') as { hooks: object }).hooks)).toHaveLength(6);
  });

  it('never overwrites a skill the user edited or a newer template', async () => {
    const mine = '---\nname: friday\ndescription: my own version\n---\nMine.\n';
    await gitProject({ '.claude/skills/friday/SKILL.md': mine });
    const res = await configJson();
    expect(res.changes.map((c) => c.path)).not.toContain('.claude/skills/friday/SKILL.md');
    expect(read('.claude', 'skills', 'friday', 'SKILL.md')).toBe(mine);
    expect(exists('.claude', 'skills', 'friday', 'reference.md')).toBe(false);
  });

  it('rejects a host it has no adapter for with a usage error that names every host it configures', async () => {
    await gitProject();
    // Codex is a spawn-mode harness since M8a.2: it has a doctor, and nothing to configure in the project.
    // October is a host Friday knows by name and has no adapter for.
    for (const args of [
      ['harness', 'config', 'october'],
      ['harness', 'config', 'codex'],
      ['harness', 'doctor', 'october'],
    ]) {
      const res = await cli(['--project', ws().projectDir, ...args]);
      expect(res.code, args.join(' ')).toBe(2);
      for (const host of ['claude-code', 'cursor', 'antigravity', 'gemini']) expect(res.stderr).toContain(host);
    }
  });

  it('reaches each other host’s own adapter from the host argument (plan M8b)', async () => {
    await gitProject();
    // --remove --print changes nothing and starts no host: no host is looked for when removing.
    for (const host of ['cursor', 'antigravity', 'gemini']) {
      const res = await cli(['--project', ws().projectDir, '--json', 'harness', 'config', host, '--remove', '--print']);
      expect(res.code, `${host}: ${res.stderr}`).toBe(0);
      expect(JSON.parse(res.stdout), host).toMatchObject({ host, applied: false, removed: true, experimental: true });
    }
    // Each host's own options stay its own.
    const wrong = await cli(['--project', ws().projectDir, 'harness', 'config', 'cursor', '--no-gemini-md']);
    expect([wrong.code, wrong.stderr]).toEqual([2, expect.stringContaining('--no-gemini-md is for gemini')]);
    const local = await cli(['--project', ws().projectDir, 'harness', 'config', 'gemini', '--scope', 'local']);
    expect([local.code, local.stderr]).toEqual([2, expect.stringContaining('--scope local is for claude-code')]);
  });

  it('keeps .friday/.gitignore complete for every host it configures', async () => {
    await gitProject({ '.friday/.gitignore': '/run/\n' });
    const res = await cli(['--project', ws().projectDir, '--json', 'harness', 'config', 'gemini', '--print']);
    expect(res.code, res.stderr).toBe(0);
    const changes = (JSON.parse(res.stdout) as { changes: { path: string; action: string }[] }).changes;
    expect(changes).toContainEqual(expect.objectContaining({ path: '.friday/.gitignore', action: 'update' }));
    // --print wrote nothing.
    expect(read('.friday', '.gitignore')).toBe('/run/\n');
  });
});
