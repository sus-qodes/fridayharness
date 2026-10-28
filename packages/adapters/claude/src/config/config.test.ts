import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { compareVersions, hookLevel } from '../detect.js';
import { workspaceTrusted } from '../doctor.js';
import { PRE_TOOL_MATCHER } from '../hooks/types.js';
import { mergeSettings } from './claude-code.js';
import {
  fridayHooks,
  HOOK_PATH_ARG,
  LAUNCH_MCP,
  MCP_ALLOW_RULE,
  MCP_ENTRY,
  SKILL_MD,
  TEMPLATE_VERSION,
} from './templates.js';

describe('friday skill template', () => {
  // Claude Code silently skips a skill whose frontmatter is not valid YAML (seen live on 2.1.296).
  it('has valid YAML frontmatter with the fields Claude Code reads', () => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(SKILL_MD);
    expect(m).not.toBeNull();
    const fm = parse(m?.[1] ?? '') as Record<string, unknown>;
    expect(fm.name).toBe('friday');
    expect(typeof fm.description).toBe('string');
    expect((fm.description as string).length).toBeLessThanOrEqual(1024);
    expect(typeof fm.when_to_use).toBe('string');
    expect(fm['allowed-tools']).toBe(MCP_ALLOW_RULE);
    expect(fm.metadata).toEqual({ 'managed-by': 'friday', 'template-version': TEMPLATE_VERSION });
    expect(SKILL_MD).toContain('friday_claim_done');
  });
});

describe('Claude Code settings templates', () => {
  it('runs every hook in exec form through the tracked launcher', () => {
    const hooks = fridayHooks();
    expect(Object.keys(hooks).sort()).toEqual([
      'PostToolUse',
      'PostToolUseFailure',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
    ]);
    for (const [event, entries] of Object.entries(hooks)) {
      for (const entry of entries as Array<{ hooks: Array<{ type: string; command: string; args: string[] }> }>) {
        for (const h of entry.hooks)
          expect([h.type, h.command, h.args], event).toEqual(['command', 'node', [HOOK_PATH_ARG, event]]);
      }
    }
    const pre = (
      hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ onFailure: string; timeout: number }> }>
    )[0];
    expect(pre?.matcher).toBe(PRE_TOOL_MATCHER);
    expect(pre?.hooks[0]).toMatchObject({ onFailure: 'block', timeout: 5 });
  });

  it('starts the MCP server through a machine-neutral launcher', () => {
    expect(MCP_ENTRY).toMatchObject({ command: 'node', args: ['.friday/harness/claude-code/launch-mcp.mjs'] });
    for (const text of [JSON.stringify(MCP_ENTRY), LAUNCH_MCP])
      expect(text).not.toMatch(/[A-Za-z]:[\\/]|\/home\/|\/Users\//);
    expect(LAUNCH_MCP).toContain('install.json');
    expect(LAUNCH_MCP).toContain('FRIDAY_MCP_ENTRY');
  });

  it('merges hooks without disturbing user entries, idempotently, and removes only its own', () => {
    const user = {
      model: 'opus',
      permissions: { allow: ['Bash(npm test:*)', 'mcp__friday__*'], deny: ['Read(./secrets/**)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user' }] }] },
    };
    const once = mergeSettings(user, true);
    expect(mergeSettings(once, true)).toEqual(once);
    expect((once.permissions as { allow: string[] }).allow).toEqual(['Bash(npm test:*)', MCP_ALLOW_RULE]);
    const pre = (once.hooks as Record<string, Array<{ matcher?: string }>>).PreToolUse ?? [];
    expect(pre.map((e) => e.matcher)).toEqual(['Bash', PRE_TOOL_MATCHER]);
    const removed = mergeSettings(once, false);
    expect(removed).toEqual({ ...user, permissions: { allow: ['Bash(npm test:*)'], deny: ['Read(./secrets/**)'] } });
    expect(mergeSettings({}, false)).toEqual({});
  });
});

describe('Claude Code version levels', () => {
  it('compares versions numerically and maps them to hook levels (ADR-0009)', () => {
    expect(compareVersions('2.1.296', '2.1.295')).toBeGreaterThan(0);
    expect(compareVersions('2.1.95', '2.1.295')).toBeLessThan(0);
    expect(compareVersions('2.2', '2.1.999')).toBeGreaterThan(0);
    expect(hookLevel('2.1.296')).toBe('enforcing');
    expect(hookLevel('2.1.295')).toBe('enforcing');
    expect(hookLevel('2.1.294')).toBe('degraded');
    expect(hookLevel('2.1.232')).toBe('degraded');
    expect(hookLevel('2.1.231')).toBe('unsupported');
    expect(hookLevel(null)).toBe('unknown');
  });
});

describe('workspace trust lookup', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  /** A project folder plus a CLAUDE_CONFIG_DIR whose .claude.json lists `projects(root)` (none when null). */
  const setup = (projects: ((root: string) => Record<string, unknown>) | null) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fri-trust-'));
    dirs.push(dir);
    const root = path.join(dir, 'work', 'shop');
    mkdirSync(root, { recursive: true });
    if (projects) writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ projects: projects(root) }));
    return { root, env: { CLAUDE_CONFIG_DIR: dir } };
  };

  it('reads hasTrustDialogAccepted for the folder or a parent, in either slash style', () => {
    const exact = setup((root) => ({ [root.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } }));
    expect(workspaceTrusted(exact.root, exact.env)).toMatchObject({ trusted: true });
    const parent = setup((root) => ({ [path.dirname(root)]: { hasTrustDialogAccepted: true } }));
    expect(workspaceTrusted(parent.root, parent.env)).toEqual({ trusted: true, via: path.dirname(parent.root) });
    const no = setup((root) => ({
      [root]: { hasTrustDialogAccepted: false },
      elsewhere: { hasTrustDialogAccepted: true },
    }));
    expect(workspaceTrusted(no.root, no.env)).toEqual({ trusted: false });
    expect(
      workspaceTrusted(setup(null).root, { CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), 'fri-no-such-dir') }),
    ).toBeUndefined();
  });
});
