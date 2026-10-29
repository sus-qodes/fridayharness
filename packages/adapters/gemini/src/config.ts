import { existsSync, readdirSync, readFileSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { applyPlan, bundledHookSource, type FileChange } from '@friday/adapter-claude';
import { FridayError } from '@friday/protocol';
import { loadProject, privateDirFor } from '@friday/sdk';
import {
  GEMINI_HARNESS_DIR,
  GEMINI_HARNESS_README,
  GEMINI_HOOK_FILE,
  GEMINI_LAUNCH_MCP,
  GEMINI_MCP_ENTRY,
  GEMINI_MD_BLOCK,
  geminiHooks,
} from './templates.js';

export interface GeminiConfigOptions {
  projectDir: string;
  agentKey?: string;
  remove?: boolean;
  /** Friday's block in `GEMINI.md` (default true). */
  geminiMd?: boolean;
  /** Bundled launcher contents (defaults to the Claude adapter's dist/hook.mjs, the one launcher for every host). */
  hookSource?: string;
}

const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const stringify = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Removes `//` and `/* *\/` comments outside strings: Gemini CLI reads its settings with comments
 * allowed, and so does Friday, though a file it rewrites keeps none (applyPlan keeps a backup).
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 1;
    } else out += c;
  }
  return out;
}

/** A settings file as an object: empty when absent, an error when it is not a JSON object. */
export function readSettings(text: string | null, file: string): { value: Record<string, unknown>; comments: boolean } {
  if (!text?.trim()) return { value: {}, comments: false };
  const parse = (t: string) => {
    try {
      const v = JSON.parse(t) as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const plain = parse(text);
  if (plain) return { value: plain, comments: false };
  const stripped = parse(stripJsonComments(text));
  if (stripped) return { value: stripped, comments: true };
  throw new FridayError('invalid_request', `${file} is not a JSON object; fix or remove it first`);
}

/** Whether a hook definition (`{matcher?, hooks: [...]}`) is one of Friday's. */
export function isFridayGeminiEntry(entry: unknown): boolean {
  const hooks = (entry as { hooks?: { command?: unknown }[] } | null)?.hooks ?? [];
  return (
    Array.isArray(hooks) &&
    hooks.some((h) => typeof h?.command === 'string' && h.command.replaceAll('\\', '/').includes(GEMINI_HOOK_FILE))
  );
}

/**
 * Friday's hooks and server merged into `.gemini/settings.json`: its own entries are replaced (or,
 * when removing, dropped) and every other key, hook and server stays as it was, in order.
 */
export function mergeGeminiSettings(existing: Record<string, unknown>, install: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...existing };
  const hooks: Record<string, unknown> = { ...((existing.hooks as Record<string, unknown>) ?? {}) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = entries.filter((e) => !isFridayGeminiEntry(e));
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (install) {
    for (const [event, entries] of Object.entries(geminiHooks())) {
      const before = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      hooks[event] = [...before, ...entries];
    }
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;

  const servers: Record<string, unknown> = { ...((existing.mcpServers as Record<string, unknown>) ?? {}) };
  if (install) servers.friday = GEMINI_MCP_ENTRY;
  else delete servers.friday;
  if (Object.keys(servers).length) out.mcpServers = servers;
  else delete out.mcpServers;
  return out;
}

/** Adds or removes the marker block; the blank line before it belongs to the block, so both directions are exact. */
export function mergeGeminiMd(existing: string | null, install: boolean): string | null {
  const re = /\n?<!-- friday:begin -->[\s\S]*?<!-- friday:end -->\n?/;
  const base = (existing ?? '').replace(re, '');
  if (!install) return existing === null || base.trim() === '' ? null : base;
  return `${base}${base && !base.endsWith('\n') ? '\n' : ''}${base ? '\n' : ''}${GEMINI_MD_BLOCK}\n`;
}

/**
 * Plans every file `friday harness config gemini` writes (plan M8b.4): the launcher and its
 * README, Friday's hooks and `friday` server in `.gemini/settings.json`, the block in `GEMINI.md`,
 * and this machine's agent key in the private folder. Nothing written holds a token, a port or a
 * machine path. Planning twice gives no change; `remove` undoes exactly what Friday added.
 */
export function planGemini(opts: GeminiConfigOptions): FileChange[] {
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

  if (install) {
    const agentFile = path.join(privateDirFor(ref), 'agent.json');
    const before = read(agentFile);
    let current: string | undefined;
    try {
      current = (readSettings(before, agentFile).value.agent_key as string | undefined) ?? undefined;
    } catch {
      current = undefined;
    }
    const agentKey = opts.agentKey ?? current ?? 'dev-1';
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(agentKey)) {
      throw new FridayError('invalid_request', `invalid agent key "${agentKey}"`);
    }
    const after = stringify({ agent_key: agentKey });
    if (before !== after) {
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
  }

  const harnessDir = path.join(root, ...GEMINI_HARNESS_DIR.split('/'));
  add(
    path.join(root, ...GEMINI_HOOK_FILE.split('/')),
    install ? (opts.hookSource ?? bundledHookSource()) : null,
    true,
    'hook launcher (policy checks)',
    true,
  );
  add(
    path.join(harnessDir, 'launch-mcp.mjs'),
    install ? GEMINI_LAUNCH_MCP : null,
    true,
    'starts the friday MCP server',
    true,
  );
  add(path.join(harnessDir, 'README.md'), install ? GEMINI_HARNESS_README : null, true, 'what these files are', true);

  const settingsPath = path.join(root, '.gemini', 'settings.json');
  const before = read(settingsPath);
  const parsed = readSettings(before, '.gemini/settings.json');
  const merged = mergeGeminiSettings(parsed.value, install);
  // Rewritten only when Friday's part changed, so a user's formatting survives a second run.
  if (before === null || JSON.stringify(merged) !== JSON.stringify(parsed.value)) {
    add(
      settingsPath,
      Object.keys(merged).length === 0 ? null : stringify(merged),
      true,
      `Friday hooks and the friday MCP server${parsed.comments ? ' (its comments are not kept; a backup is)' : ''}`,
    );
  }

  const mdPath = path.join(root, 'GEMINI.md');
  const mdBefore = read(mdPath);
  if (install ? opts.geminiMd !== false : mdBefore?.includes('<!-- friday:begin -->')) {
    add(mdPath, mergeGeminiMd(mdBefore, install), true, 'short Friday note Gemini CLI loads into every session');
  }
  return changes;
}

/** Writes the plan (`applyPlan`: atomic writes, one backup a day of each user file), then drops an emptied `.gemini/`. */
export function applyGeminiPlan(changes: FileChange[], root: string): void {
  applyPlan(changes);
  const dir = path.join(root, '.gemini');
  if (changes.some((c) => c.after === null && c.display.startsWith('.gemini/'))) {
    try {
      if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
    } catch {
      // the folder stays: something else is in it, or it is in use
    }
  }
}
