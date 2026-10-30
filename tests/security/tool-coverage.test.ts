/**
 * Tool coverage contract (docs/SECURITY.md §4): every Claude Code tool
 * is either intercepted by the PreToolUse matcher or listed as not intercepted, and every intercepted
 * tool that can name a protected location is denied for every sensitive class.
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  actionFromTool,
  COMMAND_TOOLS,
  POST_TOOL_MATCHER,
  PRE_TOOL_MATCHER,
  WRITE_TOOLS,
} from '@friday/adapter-claude';
import { evaluate, evaluateSensitive, type SensitiveClass } from '@friday/policy';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/cli.js';
import { HOOK_FIXTURES } from '../helpers/hooks.js';

const matched = PRE_TOOL_MATCHER.split('|');
const root = path.join(os.tmpdir(), 'friday-coverage', 'shop');
const stateDir = path.join(os.tmpdir(), 'friday-coverage', 'state');
const ctx = { projectRoot: root, stateDir };
const p = (...parts: string[]) => path.join(root, ...parts);

const PATH_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit'];
const SEARCH_TOOLS = ['Glob', 'Grep'];
const CLASSES: SensitiveClass[] = ['friday.private', 'friday.runtime', 'secrets', 'git.internal', 'host.config'];

const FILE_TARGET: Record<SensitiveClass, string> = {
  'friday.private': path.join(stateDir, 'projects', 'proj-x', 'bootstrap.token'),
  'friday.runtime': p('.friday', 'run', 'daemon.json'),
  secrets: p('config', '.env'),
  'git.internal': p('.git', 'config'),
  'host.config': p('.claude', 'settings.json'),
};

function pathInput(tool: string, target: string): Record<string, unknown> {
  if (tool === 'NotebookEdit') return { notebook_path: target, new_source: 'x' };
  if (tool === 'Edit') return { file_path: target, old_string: 'a', new_string: 'b' };
  if (tool === 'Write') return { file_path: target, content: 'x' };
  return { file_path: target };
}

function searchInput(tool: string, cls: SensitiveClass): Record<string, unknown> {
  const where: Record<SensitiveClass, Record<string, unknown>> = {
    'friday.private': { path: stateDir },
    'friday.runtime': { path: p('.friday', 'run') },
    secrets: tool === 'Glob' ? { pattern: '**/.env*' } : { glob: '**/.env*' },
    'git.internal': { path: p('.git') },
    'host.config': { path: p('.claude') },
  };
  return { pattern: tool === 'Glob' ? '**/*' : 'needle', ...where[cls] };
}

const SHELL: Record<'Bash' | 'PowerShell' | 'Shell', Partial<Record<SensitiveClass, string>>> = {
  Bash: {
    'friday.private': 'cat ~/.local/state/friday/projects/proj-x/operator.token',
    'friday.runtime': 'sqlite3 .friday/project.db .dump',
    secrets: 'grep KEY config/.env',
  },
  PowerShell: {
    'friday.private': 'Get-Content $env:LOCALAPPDATA\\Friday\\projects\\proj-x\\operator.token',
    'friday.runtime': 'Get-Content .friday\\run\\daemon.json',
    secrets: 'Get-Content .env.local',
  },
  // Another host's shell, whose dialect its hook does not say (Cursor, Antigravity, Gemini CLI).
  Shell: {
    'friday.private': 'type %LOCALAPPDATA%\\Friday\\projects\\proj-x\\bootstrap.token',
    'friday.runtime': 'cat .friday/sessions/s.json',
    secrets: 'Get-Content config/.env',
    // A command that changes into .git, then reads by a relative name.
    'git.internal': 'cd .git && cat config',
  },
};

