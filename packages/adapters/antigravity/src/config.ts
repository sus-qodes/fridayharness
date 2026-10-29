/**
 * `friday harness config antigravity` (plan M8b.3): plans every file change that attaches
 * Antigravity to a Friday project, and its exact undo with `--remove`. Friday owns its hook group
 * (`friday`) in `.agents/hooks.json`, its server (`friday`) in `.agents/mcp_config.json`, its marker
 * block in `AGENTS.md` and the folder `.friday/harness/antigravity/`; everything else in those
 * files is the user's and is kept as it is, in order.
 */
import { existsSync, readFileSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { applyPlan, bundledHookSource, type FileChange } from '@friday/adapter-claude';
import { FridayError } from '@friday/protocol';
import { loadProject, privateDirFor } from '@friday/sdk';
import {
  AGENTS_MD_BLOCK,
  fridayHookGroup,
  HARNESS_DIR,
  HARNESS_README,
  HOOK_GROUP,
  LAUNCH_MCP,
  MCP_ENTRY,
} from './templates.js';

export interface AntigravityConfigOptions {
  projectDir: string;
  /** This machine's agent key for the project (default: the current one, else `dev-1`). */
  agentKey?: string;
  remove?: boolean;
  /** Bundled launcher contents (defaults to the built launcher of @friday/adapter-claude). */
  hookSource?: string;
  /** Where Friday's private state is (defaults to this process's environment). */
  env?: NodeJS.ProcessEnv;
}

const BOM = '﻿';

function read(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** A JSON object file; a byte-order mark is tolerated on read (Friday never writes one). */
export function readJsonObject(text: string | null, file: string): Record<string, unknown> {
  const body = text?.startsWith(BOM) ? text.slice(1) : text;
  if (!body?.trim()) return {};
  try {
    const v = JSON.parse(body);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new FridayError(
    'invalid_request',
    `${file} is not a JSON object Friday can read (comments and trailing commas are not read); fix or remove it first`,
  );
}

// No byte-order mark, LF endings: Antigravity failed to load hook files with a byte-order mark before CLI 1.3.1.
const stringify = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** Friday's `friday` group added (or replaced) or removed; the user's groups keep their order. */
export function mergeHooks(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, group] of Object.entries(existing)) if (name !== HOOK_GROUP) out[name] = group;
  if (install) out[HOOK_GROUP] = fridayHookGroup();
  return out;
}

/** The `friday` server added (or replaced) or removed; `mcpServers` goes when nothing is left in it. */
export function mergeMcpConfig(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  const raw = existing.mcpServers;
  const servers: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  if (install) servers.friday = MCP_ENTRY;
  else delete servers.friday;
  const out: Record<string, unknown> = { ...existing, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete out.mcpServers;
  return out;
}

const BLOCK_RE = /\n?<!-- friday:begin -->[\s\S]*?<!-- friday:end -->\n?/;

/**
 * Adds or removes the marker block, as the CLAUDE.md block is: the blank line before it belongs to
 * the block, so adding and removing give back the user's text exactly. Null means "no file".
 */
export function mergeAgentsMd(existing: string | null, install: boolean): string | null {
  const base = (existing ?? '').replace(BLOCK_RE, '');
  if (!install) return existing === null || base.trim() === '' ? null : base;
  return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${base ? '\n' : ''}${AGENTS_MD_BLOCK}\n`;
}

/**
 * Plans every file `friday harness config antigravity` writes, or with `remove` every one it takes
 * back. Nothing written contains a token, a port or a machine-specific path.
 */
export function planAntigravity(opts: AntigravityConfigOptions): FileChange[] {
  const ref = loadProject(opts.projectDir);
  const root = ref.root;
  const install = !opts.remove;
  const changes: FileChange[] = [];
  const add = (abs: string, after: string | null, tracked: boolean, note: string, owned = false) => {
    const before = read(abs);
    if (before === after) return;
    changes.push({
      path: abs,
      display: path.relative(root, abs).replaceAll('\\', '/') || abs,
      before,
      after,
      tracked,
      note,
      owned,
    });
  };

  // The launcher reads this machine's agent key from the private folder, as for Claude Code: one
  // key per machine and project, for every host attached from this machine.
  if (install) {
    const agentFile = path.join(privateDirFor(ref, opts.env), 'agent.json');
    const current = readJsonObject(read(agentFile), agentFile).agent_key;
    const agentKey = opts.agentKey ?? (typeof current === 'string' ? current : undefined) ?? 'dev-1';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(agentKey))
      throw new FridayError('invalid_request', `invalid agent key "${agentKey}"`);
    const before = read(agentFile);
    const after = stringify({ agent_key: agentKey });
    if (before !== after)
      changes.push({
        path: agentFile,
        display: '(private) agent.json',
        before,
        after,
        tracked: false,
        note: `this machine's agent key: ${agentKey}`,
        owned: true,
      });
  }

  const harnessDir = path.join(root, ...HARNESS_DIR.split('/'));
  add(
    path.join(harnessDir, 'hook.mjs'),
    install ? (opts.hookSource ?? bundledHookSource()) : null,
    true,
    'hook launcher (policy checks)',
    true,
  );
  add(path.join(harnessDir, 'launch-mcp.mjs'), install ? LAUNCH_MCP : null, true, 'starts the friday MCP server', true);
  add(path.join(harnessDir, 'README.md'), install ? HARNESS_README : null, true, 'what these files are', true);

  /** Rewrites a JSON file only when Friday's part changed (a user's formatting survives); empty deletes it. */
  const addJson = (
    abs: string,
    merge: (existing: Record<string, unknown>) => Record<string, unknown>,
    note: string,
  ) => {
    const before = read(abs);
    const parsed = readJsonObject(before, path.relative(root, abs).replaceAll('\\', '/'));
    const merged = merge(parsed);
    if (before !== null && JSON.stringify(merged) === JSON.stringify(parsed)) return;
    add(abs, Object.keys(merged).length === 0 ? null : stringify(merged), true, note);
  };
  const agentsDir = path.join(root, '.agents');
  addJson(
    path.join(agentsDir, 'hooks.json'),
    (e) => mergeHooks(e, install),
    'Friday hooks (SessionStart, PreToolUse, PostToolUse, Stop)',
  );
  addJson(
    path.join(agentsDir, 'mcp_config.json'),
    (e) => mergeMcpConfig(e, install),
    'registers the friday MCP server',
  );

  const agentsMd = path.join(root, 'AGENTS.md');
  const mdBefore = read(agentsMd);
  if (install || mdBefore?.includes('<!-- friday:begin -->'))
    add(agentsMd, mergeAgentsMd(mdBefore, install), true, "Friday's guidance for the agent");
  return changes;
}

/**
 * Writes the plan the way `friday harness config claude-code` does (atomic writes, one `.bak` a day
 * of each user file Friday rewrites), then removes `.agents/` when Friday's removal emptied it.
 */
export function applyAntigravityPlan(changes: FileChange[]): void {
  applyPlan(changes);
  for (const c of changes) {
    if (c.after !== null || !c.display.startsWith('.agents/')) continue;
    try {
      rmdirSync(path.dirname(c.path));
    } catch {
      // not empty: the user's own files stay
    }
  }
}
