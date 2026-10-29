/**
 * Gemini CLI's hooks (`.gemini/settings.json` `hooks`; plan M8b.4, A.5). Its input is snake_case
 * like Claude Code's (`session_id`, `tool_name`, `tool_input`, `mcp_context`), its events are
 * `BeforeTool`, `AfterTool`, `AfterAgent`, and a `decision` of `deny` or `ask` restricts; exit code
 * 2 blocks too. No reply means no decision. A crashed or timed-out hook lets the call through and
 * no version can change that, so the level is `degraded` (fail-open).
 */
import type { HookJudgment, HostModule, HostReply, NormalizedHook } from '../types.js';
import { bool, finish, lineRange, type MappedTool, mcpName, obj, str, strings, unreadableWrite } from './common.js';

const EVENTS: Record<string, string> = {
  SessionStart: 'SessionStart',
  BeforeTool: 'PreToolUse',
  AfterTool: 'PostToolUse',
  AfterAgent: 'Stop',
  SessionEnd: 'SessionEnd',
};

const WRITES: Record<string, string> = { write_file: 'Write', replace: 'Edit' };

/**
 * The URLs one `web_fetch` call fetches, read as Gemini CLI reads them: its `url`, and each word of
 * its prompt that holds `://` and parses as an http or https URL. A word that does not parse makes
 * the host refuse the call itself. Sorted and without repeats, so one set is one target.
 */
export function webFetchUrls(input: Record<string, unknown>): string[] {
  const found = new Set<string>();
  const add = (word: string) => {
    if (!word.includes('://')) return;
    try {
      const u = new URL(word);
      if (u.protocol === 'http:' || u.protocol === 'https:') found.add(u.href);
    } catch {
      // not a URL the host would fetch
    }
  };
  const url = str(input.url);
  if (url) add(url);
  for (const word of (str(input.prompt) ?? '').split(/\s+/)) if (word) add(word);
  return [...found].sort();
}

/** One Gemini CLI tool in Friday's vocabulary; MCP tools are named by their `mcp_context`. */
function tool(name: string, input: Record<string, unknown>, mcp: Record<string, unknown>, pre: boolean): MappedTool {
  if (name === 'read_file') {
    const p = str(input.file_path);
    return p
      ? { tool: 'Read', input: { file_path: p, ...lineRange(input.start_line, input.end_line) } }
      : { tool: null, input: null };
  }
  const write = WRITES[name];
  if (write) {
    const p = str(input.file_path);
    if (p) return { tool: write, input: { file_path: p } };
    return { tool: write, input: {}, shape_error: pre ? unreadableWrite('Gemini CLI', name) : null };
  }
  if (name === 'read_many_files') return { tool: 'Glob', input: { patterns: strings(input.include) } };
  if (name === 'glob') return { tool: 'Glob', input: { pattern: str(input.pattern), path: str(input.dir_path) } };
  if (name === 'list_directory') return { tool: 'Glob', input: { path: str(input.dir_path) } };
  if (name === 'grep_search') {
    return {
      tool: 'Grep',
      input: { pattern: str(input.pattern), path: str(input.dir_path), glob: str(input.include_pattern) },
    };
  }
  if (name === 'run_shell_command') {
    // `dir_path`: where the command runs, relative to the session's folder (the project's root).
    const dir = str(input.dir_path);
    return { tool: 'Shell', input: { command: str(input.command), ...(dir ? { cwd: dir } : {}) } };
  }
  if (name === 'web_fetch') {
    // One call fetches every URL its prompt holds (up to 20, private addresses included): the
    // target Friday judges, and a human's approval covers, is all of them together.
    const urls = webFetchUrls(input);
    return { tool: 'WebFetch', input: { url: urls.length ? urls.join(' ') : (str(input.url) ?? str(input.prompt)) } };
  }
  if (name === 'google_web_search') return { tool: 'WebSearch', input: { query: str(input.query) } };
  const server = str(mcp.server_name);
  const mcpTool = str(mcp.tool_name);
  if (server && mcpTool) return { tool: mcpName(server, mcpTool), input };
  // Without its context an MCP tool is `mcp_<server>_<tool>`; a server name without underscores is assumed.
  const named = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (named?.[1] && named[2]) return { tool: mcpName(named[1], named[2]), input };
  // Memory, todos, skills, plan mode, subagents (each a tool named after the agent): not judged by Friday.
  return { tool: null, input: null };
}

