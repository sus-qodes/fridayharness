/**
 * `friday harness config cursor` (plan M8b.2): plans and applies Friday's Cursor files the way the
 * Claude Code writer does. It is idempotent (a second run changes nothing), reversible (`--remove`
 * takes out only what Friday added), keeps the user's own entries in order, and keeps one backup of
 * each user file it rewrites on a given day.
 */
import { existsSync, readFileSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { applyPlan, bundledHookSource, type FileChange } from '@friday/adapter-claude';
import { FridayError } from '@friday/protocol';
import { loadProject, privateDirFor } from '@friday/sdk';
import {
  CURSOR_HARNESS_DIR,
  CURSOR_HARNESS_README,
  CURSOR_HOOK_SCRIPT,
  CURSOR_LAUNCH_MCP,
  CURSOR_MCP_ENTRY,
  CURSOR_RULE_MDC,
  CURSOR_TEMPLATE_VERSION,
  fridayCursorHooks,
} from './templates.js';

export interface CursorConfigOptions {
  projectDir: string;
  agentKey?: string;
  remove?: boolean;
  /** Bundled launcher contents (defaults to the Claude Code adapter's dist/hook.mjs, one launcher for every host). */
  hookSource?: string;
  env?: NodeJS.ProcessEnv;
}

function read(p: string): string | null {
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

function json(text: string | null, file: string): Record<string, unknown> {
  if (!text?.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new FridayError('invalid_request', `${file} is not a JSON object; fix or remove it first`);
}

const stringify = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** An entry of a Cursor `hooks.json` that runs Friday's launcher. */
export function isFridayCursorHook(entry: unknown): boolean {
  const command = (entry as { command?: unknown } | null)?.command;
  return typeof command === 'string' && command.replaceAll('\\', '/').includes(CURSOR_HOOK_SCRIPT);
}

/**
 * Removes Friday's entries from a `hooks.json` and, unless removing, appends the current ones after
 * the user's. Version 1 is the only format Friday writes; a file of another version is left alone.
 */
export function mergeCursorHooks(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  if (existing.version !== undefined && existing.version !== 1) {
    throw new FridayError(
      'invalid_request',
      `.cursor/hooks.json has version ${JSON.stringify(existing.version)}; Friday writes version 1 only`,
    );
  }
  const hooks: Record<string, unknown[]> = {};
  for (const [event, entries] of Object.entries((existing.hooks as Record<string, unknown[]> | undefined) ?? {})) {
    const kept = (Array.isArray(entries) ? entries : []).filter((e) => !isFridayCursorHook(e));
    if (kept.length) hooks[event] = kept;
  }
  if (install)
    for (const [event, entries] of Object.entries(fridayCursorHooks()))
      hooks[event] = [...(hooks[event] ?? []), ...entries];
  const { hooks: _old, version: _v, ...rest } = existing;
  if (!Object.keys(hooks).length && !Object.keys(rest).length) return {};
  return { version: 1, ...rest, ...(Object.keys(hooks).length ? { hooks } : {}) };
}

/** Sets or removes the `friday` server; the user's servers stay as they are. */
export function mergeCursorMcp(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  const servers: Record<string, unknown> = { ...((existing.mcpServers as Record<string, unknown>) ?? {}) };
  if (install) servers.friday = CURSOR_MCP_ENTRY;
  else delete servers.friday;
  const out: Record<string, unknown> = { ...existing, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete out.mcpServers;
  return out;
}

/** Friday's rule file, or none: a `friday.mdc` without Friday's marker is the user's and is never touched. */
export function ruleIsOurs(text: string | null): boolean {
  if (text === null) return true;
  const m = /managed-by: friday; template-version: (\d+)/.exec(text);
  return Boolean(m && Number(m[1]) <= CURSOR_TEMPLATE_VERSION);
}

/**
 * Plans every file `friday harness config cursor` writes. Nothing written contains a token, a port
 * or a machine-specific path; the agent key goes to this machine's private folder only.
 */
export function planCursor(opts: CursorConfigOptions): FileChange[] {
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

  // The agent key this machine's sessions work as: the launcher and the MCP server read it.
  const agentFile = path.join(privateDirFor(ref, opts.env), 'agent.json');
  if (install) {
    const agentKey = opts.agentKey ?? (json(read(agentFile), agentFile).agent_key as string | undefined) ?? 'dev-1';
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

  const harnessDir = path.join(root, ...CURSOR_HARNESS_DIR.split('/'));
  add(
    path.join(harnessDir, 'hook.mjs'),
    install ? (opts.hookSource ?? bundledHookSource()) : null,
    true,
    'hook launcher (policy checks)',
    true,
  );
  add(
    path.join(harnessDir, 'launch-mcp.mjs'),
    install ? CURSOR_LAUNCH_MCP : null,
    true,
    'starts the friday MCP server',
    true,
  );
  add(path.join(harnessDir, 'README.md'), install ? CURSOR_HARNESS_README : null, true, 'what these files are', true);

  /** Rewrites a JSON file only when Friday's part changed (a user's formatting survives); an empty result deletes it. */
  const addJson = (
    abs: string,
    merge: (existing: Record<string, unknown>) => Record<string, unknown>,
    note: string,
  ) => {
    const before = read(abs);
    const parsed = json(before, path.relative(root, abs).replaceAll('\\', '/'));
    const merged = merge(parsed);
    if (before !== null && JSON.stringify(merged) === JSON.stringify(parsed)) return;
    add(abs, Object.keys(merged).length === 0 ? null : stringify(merged), true, note);
  };
  const cursorDir = path.join(root, '.cursor');
  addJson(path.join(cursorDir, 'hooks.json'), (e) => mergeCursorHooks(e, install), "Friday's hooks, failing closed");
  addJson(path.join(cursorDir, 'mcp.json'), (e) => mergeCursorMcp(e, install), 'registers the friday MCP server');

  const rule = path.join(cursorDir, 'rules', 'friday.mdc');
  if (ruleIsOurs(read(rule))) add(rule, install ? CURSOR_RULE_MDC : null, true, "Friday's rule, always applied", true);
  return changes;
}

/** Removes `dir` and its parents up to `stop` while they are empty. */
function pruneEmptyDirs(dir: string, stop: string): void {
  for (let d = dir; d.startsWith(stop) && d !== path.dirname(stop); d = path.dirname(d)) {
    try {
      rmdirSync(d);
    } catch {
      return;
    }
    if (d === stop) return;
  }
}

/** Writes the plan as the Claude Code writer does; folders Friday emptied under `.cursor/` go too. */
export function applyCursorPlan(changes: FileChange[], projectRoot: string): void {
  applyPlan(changes);
  const cursorDir = path.join(projectRoot, '.cursor');
  for (const c of changes) {
    if (c.after === null && c.display.startsWith('.cursor/')) pruneEmptyDirs(path.dirname(c.path), cursorDir);
  }
}
