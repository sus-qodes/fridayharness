/**
 * Cursor's hooks (`.cursor/hooks.json`, version 1; plan M8b.2, A.5). Cursor names its events in
 * camelCase, keys every input by `conversation_id`, carries `cursor_version`, and reads a JSON reply
 * with `permission` from its permission hooks; exit code 2 blocks.
 *
 * Its `preToolUse` fires for every agent tool but cannot ask a human, while the dedicated shell and
 * MCP hooks can: those calls are left to the dedicated hooks, so each call is judged once and an
 * "ask" reaches a human. `beforeReadFile` repeats reads the `preToolUse` Read already carried, so it
 * applies only the launcher's own rules (it also sees reads of attached files).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { HookJudgment, HostModule, HostReply, NormalizedHook } from '../types.js';
import { finish, firstString, type MappedTool, mcpName, obj, str, unreadableWrite, withoutAsk } from './common.js';

/** The tracked launcher every Friday hook in `.cursor/hooks.json` runs (`friday harness config cursor`). */
export const CURSOR_LAUNCHER_FILE = '.friday/harness/cursor/hook.mjs';
/** Cursor's hooks whose reply it reads as a permission: without `failClosed` a failing one lets the call through. */
export const CURSOR_PERMISSION_HOOKS = ['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile'];

/** Whether a `.cursor/hooks.json` entry is one of Friday's: its command runs Friday's launcher. */
export function runsFridayLauncher(entry: unknown): boolean {
  const command = (entry as { command?: unknown } | null)?.command;
  return typeof command === 'string' && command.replaceAll('\\', '/').includes(CURSOR_LAUNCHER_FILE);
}

/**
 * What a failing permission hook of this checkout does in Cursor, from its `.cursor/hooks.json`
 * (plan B21): `fail-closed` when each permission hook runs Friday's launcher with `failClosed`,
 * `fail-open` when one of Friday's runs without it, null when the file cannot be read or a
 * permission hook is not Friday's (what then happens is not known). The level rule reads it.
 */
export function cursorHookFailure(root: string): 'fail-closed' | 'fail-open' | null {
  let hooks: Record<string, unknown>;
  try {
    const file = JSON.parse(readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8')) as { hooks?: unknown };
    hooks = obj(file.hooks);
  } catch {
    return null;
  }
  let open = false;
  for (const event of CURSOR_PERMISSION_HOOKS) {
    const ours = (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []).filter(runsFridayLauncher);
    if (!ours.length) return null;
    if (ours.some((h) => (h as { failClosed?: unknown }).failClosed !== true)) open = true;
  }
  return open ? 'fail-open' : 'fail-closed';
}

/** Whether a project runs Friday's launcher from Cursor's own hooks (`.cursor/hooks.json`). */
export function cursorRunsFriday(root: string): boolean {
  try {
    const file = JSON.parse(readFileSync(path.join(root, '.cursor', 'hooks.json'), 'utf8')) as { hooks?: unknown };
    return Object.values(obj(file.hooks)).some((list) => Array.isArray(list) && list.some(runsFridayLauncher));
  } catch {
    return false;
  }
}

const EVENTS: Record<string, string> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  preToolUse: 'PreToolUse',
  beforeShellExecution: 'PreToolUse',
  beforeMCPExecution: 'PreToolUse',
  beforeReadFile: 'PreToolUse',
  postToolUse: 'PostToolUse',
  postToolUseFailure: 'PostToolUseFailure',
  stop: 'Stop',
};

/** Hooks whose reply Cursor reads as a permission: there, no reply or a broken one blocks. */
const PERMISSION_EVENTS = new Set(CURSOR_PERMISSION_HOOKS);
/** The permission hooks that honour "ask". */
const ASKING_EVENTS = new Set(['beforeShellExecution', 'beforeMCPExecution']);

/**
 * Friday's reply when it has no decision. A permission hook with `failClosed` blocks on no output,
 * so Friday answers an empty object: it states no permission and approves nothing (B9). Whether
 * Cursor reads `{}` as no objection is the first thing the live check settles (plan M8b.2).
 */
export const CURSOR_NO_DECISION = '{}';

/** Where Cursor's tools keep the file they act on; its hook page does not name them per tool. */
const PATH_KEYS = ['file_path', 'path', 'target_file', 'filePath', 'targetFile', 'target'];