const BASE = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'timestamp'];

export const gemini: HostModule = {
  vendor: 'gemini',
  name: 'Gemini CLI',
  knownKeys: {
    SessionStart: [...BASE, 'source'],
    BeforeTool: [...BASE, 'tool_name', 'tool_input', 'mcp_context', 'original_request_name'],
    AfterTool: [...BASE, 'tool_name', 'tool_input', 'tool_response', 'mcp_context', 'original_request_name'],
    AfterAgent: [...BASE, 'prompt', 'prompt_response', 'stop_hook_active'],
    SessionEnd: [...BASE, 'reason'],
  },
  normalize(raw, hostEvent, env): NormalizedHook {
    const e = hostEvent || str(raw.hook_event_name) || 'unknown';
    const hostTool = str(raw.tool_name);
    const response = obj(raw.tool_response);
    const failure = e === 'AfterTool' ? (str(response.error) ?? str(obj(response.error).message)) : null;
    const mapped =
      hostTool && (e === 'BeforeTool' || e === 'AfterTool')
        ? tool(hostTool, obj(raw.tool_input), obj(raw.mcp_context), e === 'BeforeTool')
        : { tool: null, input: null };
    return finish({
      vendor: 'gemini',
      event: failure ? 'PostToolUseFailure' : (EVENTS[e] ?? null),
      host_event: e,
      session_id: str(raw.session_id),
      tool_name: mapped.tool,
      host_tool_name: hostTool,
      tool_input: mapped.input,
      cwd: str(raw.cwd),
      // The host fills it with the session's working directory, not the repository's root.
      project_dir: str(env.GEMINI_PROJECT_DIR) ?? str(env.GEMINI_CWD),
      // Hook input does not carry the host's version; the doctor reads it from `gemini --version`.
      host_version: null,
      model: null,
      source: e === 'SessionStart' ? str(raw.source) : null,
      stop_hook_active: e === 'AfterAgent' ? bool(raw.stop_hook_active) : null,
      // AfterAgent follows the agent's answer; its input does not say how the turn ended.
      stop_completed: null,
      stop_reason: null,
      reason: e === 'SessionEnd' ? str(raw.reason) : null,
      error: failure,
      judging: 'full',
      can_ask: true,
      shape_error: mapped.shape_error ?? null,
    });
  },
  render(j: HookJudgment, input): HostReply {
    const e = input.host_event;
    if (e === 'BeforeTool') {
      if (j.decision === 'deny') {
        const reason = `Friday: ${j.reason}`;
        // The JSON is read whatever the exit code; exit 2 with the reason on stderr blocks even without it.
        return { stdout: JSON.stringify({ decision: 'deny', reason }), stderr: reason, exit_code: 2 };
      }
      if (j.decision === 'ask') {
        const reason = `Friday: ${j.reason}`;
        return {
          stdout: JSON.stringify({ decision: 'ask', reason, systemMessage: reason }),
          stderr: '',
          exit_code: 0,
        };
      }
      return { stdout: '', stderr: '', exit_code: 0 };
    }
    if (e === 'SessionStart' && j.decision === 'context') {
      return {
        stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: j.text } }),
        stderr: '',
        exit_code: 0,
      };
    }
    if (e === 'AfterAgent' && j.decision === 'continue') {
      // Refusing the answer sends the reason back as the next prompt, once (`stop_hook_active`).
      return { stdout: JSON.stringify({ decision: 'deny', reason: `Friday: ${j.reason}` }), stderr: '', exit_code: 0 };
    }
    return { stdout: '', stderr: '', exit_code: 0 };
  },
};
