import { createHash } from 'node:crypto';
import type { PolicyAction } from '@friday/policy';
import { COMMAND_TOOLS, NETWORK_TOOLS, thirdPartyMcp, WRITE_TOOLS } from './types.js';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
/** `patterns`: Friday's key for a search of another host that names several globs at once. */
const many = (one: unknown, list: unknown): string[] =>
  [str(one), ...(Array.isArray(list) ? list.slice(0, 100).map(str) : [])].filter((x): x is string => Boolean(x));

/**
 * Maps a tool call in Friday's vocabulary (Claude Code's tools, plus `Shell`; another host's call
 * is translated by its host module first) to the action Friday's policy evaluates. Unknown tools
 * return null.
 */
export function actionFromTool(toolName: string, input: Record<string, unknown>): PolicyAction | null {
  if (toolName === 'Read') {
    const p = str(input.file_path);
    return p ? { tool: toolName, kind: 'read', paths: [p] } : null;
  }
  if (toolName === 'Glob') {
    return {
      tool: toolName,
      kind: 'search',
      patterns: many(input.pattern, input.patterns),
      paths: [str(input.path)].filter((x): x is string => Boolean(x)),
    };
  }
  if (toolName === 'Grep') {
    // `pattern` is a regex over file contents, not a path; `glob` and `path` select files.
    return {
      tool: toolName,
      kind: 'search',
      patterns: many(input.glob, input.patterns),
      paths: [str(input.path)].filter((x): x is string => Boolean(x)),
    };
  }
  if (WRITE_TOOLS.has(toolName)) {
    const p = str(input.file_path) ?? str(input.notebook_path);
    return p ? { tool: toolName, kind: 'write', paths: [p] } : null;
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const c = str(input.command);
    // `cwd`: the folder another host's shell runs the command in, when its hook names it.
    const cwd = str(input.cwd);
    return c ? { tool: toolName, kind: 'command', command: c, ...(cwd ? { cwd } : {}) } : null;
  }
  if (NETWORK_TOOLS.has(toolName)) {
    return { tool: toolName, kind: 'network', url: str(input.url) ?? `search: ${str(input.query) ?? ''}` };
  }
  const mcp = thirdPartyMcp(toolName);
  if (mcp) {
    const { texts, pathish } = inputStrings(input);
    return { tool: toolName, kind: 'mcp', server: mcp.server, mcpTool: mcp.tool, texts, pathish };
  }
  return null;
}

const PATH_KEY = /path|file|dir|folder|uri|url|target|dest|source|cwd|root|location/i;

/**
 * The strings of an MCP tool's input (ADR-0030 §2), bounded: every one is checked like a command,
 * and the ones that look like paths (by their key, a separator or a leading dot) like a write.
 */
export function inputStrings(input: unknown): { texts: string[]; pathish: string[] } {
  const texts: string[] = [];
  const pathish: string[] = [];
  const walk = (v: unknown, key: string, depth: number): void => {
    if (texts.length >= 200 || depth > 6) return;
    if (typeof v === 'string') {
      const t = v.length > 8000 ? v.slice(0, 8000) : v;
      texts.push(t);
      const looks =
        t.length <= 1024 && !/[\r\n]/.test(t) && (PATH_KEY.test(key) || /[\\/]/.test(t) || t.startsWith('.'));
      if (looks) pathish.push(t);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 100)) walk(x, key, depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) walk(x, k, depth + 1);
    }
  };
  walk(input, '', 0);
  return { texts, pathish };
}

const BODY_FIELDS = new Set(['content', 'new_string', 'old_string', 'new_source', 'old_source']);

function digest(s: string): { bytes: number; sha256: string } {
  return { bytes: Buffer.byteLength(s, 'utf8'), sha256: createHash('sha256').update(s).digest('hex') };
}

function trimText(v: unknown, max: number): unknown {
  return typeof v === 'string' && v.length > max ? `${v.slice(0, max)}…[truncated ${v.length - max} chars]` : v;
}

/**
 * Removes file bodies and large tool output before a hook payload leaves the launcher:
 * the event log records what happened, never file contents (spec Part 01, Principle B).
 */
export function stripHookPayload<T extends Record<string, unknown>>(hook: T): T {
  const out: Record<string, unknown> = { ...hook };
  const ti = hook.tool_input as Record<string, unknown> | undefined;
  if (ti && typeof ti === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ti)) {
      if (BODY_FIELDS.has(k) && typeof v === 'string') cleaned[k] = { redacted_body: true, ...digest(v) };
      else if (k === 'edits' && Array.isArray(v)) cleaned[k] = { redacted_body: true, count: v.length };
      else cleaned[k] = trimText(v, 4000);
    }
    out.tool_input = cleaned;
  }
  const tr = hook.tool_response as Record<string, unknown> | undefined;
  if (tr !== undefined) {
    const toolName = String(hook.tool_name ?? '');
    if (tr && typeof tr === 'object' && (toolName === 'Bash' || toolName === 'PowerShell')) {
      out.tool_response = {
        stdout: trimText(tr.stdout, 2000),
        stderr: trimText(tr.stderr, 2000),
        interrupted: tr.interrupted ?? null,
        exit_code: tr.exitCode ?? tr.exit_code ?? null,
      };
    } else if (tr && typeof tr === 'object' && (tr as { filePath?: unknown }).filePath) {
      out.tool_response = {
        filePath: (tr as { filePath: unknown }).filePath,
        type: (tr as { type?: unknown }).type ?? null,
      };
    } else {
      delete out.tool_response;
    }
  }
  if (typeof hook.last_assistant_message === 'string')
    out.last_assistant_message = trimText(hook.last_assistant_message, 2000);
  return out as T;
}
