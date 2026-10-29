/**
 * The `host.config` class (plan M8b.1): every folder a host reads hook commands or MCP servers
 * from in a project is written only by humans and `friday harness config`, never by an agent's
 * tool, while reading stays allowed.
 */
import { describe, expect, it } from 'vitest';
import { evaluateSensitive, type PathContext, sensitiveClassOf } from './index.js';

const WIN: PathContext = {
  projectRoot: 'C:\\demo\\shop',
  stateDir: 'C:\\Users\\me\\AppData\\Local\\Friday',
  windows: true,
};
const POSIX: PathContext = { projectRoot: '/home/me/shop', stateDir: '/home/me/.local/state/friday', windows: false };

describe('host configuration of every host Friday hooks into', () => {
  const files = [
    // Gemini CLI: its project settings hold `hooks` and `mcpServers`.
    '.gemini/settings.json',
    '.gemini/policies/friday.toml',
    // Antigravity: hooks, MCP servers, rules and skills shared by its App, CLI and IDE.
    '.agents/hooks.json',
    '.agents/mcp_config.json',
    '.agents/rules/friday.md',
    '.agents/skills/x/SKILL.md',
    // The hosts protected before M8b keep their place.
    '.cursor/hooks.json',
    '.claude/settings.json',
  ];

  it.each(files)('%s may be read but not written by an agent', (rel) => {
    for (const ctx of [WIN, POSIX]) {
      const p = ctx.windows ? rel.replaceAll('/', '\\') : rel;
      expect(sensitiveClassOf(p, ctx, 'write')?.class, `${p} write`).toBe('host.config');
      expect(sensitiveClassOf(p, ctx, 'read'), `${p} read`).toBeNull();
    }
  });

  it('protects the folders themselves and absolute paths into them', () => {
    expect(sensitiveClassOf('.gemini', POSIX, 'write')?.class).toBe('host.config');
    expect(sensitiveClassOf('.agents', WIN, 'write')?.class).toBe('host.config');
    expect(sensitiveClassOf('/home/me/shop/.agents/hooks.json', POSIX, 'write')?.class).toBe('host.config');
    expect(sensitiveClassOf('C:\\demo\\shop\\.gemini\\settings.json', WIN, 'write')?.class).toBe('host.config');
  });

  it('denies a write tool there without the daemon, and leaves look-alike names alone', () => {
    for (const p of ['.gemini/settings.json', '.agents/hooks.json']) {
      expect(evaluateSensitive({ tool: 'Write', kind: 'write', paths: [p] }, POSIX)).toMatchObject({
        decision: 'deny',
        sensitive_class: 'host.config',
      });
    }
    // Only the folders at the project's root are a host's; a source folder of the same name is not.
    expect(sensitiveClassOf('src/agents/hooks.ts', POSIX, 'write')).toBeNull();
    expect(sensitiveClassOf('docs/gemini/notes.md', POSIX, 'write')).toBeNull();
    expect(sensitiveClassOf('GEMINI.md', POSIX, 'write')).toBeNull();
  });
});