describe('the folder a command runs in and the folder it changes into', () => {
  it('denies a command run inside, or changing into, .friday or .git, for every shell tool', () => {
    for (const tool of ['Bash', 'PowerShell', 'Shell'] as const) {
      for (const command of [
        'cd .friday; cat logs/daemon.log',
        'cd .friday && type sessions\\x.json',
        'Set-Location .\\.friday; Get-Content run\\daemon.json',
        'pushd ./.git && cat config',
        `cd "${root}/.friday" ; cat logs/x`,
      ]) {
        const action = actionFromTool(tool, { command });
        expect(action ? evaluateSensitive(action, ctx)?.decision : null, `${tool}: ${command}`).toBe('deny');
      }
    }
    // Another host names the folder its shell runs in: inside a protected one, relative names are refused too.
    for (const cwd of ['.friday', p('.friday', 'logs'), p('.git'), stateDir]) {
      const action = actionFromTool('Shell', { command: 'Get-Content daemon.log', cwd });
      expect(action ? evaluateSensitive(action, ctx)?.decision : null, cwd).toBe('deny');
    }
    // The project's own folders, and names that only start like a protected one, stay fine.
    for (const [command, cwd] of [
      ['cd src && npm test', undefined],
      ['cd .github && ls', undefined],
      ['ls', p('src')],
      ['ls', p('.friday-notes')],
    ] as const) {
      const action = actionFromTool('Shell', { command, ...(cwd ? { cwd } : {}) });
      expect(action ? evaluateSensitive(action, ctx) : null, `${command} in ${cwd ?? 'the root'}`).toBeNull();
    }
  });

  it('protects the programs a hook command starts by name from the root, and only there', () => {
    for (const name of ['node.cmd', 'node.exe', 'NODE.BAT', 'git.exe', 'node.js']) {
      const action = actionFromTool('Write', { file_path: p(name), content: 'x' });
      expect(action ? evaluateSensitive(action, ctx) : null, name).toMatchObject({
        decision: 'deny',
        sensitive_class: 'host.config',
      });
    }
    for (const name of [['src', 'node.js'], ['tools', 'git.cmd'], ['node.mjs'], ['nodes.cmd']]) {
      const action = actionFromTool('Write', { file_path: p(...name), content: 'x' });
      expect(action ? evaluateSensitive(action, ctx) : null, name.join('/')).toBeNull();
    }
  });
});

