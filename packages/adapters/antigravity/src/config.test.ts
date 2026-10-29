/**
 * `friday harness config antigravity` (plan M8b.3): the files it writes, that a second run changes
 * nothing, that the user's own hooks, servers and AGENTS.md text survive, and that `--remove`
 * gives the project back exactly as it was.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  bundledHookSource,
  HOST_MODULES,
  LAUNCHER_BUDGET_MS,
  LAUNCHER_DEFAULT_BUDGET_MS,
} from '@friday/adapter-claude';
import { newId } from '@friday/protocol';
import { renderInitialConfig } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { applyAntigravityPlan, mergeAgentsMd, mergeHooks, mergeMcpConfig, planAntigravity } from './config.js';
import {
  AGENTS_MD_BLOCK,
  fridayHookGroup,
  HARNESS_README,
  HOOK_EVENTS,
  HOOK_TIMEOUTS_S,
  hookCommand,
  LAUNCH_MCP,
  MCP_ENTRY,
  TOOL_MATCHER,
} from './templates.js';

const ws = useTestWorkspace({ prefix: 'fri-ag-' });
const env = () => ({ FRIDAY_STATE_DIR: ws().stateDir });
const file = (...parts: string[]) => path.join(ws().projectDir, ...parts);
const text = (...parts: string[]) => readFileSync(file(...parts), 'utf8');
const json = (...parts: string[]) => JSON.parse(text(...parts)) as Record<string, unknown>;

function initProject(): void {
  mkdirSync(file('.friday'), { recursive: true });
  writeFileSync(file('.friday', 'config.yaml'), renderInitialConfig(newId('proj'), 'antigravity-test'));
}

const configure = (opts: { remove?: boolean; agentKey?: string } = {}) => {
  const changes = planAntigravity({ projectDir: ws().projectDir, env: env(), ...opts });
  applyAntigravityPlan(changes);
  return changes;
};

/** Every file under the project except Friday's own config, with its content. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else out[path.relative(ws().projectDir, abs).replaceAll('\\', '/')] = readFileSync(abs, 'utf8');
    }
  };
  walk(ws().projectDir);
  return out;
}

describe('Antigravity hook templates', () => {
  it('configures exactly the host events the launcher module reads, each above the launcher budget', () => {
    expect([...HOOK_EVENTS].sort()).toEqual(Object.keys(HOST_MODULES.antigravity.knownKeys).sort());
    for (const event of HOOK_EVENTS) {
      const budget = LAUNCHER_BUDGET_MS[event] ?? LAUNCHER_DEFAULT_BUDGET_MS;
      expect(HOOK_TIMEOUTS_S[event] * 1000, event).toBeGreaterThan(budget);
    }
    expect(HOOK_TIMEOUTS_S).toEqual({ SessionStart: 15, PreToolUse: 5, PostToolUse: 10, Stop: 10 });
  });

  it('runs the tracked launcher with the antigravity argument and matches every tool', () => {
    const group = fridayHookGroup() as Record<string, unknown[]>;
    expect(Object.keys(group)).toEqual(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']);
    for (const event of ['PreToolUse', 'PostToolUse'] as const) {
      expect(group[event]).toEqual([
        {
          matcher: TOOL_MATCHER,
          hooks: [{ type: 'command', command: hookCommand(event), timeout: HOOK_TIMEOUTS_S[event] }],
        },
      ]);
    }
    for (const event of ['SessionStart', 'Stop'] as const)
      expect(group[event]).toEqual([{ type: 'command', command: hookCommand(event), timeout: HOOK_TIMEOUTS_S[event] }]);
    expect(hookCommand('PreToolUse')).toBe('node .friday/harness/antigravity/hook.mjs antigravity PreToolUse');
    expect(TOOL_MATCHER).toBe('*');
  });

  it('starts the friday server through a machine-neutral launcher', () => {
    expect(MCP_ENTRY).toEqual({
      command: 'node',
      args: ['.friday/harness/antigravity/launch-mcp.mjs'],
      env: { FRIDAY_HARNESS: 'antigravity' },
    });
    for (const t of [
      JSON.stringify(fridayHookGroup()),
      JSON.stringify(MCP_ENTRY),
      LAUNCH_MCP,
      HARNESS_README,
      AGENTS_MD_BLOCK,
    ])
      expect(t).not.toMatch(/[A-Za-z]:[\\/]|\/home\/|\/Users\/|127\.0\.0\.1|Bearer /);
    expect(LAUNCH_MCP).toContain('install.json');
    expect(LAUNCH_MCP).toContain('restart Antigravity');
  });

  it('keeps the AGENTS.md block short, host-neutral and in the CLAUDE.md marker shape', () => {
    expect(AGENTS_MD_BLOCK.startsWith('<!-- friday:begin -->\n')).toBe(true);
    expect(AGENTS_MD_BLOCK.endsWith('\n<!-- friday:end -->')).toBe(true);
    // Loaded into every conversation of the folder: a bounded cost, well under Antigravity's 24,000-byte file limit.
    expect(Buffer.byteLength(AGENTS_MD_BLOCK)).toBeLessThan(1600);
    expect(AGENTS_MD_BLOCK).toContain('friday_claim_done');
    expect(AGENTS_MD_BLOCK).not.toMatch(/Claude|Antigravity|Cursor|Gemini/);
  });
});

describe('merging into the user’s files', () => {
  it('adds and removes only the friday hook group, keeping the user’s groups in order', () => {
    const user = {
      lint: { PostToolUse: [{ matcher: 'write_to_file', hooks: [{ command: './scripts/lint.sh' }] }] },
      friday: { Stop: [{ command: 'an old friday group' }] },
      gate: { enabled: false, PreToolUse: [{ matcher: 'run_command', hooks: [{ command: './gate.sh' }] }] },
    };
    const once = mergeHooks(user, true);
    expect(Object.keys(once)).toEqual(['lint', 'gate', 'friday']);
    expect(once.friday).toEqual(fridayHookGroup());
    expect(mergeHooks(once, true)).toEqual(once);
    expect(mergeHooks(once, false)).toEqual({ lint: user.lint, gate: user.gate });
    expect(mergeHooks({}, false)).toEqual({});
  });

  it('adds and removes only the friday server', () => {
    const user = { mcpServers: { github: { serverUrl: 'https://example.com/mcp/' } }, other: 1 };
    const once = mergeMcpConfig(user, true);
    expect(once).toEqual({ mcpServers: { github: user.mcpServers.github, friday: MCP_ENTRY }, other: 1 });
    expect(mergeMcpConfig(once, false)).toEqual(user);
    expect(mergeMcpConfig(mergeMcpConfig({}, true), false)).toEqual({});
  });

  it('adds the AGENTS.md block after the user’s text and takes it back exactly', () => {
    for (const before of [null, '', '# Shop\n', '# Shop\n\nRules here.\n']) {
      const after = mergeAgentsMd(before, true);
      expect(after).toContain(AGENTS_MD_BLOCK);
      expect(mergeAgentsMd(after, true)).toBe(after);
      expect(mergeAgentsMd(after, false), JSON.stringify(before)).toBe(
        before === '' || before === null ? null : before,
      );
    }
    // A last line without a newline gets one: with the block gone, nothing tells the two apart.
    expect(mergeAgentsMd(mergeAgentsMd('# Shop', true), false)).toBe('# Shop\n');
  });
});

describe('friday harness config antigravity', () => {
  it('writes the hooks, the server, the launcher copy and the AGENTS.md block, then nothing on a second run', () => {
    initProject();
    const changes = configure({ agentKey: 'ag-1' });
    expect(changes.map((c) => c.display).sort()).toEqual([
      '(private) agent.json',
      '.agents/hooks.json',
      '.agents/mcp_config.json',
      '.friday/harness/antigravity/README.md',
      '.friday/harness/antigravity/hook.mjs',
      '.friday/harness/antigravity/launch-mcp.mjs',
      'AGENTS.md',
    ]);
    expect(changes.filter((c) => !c.tracked).map((c) => c.display)).toEqual(['(private) agent.json']);
    expect(json('.agents', 'hooks.json')).toEqual({ friday: fridayHookGroup() });
    expect(json('.agents', 'mcp_config.json')).toEqual({ mcpServers: { friday: MCP_ENTRY } });
    expect(text('.friday', 'harness', 'antigravity', 'hook.mjs')).toBe(bundledHookSource());
    expect(text('.friday', 'harness', 'antigravity', 'hook.mjs')).toMatch(/^\/\/ friday-hook-launcher-version: \d/);
    expect(text('.friday', 'harness', 'antigravity', 'launch-mcp.mjs')).toBe(LAUNCH_MCP);
    expect(text('AGENTS.md')).toBe(`${AGENTS_MD_BLOCK}\n`);
    const agent = path.join(ws().stateDir, 'projects');
    expect(readdirSync(agent)).toHaveLength(1);

    expect(planAntigravity({ projectDir: ws().projectDir, env: env() })).toEqual([]);
    expect(planAntigravity({ projectDir: ws().projectDir, env: env(), agentKey: 'ag-1' })).toEqual([]);
  });

  it('writes JSON without a byte-order mark and with LF endings, and nothing machine-specific', () => {
    initProject();
    configure();
    for (const rel of [['.agents', 'hooks.json'], ['.agents', 'mcp_config.json'], ['AGENTS.md']]) {
      const t = text(...rel);
      expect(t.charCodeAt(0), rel.join('/')).not.toBe(0xfeff);
      expect(t).not.toContain('\r');
      expect(t).not.toContain(ws().root);
      expect(t).not.toMatch(/[A-Za-z]:[\\/]/);
    }
  });

  it('keeps the user’s hooks, servers and AGENTS.md, and --remove gives every file back as it was', () => {
    initProject();
    mkdirSync(file('.agents', 'rules'), { recursive: true });
    // Formatted as Friday formats JSON: a file Friday rewrites comes back with the same values, in its formatting.
    const userHooks = `${JSON.stringify({ lint: { PostToolUse: [{ matcher: 'write_to_file', hooks: [{ command: './lint.sh' }] }] } }, null, 2)}\n`;
    const userMcp = `${JSON.stringify({ mcpServers: { github: { serverUrl: 'https://example.com/mcp/' } } }, null, 2)}\n`;
    writeFileSync(file('.agents', 'hooks.json'), userHooks);
    writeFileSync(file('.agents', 'mcp_config.json'), userMcp);
    writeFileSync(file('.agents', 'rules', 'style.md'), '---\ntrigger: always_on\n---\nUse tabs.\n');
    writeFileSync(file('AGENTS.md'), '# Shop\n\nRun the tests before you finish.\n');
    const before = snapshot();

    configure();
    expect(Object.keys(json('.agents', 'hooks.json'))).toEqual(['lint', 'friday']);
    expect(Object.keys(json('.agents', 'mcp_config.json').mcpServers as object)).toEqual(['github', 'friday']);
    expect(text('AGENTS.md')).toBe(`# Shop\n\nRun the tests before you finish.\n\n${AGENTS_MD_BLOCK}\n`);
    // One backup a day of each user file Friday rewrote.
    const day = new Date().toISOString().slice(0, 10);
    expect(text('.agents', `hooks.json.friday-${day}.bak`)).toBe(userHooks);

    configure({ remove: true });
    const after = snapshot();
    for (const [rel, content] of Object.entries(before)) expect(after[rel], rel).toBe(content);
    // What is left beyond the user's files is the day's backups, and Friday's own folder is gone.
    expect(
      Object.keys(after)
        .filter((k) => !(k in before))
        .every((k) => k.endsWith('.bak')),
    ).toBe(true);
    expect(existsSync(file('.friday', 'harness', 'antigravity'))).toBe(false);
  });

  it('--remove on a project Friday alone configured leaves no .agents folder, AGENTS.md or harness folder', () => {
    initProject();
    const before = snapshot();
    configure();
    configure({ remove: true });
    expect(snapshot()).toEqual(before);
    expect(existsSync(file('.agents'))).toBe(false);
    expect(existsSync(file('.friday', 'harness'))).toBe(false);
    expect(planAntigravity({ projectDir: ws().projectDir, env: env(), remove: true })).toEqual([]);
  });

  it('gives back a differently formatted user file with the same values', () => {
    initProject();
    mkdirSync(file('.agents'), { recursive: true });
    const userMcp = '{ "mcpServers": { "github": { "serverUrl": "https://example.com/mcp/" } }, "x": [1,2] }\n';
    writeFileSync(file('.agents', 'mcp_config.json'), userMcp);
    configure();
    configure({ remove: true });
    expect(json('.agents', 'mcp_config.json')).toEqual(JSON.parse(userMcp));
  });

  it('reads a file with a byte-order mark, and refuses one that is not plain JSON', () => {
    initProject();
    mkdirSync(file('.agents'), { recursive: true });
    writeFileSync(file('.agents', 'hooks.json'), '﻿{ "lint": {} }\n');
    configure();
    expect(text('.agents', 'hooks.json').charCodeAt(0)).not.toBe(0xfeff);
    expect(Object.keys(json('.agents', 'hooks.json'))).toEqual(['lint', 'friday']);

    writeFileSync(file('.agents', 'mcp_config.json'), '{ // a comment\n "mcpServers": {}, }\n');
    expect(() => planAntigravity({ projectDir: ws().projectDir, env: env() })).toThrow(
      /mcp_config\.json is not a JSON object Friday can read/,
    );
  });

  it('keeps this machine’s agent key unless one is given, and refuses an invalid one', () => {
    initProject();
    configure({ agentKey: 'ag-7' });
    const agentFile = (c: { display: string }) => c.display === '(private) agent.json';
    expect(planAntigravity({ projectDir: ws().projectDir, env: env() }).some(agentFile)).toBe(false);
    const changed = planAntigravity({ projectDir: ws().projectDir, env: env(), agentKey: 'ag-8' }).find(agentFile);
    expect(changed?.note).toBe("this machine's agent key: ag-8");
    expect(() => planAntigravity({ projectDir: ws().projectDir, env: env(), agentKey: 'no spaces' })).toThrow(
      /invalid agent key/,
    );
  });
});