/** One tool of `preToolUse`, `postToolUse` or `postToolUseFailure` in Friday's vocabulary. */
function tool(name: string, input: Record<string, unknown>, pre: boolean): MappedTool {
  if (name === 'Read') {
    const p = firstString(input, PATH_KEYS);
    // A read Friday cannot place is left to `beforeReadFile`, whose input names the file.
    if (!p) return { tool: null, input: null };
    const range = Object.fromEntries(
      (['offset', 'limit'] as const).filter((k) => typeof input[k] === 'number').map((k) => [k, input[k]]),
    );
    return { tool: 'Read', input: { file_path: p, ...range } };
  }
  if (name === 'Write' || name === 'Edit' || name === 'Delete' || name === 'MultiEdit') {
    const p = firstString(input, PATH_KEYS);
    if (p) return { tool: 'Write', input: { file_path: p } };
    return { tool: 'Write', input: {}, shape_error: pre ? unreadableWrite('Cursor', name) : null };
  }
  if (name === 'Grep') {
    return {
      tool: 'Grep',
      input: {
        pattern: str(input.pattern),
        path: firstString(input, ['path', 'directory', 'dir_path']),
        glob: firstString(input, ['glob', 'include']),
      },
    };
  }
  if (name === 'Glob' || name === 'ListDir' || name === 'LS') {
    return {
      tool: 'Glob',
      input: {
        pattern: firstString(input, ['pattern', 'glob_pattern', 'glob']),
        path: firstString(input, ['path', 'target_directory', 'directory', 'dir_path']),
      },
    };
  }
  if (name === 'Shell') {
    if (pre) return { tool: null, input: null, judging: 'defer' };
    return { tool: 'Shell', input: { command: str(input.command) } };
  }
  if (name.startsWith('MCP:')) {
    // `preToolUse` does not name the MCP server, so Friday's own tools cannot be told apart here.
    return pre ? { tool: null, input: null, judging: 'defer' } : { tool: null, input: null };
  }
  if (name === 'WebFetch') return { tool: 'WebFetch', input: { url: str(input.url) } };
  if (name === 'WebSearch')
    return { tool: 'WebSearch', input: { query: firstString(input, ['query', 'search_term']) } };
  // Task (a subagent, whose own calls are hooked) and any tool Cursor adds later: no decision.
  return { tool: null, input: null };
}

/** `beforeMCPExecution` gives the arguments as a JSON string. */
function mcpArguments(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string') return obj(v);
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { input: parsed };
  } catch {
    return { input: v };
  }
}

const COMMON = [
  'conversation_id',
  'generation_id',
  'model',
  'model_id',
  'model_params',
  'hook_event_name',
  'cursor_version',
  'workspace_roots',
  'user_email',
  'transcript_path',
];
const TOOL = [...COMMON, 'tool_name', 'tool_input', 'tool_use_id', 'cwd', 'agent_message', 'parent_tool_call_id'];

