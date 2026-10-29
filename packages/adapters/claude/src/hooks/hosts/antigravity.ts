/**
 * Antigravity's hooks (`.agents/hooks.json`, shared by the App, the CLI `agy` and the IDE; plan
 * M8b.3, A.5). Its input is camelCase (`conversationId`, `workspacePaths`, `toolCall {name, args}`,
 * `modelName`) and its PreToolUse reply carries a `decision`. Friday answers `deny`, `force_ask`
 * or no decision, never `allow` or `auto_approve` (B9: Friday restricts, it does not approve).
 * What the host does with a crashed or timed-out hook is not documented, so its level stays
 * `unverified` until a run shows it.
 */
import type { HookJudgment, HostModule, HostReply, NormalizedHook } from '../types.js';
import { finish, lineRange, type MappedTool, mcpName, obj, str, strings, unreadableWrite } from './common.js';

const EVENTS: Record<string, string> = {
  SessionStart: 'SessionStart',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  Stop: 'Stop',
};

/**
 * Friday's reply when it has no decision: an empty object, since `allow` and `auto_approve` are the
 * host's words for passing a call on. Whether the host reads `{}` as no objection is part of the
 * live check (plan M8b.3); a hook that printed nothing was read as no objection from CLI 1.0.16.
 */
export const ANTIGRAVITY_NO_DECISION = '{}';

const WRITES = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);

/** One Antigravity tool in Friday's vocabulary; the argument names are the host's documented ones. */
function tool(name: string, args: Record<string, unknown>, pre: boolean): MappedTool {
  if (name === 'view_file') {
    const p = str(args.AbsolutePath);
    return p
      ? { tool: 'Read', input: { file_path: p, ...lineRange(args.StartLine, args.EndLine) } }
      : { tool: null, input: null };
  }
  if (WRITES.has(name)) {
    const p = str(args.TargetFile);
    if (p) return { tool: name === 'write_to_file' ? 'Write' : 'Edit', input: { file_path: p } };
    return { tool: 'Write', input: {}, shape_error: pre ? unreadableWrite('Antigravity', name) : null };
  }
  if (name === 'list_dir') return { tool: 'Glob', input: { path: str(args.DirectoryPath) } };
  if (name === 'find_by_name') {
    return { tool: 'Glob', input: { pattern: str(args.Pattern), path: str(args.SearchDirectory) } };
  }
  if (name === 'grep_search') {
    return {
      tool: 'Grep',
      input: { pattern: str(args.Query), path: str(args.SearchPath), patterns: strings(args.Includes) },
    };
  }
  if (name === 'run_command') {
    // `Cwd`: the folder the command runs in; relative names in it are read from there.
    const cwd = str(args.Cwd);
    return { tool: 'Shell', input: { command: str(args.CommandLine), ...(cwd ? { cwd } : {}) } };
  }
  if (name === 'search_web') return { tool: 'WebSearch', input: { query: str(args.query) } };
  if (name === 'read_url_content') return { tool: 'WebFetch', input: { url: str(args.Url) } };
  // How MCP tools are named in hook input is not documented: both MCP spellings are read.
  if (name.startsWith('mcp__')) return { tool: name, input: args };
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (mcp?.[1] && mcp[2]) return { tool: mcpName(mcp[1], mcp[2]), input: args };
  // Subagents, messages, tasks, schedules, questions, images, browser tools: not judged by Friday.
  return { tool: null, input: null };
}

export const antigravity: HostModule = {
  vendor: 'antigravity',
  name: 'Antigravity',
  knownKeys: {
    SessionStart: ['conversationId', 'workspacePaths', 'transcriptPath', 'artifactDirectoryPath', 'modelName'],
    PreToolUse: [
      'conversationId',
      'workspacePaths',
      'transcriptPath',
      'artifactDirectoryPath',
      'modelName',
      'toolCall',
      'stepIdx',
    ],
    PostToolUse: [
      'conversationId',
      'workspacePaths',
      'transcriptPath',
      'artifactDirectoryPath',
      'modelName',
      'toolCall',
      'stepIdx',
      'error',
    ],
    Stop: [
      'conversationId',
      'workspacePaths',
      'transcriptPath',
      'artifactDirectoryPath',
      'modelName',
      'executionNum',
      'terminationReason',
      'error',
      'fullyIdle',
    ],
  },
  normalize(raw, hostEvent): NormalizedHook {
    const e = hostEvent || str(raw.hook_event_name) || 'unknown';
    const call = obj(raw.toolCall);
    const hostTool = str(call.name);
    const args = obj(call.args);
    const failed = e === 'PostToolUse' && Boolean(str(raw.error));
    const mapped =
      hostTool && (e === 'PreToolUse' || e === 'PostToolUse')
        ? tool(hostTool, args, e === 'PreToolUse')
        : { tool: null, input: null };
    const roots = Array.isArray(raw.workspacePaths) ? raw.workspacePaths : [];
    return finish({
      vendor: 'antigravity',
      event: failed ? 'PostToolUseFailure' : (EVENTS[e] ?? null),
      host_event: e,
      session_id: str(raw.conversationId),
      tool_name: mapped.tool,
      host_tool_name: hostTool,
      tool_input: mapped.input,
      cwd: hostTool === 'run_command' ? str(args.Cwd) : null,
      project_dir: str(roots[0]),
      // Hook input does not carry the host's version; the doctor reads it from `agy --version`.
      host_version: null,
      model: str(raw.modelName),
      source: e === 'SessionStart' ? 'startup' : null,
      stop_hook_active: null,
      // Its page names `model_stop`, `max_steps_exceeded` and `error`; what a human's cancel gives is
      // not documented, so only the model's own end of its turn counts as completed.
      stop_completed: e === 'Stop' ? str(raw.terminationReason) === 'model_stop' : null,
      stop_reason: e === 'Stop' ? str(raw.terminationReason) : null,
      reason: null,
      error: failed ? str(raw.error) : null,
      judging: 'full',
      can_ask: true,
      shape_error: mapped.shape_error ?? null,
    });
  },
  render(j: HookJudgment, input): HostReply {
    const e = input.host_event;
    // The documented channel is JSON on stdout; exit codes have no documented meaning, so always 0.
    const reply = (v: unknown): HostReply => ({ stdout: JSON.stringify(v), stderr: '', exit_code: 0 });
    if (e === 'PreToolUse') {
      if (j.decision === 'deny') return reply({ decision: 'deny', reason: `Friday: ${j.reason}` });
      // `ask` would pass a call the human once marked "Always Allow"; Friday's ask is for this call.
      if (j.decision === 'ask') return reply({ decision: 'force_ask', reason: `Friday: ${j.reason}` });
      return { stdout: ANTIGRAVITY_NO_DECISION, stderr: '', exit_code: 0 };
    }
    if (e === 'SessionStart' && j.decision === 'context') {
      return reply({ injectSteps: [{ systemMessage: { systemMessage: j.text } }] });
    }
    if (e === 'Stop' && j.decision === 'continue')
      return reply({ decision: 'continue', reason: `Friday: ${j.reason}` });
    return { stdout: '{}', stderr: '', exit_code: 0 };
  },
};