describe('Claude Code tool coverage', () => {
  it('intercepts the ten M1 tools and every MCP tool, and maps each to a policy action', () => {
    expect(matched).toEqual([
      'Read',
      'Glob',
      'Grep',
      'Edit',
      'Write',
      'NotebookEdit',
      'Bash',
      'PowerShell',
      'WebFetch',
      'WebSearch',
      'mcp__.*',
    ]);
    const sample: Record<string, Record<string, unknown>> = {
      Read: { file_path: p('a.ts') },
      Glob: { pattern: '**/*.ts' },
      Grep: { pattern: 'x' },
      Edit: { file_path: p('a.ts'), old_string: 'a', new_string: 'b' },
      Write: { file_path: p('a.ts'), content: 'x' },
      NotebookEdit: { notebook_path: p('n.ipynb'), new_source: 'x' },
      Bash: { command: 'ls' },
      PowerShell: { command: 'Get-ChildItem' },
      WebFetch: { url: 'https://example.com', prompt: 'x' },
      WebSearch: { query: 'x' },
    };
    // The MCP pattern stands for every server's tools (ADR-0030): a third-party one is judged...
    const named = (t: string) => (t === 'mcp__.*' ? 'mcp__github__search_code' : t);
    for (const tool of matched) expect(actionFromTool(named(tool), sample[tool] ?? {}), tool).not.toBeNull();
    // ...Friday's own are not: the protocol behind them judges them.
    expect(actionFromTool('mcp__friday__friday_whoami', {})).toBeNull();
    // Writes and commands are also observed after they run (changed paths, outcomes).
    const post = POST_TOOL_MATCHER.split('|');
    for (const tool of [...WRITE_TOOLS, ...COMMAND_TOOLS].filter((t) => matched.includes(t)))
      expect(post, tool).toContain(tool);
  });

  it('lists every recorded Claude Code tool it does not intercept in the security model', () => {
    const manifest = JSON.parse(readFileSync(path.join(HOOK_FIXTURES, 'manifest.json'), 'utf8')) as {
      builtin_tools: string[];
    };
    const doc = readFileSync(path.join(REPO_ROOT, 'docs', 'SECURITY.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 4.'), doc.indexOf('## 5.'));
    expect(section.length).toBeGreaterThan(100);
    const missing = manifest.builtin_tools.filter((t) => !matched.includes(t) && !section.includes(`\`${t}\``));
    expect(missing, 'tools neither intercepted nor documented as gaps').toEqual([]);
  });

  it('denies every protected location for every tool that can name it, without the daemon', () => {
    for (const cls of CLASSES) {
      for (const tool of PATH_TOOLS) {
        const action = actionFromTool(tool, pathInput(tool, FILE_TARGET[cls]));
        const res = action ? evaluateSensitive(action, ctx) : null;
        if (cls === 'host.config' && !WRITE_TOOLS.has(tool)) {
          expect(res, `${tool} may read ${cls}`).toBeNull();
          continue;
        }
        expect(res, `${tool} × ${cls}`).toMatchObject({ decision: 'deny', sensitive_class: cls });
      }
      for (const tool of SEARCH_TOOLS) {
        const action = actionFromTool(tool, searchInput(tool, cls));
        const res = action ? evaluateSensitive(action, ctx) : null;
        if (cls === 'host.config') {
          expect(res, `${tool} may search ${cls}`).toBeNull();
          continue;
        }
        expect(res, `${tool} × ${cls}`).toMatchObject({ decision: 'deny', sensitive_class: cls });
      }
      for (const tool of ['Bash', 'PowerShell', 'Shell'] as const) {
        const command = SHELL[tool][cls];
        if (!command) continue;
        const action = actionFromTool(tool, { command });
        expect(action ? evaluateSensitive(action, ctx) : null, `${tool} × ${cls}: ${command}`).toMatchObject({
          decision: 'deny',
          sensitive_class: cls,
        });
      }
    }
  });

  it('denies every protected location given to a third-party MCP tool, without the daemon (ADR-0030 §2)', () => {
    for (const cls of CLASSES) {
      for (const input of [{ path: FILE_TARGET[cls] }, { args: { files: [FILE_TARGET[cls]] } }]) {
        const action = actionFromTool('mcp__fs__read_file', input);
        expect(action ? evaluateSensitive(action, ctx)?.decision : 'none', `${cls} ${JSON.stringify(input)}`).toBe(
          'deny',
        );
      }
    }
    const plain = actionFromTool('mcp__github__search_code', { query: 'checkout service' });
    expect(plain && evaluateSensitive(plain, ctx)).toBeNull();
  });

  it('never auto-allows shell writes to host configuration (they need a human)', () => {
    for (const [tool, command] of [
      ['Bash', 'echo {} > .mcp.json'],
      ['Bash', 'cp evil.json .claude/settings.json'],
      ['PowerShell', "Set-Content .claude\\settings.json '{}'"],
      ['PowerShell', 'Remove-Item .friday\\harness\\claude-code\\hook.mjs'],
      // Every host's own folders (plan M8b), through the shell tool of any host.
      ['Shell', "Set-Content .agents\\hooks.json '{}'"],
      ['Shell', 'echo {} > .gemini/settings.json'],
      ['Shell', 'cp evil.json .cursor/hooks.json'],
      ['Bash', 'echo {} > .agents/mcp_config.json'],
      ['PowerShell', "Set-Content .gemini\\settings.json '{}'"],
      // A program a host's hook command starts by its bare name from the root.
      ['Shell', 'echo @echo off > node.cmd'],
    ] as const) {
      const action = actionFromTool(tool, { command });
      if (!action) throw new Error(`${tool} has no action`);
      expect(evaluate({ action, ctx, task: null }).decision, `${tool}: ${command}`).not.toBe('allow');
    }
  });
});
