/**
 * What every host module shares (plan M8b.1): reading loosely typed hook JSON, deriving the action
 * Friday judges, the failure rules when the daemon cannot decide, and the hook the daemon reads.
 */
import { actionFromTool } from '../actions.js';
import {
  COMMAND_TOOLS,
  type HookJudgment,
  NETWORK_TOOLS,
  type NormalizedHook,
  thirdPartyMcp,
  WRITE_TOOLS,
} from '../types.js';

export const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
export const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : str(v) ? [v as string] : [];

/** The first non-empty string among `keys` of `input`. */
export function firstString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = str(input[k]);
    if (v) return v;
  }
  return null;
}

/** A line range as Friday records it (`offset`, `limit`), from a first and a last line. */
export function lineRange(start: unknown, end: unknown): Record<string, number> {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const a = n(start);
  const b = n(end);
  return {
    ...(a !== null ? { offset: a } : {}),
    ...(b !== null ? { limit: Math.max(1, b - (a ?? 1) + 1) } : {}),
  };
}

/** A third-party or Friday MCP tool in Friday's vocabulary. */
export const mcpName = (server: string, tool: string) => `mcp__${server}__${tool}`;

/** A tool call in Friday's vocabulary, from a host module's mapping. */
export interface MappedTool {
  tool: string | null;
  input: Record<string, unknown> | null;
  judging?: NormalizedHook['judging'];
  shape_error?: string | null;
}

/** Fills in what `actionFromTool` derives, so every module reports paths and commands the same way. */
export function finish(h: Omit<NormalizedHook, 'paths' | 'command'>): NormalizedHook {
  const action = h.tool_name ? actionFromTool(h.tool_name, h.tool_input ?? {}) : null;
  return { ...h, paths: action?.paths ?? [], command: action?.command ?? null };
}

/** A write whose path a module cannot find is declined, never let through (B9: edits fail closed). */
export const unreadableWrite = (host: string, tool: string) =>
  `Friday could not find the file this ${host} ${tool} call writes in the input ${host} gave its hook, so it is declined. Update Friday, or tell the human which Friday and ${host} versions this is.`;

/**
 * Who could answer an "ask" from this hook: by default a human at the host. `canAsk: false` where
 * the host's hook cannot ask (Cursor's `preToolUse`); `headless` in a session Friday's spawn
 * adapter started (`FRIDAY_SPAWN_RUN`), where nobody is there to answer and the host would wait.
 */
export interface FailureContext {
  canAsk?: boolean;
  headless?: boolean;
}

/** What to do when the daemon cannot decide (plan M1.10 failure rules), for any host. */
export function failureJudgment(
  event: string | null,
  toolName: string | null | undefined,
  why: string,
  at: FailureContext = {},
): HookJudgment {
  if (event === 'PreToolUse' && toolName) {
    if (WRITE_TOOLS.has(toolName)) {
      return {
        decision: 'deny',
        reason: `edits are paused because Friday is unavailable (${why}). Ask the human to start Friday (its shortcut, the desktop app, or "friday run").`,
      };
    }
    if (COMMAND_TOOLS.has(toolName) || NETWORK_TOOLS.has(toolName) || thirdPartyMcp(toolName)) {
      // With Friday down there is no pending approval to grant: the call waits for Friday itself.
      if (at.headless) {
        return {
          decision: 'deny',
          reason: `Friday is unavailable (${why}) and no human is at this session to confirm this, so it is declined. If you cannot finish without it, end as blocked and say so.`,
        };
      }
      if (at.canAsk === false) {
        return {
          decision: 'deny',
          reason: `Friday is unavailable (${why}) and this hook cannot ask a human, so it is declined. Ask the human to start Friday (its shortcut, the desktop app, or "friday run"), then try again.`,
        };
      }
      return { decision: 'ask', reason: `Friday is unavailable (${why}), so a human must confirm this.` };
    }
    return { decision: 'none' };
  }
  if (event === 'SessionStart') {
    return {
      decision: 'context',
      brief: true,
      text: `Friday is not available for this session (${why}). Ask the human to start Friday (its shortcut, the desktop app, or "friday run" in the project), then restart the session. Do not edit files until Friday is available.`,
    };
  }
  return { decision: 'none' };
}

/**
 * Where a host event cannot ask a human, an "ask" becomes a refusal that says why: letting the
 * call through would turn a human's decision into none at all. The daemon already answers such a
 * hook with a refusal naming its pending approval, and the launcher's own answers are refusals
 * there too, so this is the last guard: it promises no approval that may not exist.
 */
export function withoutAsk(j: HookJudgment, host: string): HookJudgment {
  if (j.decision !== 'ask') return j;
  return {
    decision: 'deny',
    reason: `${j.reason} ${host} cannot ask a human from this hook, so Friday declines the call.`,
  };
}

/**
 * The hook another host's call is sent to the daemon as: the keys Claude Code's router reads, in
 * Friday's vocabulary, and nothing else (no transcript paths, user e-mail or file bodies).
 */
export function wireHook(h: NormalizedHook): Record<string, unknown> {
  const out: Record<string, unknown> = { hook_event_name: h.event };
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) out[k] = v;
  };
  put('session_id', h.session_id);
  put('cwd', h.cwd);
  put('tool_name', h.tool_name);
  put('tool_input', h.tool_input);
  put('source', h.source);
  put('model', h.model);
  put('stop_hook_active', h.stop_hook_active);
  put('reason', h.reason);
  put('error', h.error);
  return out;
}

/** The `host` block of a hook body sent for a host other than Claude Code. */
export function wireHost(h: NormalizedHook): Record<string, unknown> {
  return {
    vendor: h.vendor,
    event: h.host_event,
    tool_name: h.host_tool_name,
    version: h.host_version,
    can_ask: h.can_ask,
    ...(h.event === 'Stop' ? { stop_completed: h.stop_completed, stop_reason: h.stop_reason } : {}),
  };
}
