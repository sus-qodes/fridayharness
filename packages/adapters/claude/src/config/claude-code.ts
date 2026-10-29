import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FridayError } from '@friday/protocol';
import { loadProject, privateDirFor, writePrivateFile } from '@friday/sdk';
import {
  CLAUDE_MD_BLOCK,
  fridayHooks,
  HARNESS_README,
  LAUNCH_MCP,
  MCP_ALLOW_RULE,
  MCP_ENTRY,
  SKILL_MD,
  SKILL_REFERENCE_MD,
  TEMPLATE_VERSION,
} from './templates.js';

export interface ClaudeConfigOptions {
  projectDir: string;
  agentKey?: string;
  /** Where the hooks go: `.claude/settings.json` (shared, default) or `.claude/settings.local.json`. */
  scope?: 'project' | 'local';
  claudeMd?: boolean;
  remove?: boolean;
  /** Bundled launcher contents (defaults to this package's dist/hook.mjs). */
  hookSource?: string;
}

export interface FileChange {
  /** Absolute path. */
  path: string;
  /** Path shown to the user (project-relative, or the private dir). */
  display: string;
  before: string | null;
  after: string | null;
  tracked: boolean;
  note: string;
  /** Friday owns the whole file, so no backup is kept when it changes. */
  owned: boolean;
}

const FRIDAY_HOOK_SUFFIX = '.friday/harness/claude-code/hook.mjs';

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

/**
 * Where Friday's own built hook launcher is: spawn mode runs it from there (ADR-0032 §11), since a
 * spawned session reads no settings of the repository's, and no tracked copy is needed.
 */
export function bundledHookPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '..', 'hook.mjs'), path.resolve(here, '..', '..', 'dist', 'hook.mjs')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new FridayError(
    'invalid_request',
    'the hook launcher is not built yet; run "pnpm build" in the Friday repository first',
  );
}

export function bundledHookSource(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(here, '..', 'hook.mjs'), path.resolve(here, '..', '..', 'dist', 'hook.mjs')]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  throw new FridayError(
    'invalid_request',
    'the hook launcher is not built yet; run "pnpm build" in the Friday repository first',
  );
}

function isFridayHookEntry(entry: unknown): boolean {
  const hooks = (entry as { hooks?: { args?: unknown[]; command?: string }[] })?.hooks ?? [];
  return hooks.some(
    (h) =>
      (Array.isArray(h.args) &&
        h.args.some((a) => typeof a === 'string' && a.replaceAll('\\', '/').endsWith(FRIDAY_HOOK_SUFFIX))) ||
      (typeof h.command === 'string' && h.command.replaceAll('\\', '/').includes(FRIDAY_HOOK_SUFFIX)),
  );
}