export const cursor: HostModule = {
  vendor: 'cursor',
  name: 'Cursor',
  knownKeys: {
    sessionStart: [...COMMON, 'session_id', 'is_background_agent', 'composer_mode'],
    sessionEnd: [
      ...COMMON,
      'session_id',
      'reason',
      'duration_ms',
      'is_background_agent',
      'final_status',
      'error_message',
    ],
    preToolUse: TOOL,
    postToolUse: [...TOOL, 'tool_output', 'duration'],
    postToolUseFailure: [...TOOL, 'error_message', 'failure_type', 'duration', 'is_interrupt'],
    beforeShellExecution: [...COMMON, 'command', 'cwd', 'sandbox', 'tool_use_id'],
    beforeMCPExecution: [
      ...COMMON,
      'tool_name',
      'tool_input',
      'mcp_server_name',
      'mcp_server_url',
      'url',
      'command',
      'tool_use_id',
    ],
    beforeReadFile: [...COMMON, 'file_path', 'content', 'attachments'],
    stop: [...COMMON, 'status', 'loop_count'],
  },
  normalize(raw, hostEvent, env): NormalizedHook {
    const e = hostEvent || str(raw.hook_event_name) || 'unknown';
    const event = EVENTS[e] ?? null;
    let mapped: MappedTool = { tool: null, input: null };
    let hostTool = str(raw.tool_name);
    if (e === 'beforeShellExecution') {
      hostTool = 'Shell';
      // `cwd`: the folder the command runs in; relative names in it are read from there.
      const cwd = str(raw.cwd);
      mapped = { tool: 'Shell', input: { command: str(raw.command), ...(cwd ? { cwd } : {}) } };
    } else if (e === 'beforeMCPExecution') {
      // A missing server name is not Friday's: judged as a third-party server's tool, never skipped.
      const server = str(raw.mcp_server_name) ?? 'unknown-server';
      mapped = hostTool
        ? { tool: mcpName(server, hostTool), input: mcpArguments(raw.tool_input) }
        : { tool: null, input: null };
    } else if (e === 'beforeReadFile') {
      // Its `content` (the whole file) and `attachments` stay in the launcher.
      const p = str(raw.file_path);
      hostTool = 'Read';
      mapped = p ? { tool: 'Read', input: { file_path: p }, judging: 'local' } : { tool: null, input: null };
    } else if (hostTool && (e === 'preToolUse' || e === 'postToolUse' || e === 'postToolUseFailure')) {
      mapped = tool(hostTool, obj(raw.tool_input), e === 'preToolUse');
    }
    const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots : [];
    return finish({
      vendor: 'cursor',
      event,
      host_event: e,
      session_id: str(raw.conversation_id) ?? str(raw.session_id),
      tool_name: mapped.tool,
      host_tool_name: hostTool,
      tool_input: mapped.input,
      cwd: str(raw.cwd),
      project_dir: str(env.CURSOR_PROJECT_DIR) ?? str(roots[0]),
      host_version: str(raw.cursor_version) ?? str(env.CURSOR_VERSION),
      model: str(raw.model_id) ?? str(raw.model),
      source: e === 'sessionStart' ? 'startup' : null,
      // `loop_count` counts follow-ups over the conversation, not this stop's chain: the router keeps its own count.
      stop_hook_active: null,
      // Cursor runs `stop` for an aborted or failed loop too, and submits a follow-up as the next user message.
      stop_completed: e === 'stop' ? str(raw.status) === 'completed' : null,
      stop_reason: e === 'stop' ? str(raw.status) : null,
      reason: e === 'sessionEnd' ? str(raw.reason) : null,
      error: e === 'postToolUseFailure' ? str(raw.error_message) : null,
      judging: mapped.judging ?? 'full',
      can_ask: ASKING_EVENTS.has(e),
      shape_error: mapped.shape_error ?? null,
    });
  },
  render(j: HookJudgment, input): HostReply {
    const e = input.host_event;
    if (PERMISSION_EVENTS.has(e)) {
      const d = ASKING_EVENTS.has(e) ? j : withoutAsk(j, 'Cursor');
      if (d.decision === 'deny') {
        const reason = `Friday: ${d.reason}`;
        // The reply says why; exit code 2 blocks even if Cursor did not read it.
        return {
          stdout: JSON.stringify({ permission: 'deny', user_message: reason, agent_message: reason }),
          stderr: reason,
          exit_code: 2,
        };
      }
      if (d.decision === 'ask') {
        const reason = `Friday: ${d.reason}`;
        return {
          stdout: JSON.stringify({ permission: 'ask', user_message: reason, agent_message: reason }),
          stderr: '',
          exit_code: 0,
        };
      }
      return { stdout: CURSOR_NO_DECISION, stderr: '', exit_code: 0 };
    }
    if (e === 'sessionStart' && j.decision === 'context') {
      return { stdout: JSON.stringify({ additional_context: j.text }), stderr: '', exit_code: 0 };
    }
    if (e === 'stop' && j.decision === 'continue') {
      return { stdout: JSON.stringify({ followup_message: `Friday: ${j.reason}` }), stderr: '', exit_code: 0 };
    }
    return { stdout: '{}', stderr: '', exit_code: 0 };
  },
};

/**
 * A call Cursor sends through Claude Code's hooks (its third-party import) in a project whose
 * `.cursor/hooks.json` does not run Friday's launcher: nothing else of Friday's judges it, so the
 * launcher's own rules do (protected files, unreadable writes), and nothing reaches the daemon.
 * Cursor gives the import its own input and names (`preToolUse`, `Shell`, `Write`); a shell call
 * there has no dedicated hook to defer to, so its command is read here. Null for anything else.
 */
export function importedCursorCall(raw: Record<string, unknown>, env: NodeJS.ProcessEnv): NormalizedHook | null {
  const input = cursor.normalize(raw, str(raw.hook_event_name) ?? '', env);
  if (input.host_event !== 'preToolUse') return null;
  if (input.host_tool_name === 'Shell') {
    const command = str(obj(raw.tool_input).command);
    return command ? finish({ ...input, tool_name: 'Shell', tool_input: { command }, judging: 'local' }) : null;
  }
  return input.tool_name && input.judging !== 'defer' ? { ...input, judging: 'local' } : null;
}