/** Removes Friday's hook entries and (unless removing) appends the current ones. User entries are kept in order. */
export function mergeSettings(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const hooks: Record<string, unknown[]> = { ...((existing.hooks as Record<string, unknown[]>) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    const kept = (entries ?? []).filter((e) => !isFridayHookEntry(e));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (install)
    for (const [event, entries] of Object.entries(fridayHooks())) hooks[event] = [...(hooks[event] ?? []), ...entries];
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;

  const perms: Record<string, unknown> = { ...((existing.permissions as Record<string, unknown>) ?? {}) };
  // `mcp__friday` allows every tool of the friday server. Older templates wrote `mcp__friday__*`.
  const allow = ((perms.allow as string[]) ?? []).filter((r) => r !== MCP_ALLOW_RULE && r !== 'mcp__friday__*');
  if (install) allow.push(MCP_ALLOW_RULE);
  if (allow.length) perms.allow = allow;
  else delete perms.allow;
  if (Object.keys(perms).length) out.permissions = perms;
  else delete out.permissions;
  return out;
}

function mergeMcp(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  const servers: Record<string, unknown> = { ...((existing.mcpServers as Record<string, unknown>) ?? {}) };
  if (install) servers.friday = MCP_ENTRY;
  else delete servers.friday;
  const out: Record<string, unknown> = { ...existing, mcpServers: servers };
  if (Object.keys(servers).length === 0) delete out.mcpServers;
  return out;
}

function mergeLocalSettings(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  const enabled = ((existing.enabledMcpjsonServers as string[]) ?? []).filter((s) => s !== 'friday');
  if (install) enabled.push('friday');
  const out = { ...existing };
  if (enabled.length) out.enabledMcpjsonServers = enabled;
  else delete out.enabledMcpjsonServers;
  return out;
}

/** Adds or removes the marker block; the blank line before it belongs to the block, so both directions are exact. */
function mergeClaudeMd(existing: string | null, install: boolean): string | null {
  const re = /\n?<!-- friday:begin -->[\s\S]*?<!-- friday:end -->\n?/;
  const base = (existing ?? '').replace(re, '');
  if (!install) return existing === null || base.trim() === '' ? null : base;
  return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${base ? '\n' : ''}${CLAUDE_MD_BLOCK}\n`;
}

/** `.git/info/exclude` of the repository (works in linked worktrees too), or undefined outside git. */
function gitExcludeFile(root: string): string | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function skillIsOurs(text: string | null): boolean {
  if (text === null) return true;
  const m = /managed-by:\s*friday[\s\S]*?template-version:\s*(\d+)/.exec(text);
  return Boolean(m && Number(m[1]) <= TEMPLATE_VERSION);
}

/**
 * Plans every file `friday harness config claude-code` writes (plan Appendix 4).
 * Nothing written contains a token, a port or a machine-specific path.
 */
export function planClaudeCode(opts: ClaudeConfigOptions): FileChange[] {
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

  const priv = privateDirFor(ref);
  const agentFile = path.join(priv, 'agent.json');
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

  const harnessDir = path.join(root, '.friday', 'harness', 'claude-code');
  add(
    path.join(harnessDir, 'hook.mjs'),
    install ? (opts.hookSource ?? bundledHookSource()) : null,
    true,
    'hook launcher (policy checks)',
    true,
  );
  add(path.join(harnessDir, 'launch-mcp.mjs'), install ? LAUNCH_MCP : null, true, 'starts the friday MCP server', true);
  add(path.join(harnessDir, 'README.md'), install ? HARNESS_README : null, true, 'what these files are', true);

  /** Rewrites a JSON file only when Friday's part changed (so a user's formatting survives); an empty result deletes it. */
  const addJson = (
    abs: string,
    before: string | null,
    merge: (existing: Record<string, unknown>) => Record<string, unknown>,
    tracked: boolean,
    note: string,
  ) => {
    const parsed = json(before, path.relative(root, abs) || abs);
    const merged = merge(parsed);
    if (before !== null && JSON.stringify(merged) === JSON.stringify(parsed)) return;
    add(abs, Object.keys(merged).length === 0 ? null : stringify(merged), tracked, note);
  };

  const mcpPath = path.join(root, '.mcp.json');
  addJson(mcpPath, read(mcpPath), (e) => mergeMcp(e, install), true, 'registers the friday MCP server');

  // The hooks and the friday tool permission live in exactly one settings file: settings.json (shared, the
  // default) or settings.local.json (--scope local). Installing into one removes them from the other, so a
  // scope change never runs the hooks twice. settings.local.json also pre-approves the friday server.
  const local = opts.scope === 'local';
  const sharedPath = path.join(root, '.claude', 'settings.json');
  const localPath = path.join(root, '.claude', 'settings.local.json');
  addJson(
    sharedPath,
    read(sharedPath),
    (e) => mergeSettings(e, install && !local),
    true,
    'Friday hooks and tool permission',
  );
  addJson(
    localPath,
    read(localPath),
    (e) => mergeLocalSettings(mergeSettings(e, install && local), install),
    false,
    local
      ? 'Friday hooks and tool permission, and enables the friday MCP server for you'
      : 'enables the friday MCP server for you',
  );
  // settings.local.json is personal: keep it out of git without touching a tracked .gitignore.
  const exclude = install ? gitExcludeFile(root) : undefined;
  if (exclude) {
    const before = read(exclude);
    const line = '/.claude/settings.local.json';
    if (!(before ?? '').split(/\r?\n/).includes(line)) {
      const after = `${before ?? ''}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`;
      changes.push({
        path: exclude,
        display: '(git) info/exclude',
        before,
        after,
        tracked: false,
        note: 'keeps .claude/settings.local.json out of git',
        owned: false,
      });
    }
  }

  const skillDir = path.join(root, '.claude', 'skills', 'friday');
  const skillBefore = read(path.join(skillDir, 'SKILL.md'));
  if (skillIsOurs(skillBefore)) {
    add(path.join(skillDir, 'SKILL.md'), install ? SKILL_MD : null, true, 'the friday skill', true);
    add(
      path.join(skillDir, 'reference.md'),
      install ? SKILL_REFERENCE_MD : null,
      true,
      'tool reference for the skill',
      true,
    );
  }

  if (opts.claudeMd || !install) {
    const cmPath = path.join(root, 'CLAUDE.md');
    const cmBefore = read(cmPath);
    if (opts.claudeMd || cmBefore?.includes('<!-- friday:begin -->'))
      add(cmPath, mergeClaudeMd(cmBefore, install), true, 'short Friday note for Claude');
  }
  return changes;
}

/** Removes `dir` and up to `levels - 1` parents while they are empty; stops at the first non-empty one. */
function pruneEmptyDirs(dir: string, levels: number): void {
  for (let i = 0; i < levels; i += 1) {
    try {
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Writes the plan atomically, keeping one `.bak` of each user file Friday rewrites for the first time today. */
export function applyPlan(changes: FileChange[]): void {
  const day = new Date().toISOString().slice(0, 10);
  for (const c of changes) {
    if (c.display.startsWith('(git)')) {
      if (c.after !== null) {
        mkdirSync(path.dirname(c.path), { recursive: true });
        writeFileSync(c.path, c.after);
      }
      continue;
    }
    if (c.display.startsWith('(private)')) {
      if (c.after === null) rmSync(c.path, { force: true });
      else writePrivateFile(path.dirname(c.path), path.basename(c.path), c.after);
      continue;
    }
    // Back up user files Friday rewrites. A deletion only happens once nothing of the user's is left.
    if (c.before !== null && c.after !== null && !c.owned && !existsSync(`${c.path}.friday-${day}.bak`)) {
      writeFileSync(`${c.path}.friday-${day}.bak`, c.before);
    }
    if (c.after === null) {
      rmSync(c.path, { force: true });
      // Folders Friday created (.claude/skills/friday, .friday/harness/claude-code) go too once empty.
      if (c.display.startsWith('.claude/') || c.display.startsWith('.friday/harness/'))
        pruneEmptyDirs(path.dirname(c.path), c.display.split('/').length - 1);
      continue;
    }
    mkdirSync(path.dirname(c.path), { recursive: true });
    const tmp = `${c.path}.${process.pid}.tmp`;
    writeFileSync(tmp, c.after);
    renameSync(tmp, c.path);
  }
}
