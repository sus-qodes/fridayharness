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
 * Friday's reply to a call it has no objection to. Antigravity requires a decision ("`decision`
 * (string, required)" in the hooks guide shipped with the CLI): a reply without one, the `{}`
 * Friday sent until the first live session, is read as a denial with no reason ("tool call denied
 * by pre-tool hook: ", CLI 1.5.9, 2026-11-16), so not one call ran in a session with Friday's hooks.
 *
 * `ask` hands the call to the person and to their own Antigravity permissions: it prompts, and it
 * "respects the Always Allow cache". It is the reply to a call Friday did not judge: a tool it has
 * no rule for, or any call while Friday is down. A call Friday did judge and pass is answered
 * `allow` (`render`, the owner's choice of 2026-11-16); `auto_approve` is never sent.
 */
export const ANTIGRAVITY_NO_DECISION = JSON.stringify({
  decision: 'ask',
  reason: 'Friday: not judged by Friday; your Antigravity permissions decide',
});

/** Writes by the names of CLI 1.4 and before; from CLI 1.5 the tools are `write_file` and `edit_file`. */
const WRITES = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'write_file',
  'edit_file',
]);
const WHOLE_FILE = new Set(['write_to_file', 'write_file']);

/**
 * A file tool's path. `TargetFile` and `AbsolutePath` are the documented names of CLI 1.4; the
 * tools of CLI 1.5 (`read_file`, `write_file`, `edit_file`) take `Path` (seen for `read_file` in a
 * session of 1.5.9; the other two are not documented, so each known spelling is read). A write
 * whose path is under none of them is declined, never passed unjudged.
 */
function filePath(args: Record<string, unknown>): string | null {
  for (const key of ['Path', 'AbsolutePath', 'TargetFile', 'FilePath']) {
    const p = str(args[key]);
    if (p) return p;
  }
  return null;
}

/** One Antigravity tool in Friday's vocabulary; the argument names are the host's documented ones. */
function tool(name: string, args: Record<string, unknown>, pre: boolean): MappedTool {
  if (name === 'view_file' || name === 'read_file') {
    const p = filePath(args);
    return p
      ? { tool: 'Read', input: { file_path: p, ...lineRange(args.StartLine, args.EndLine) } }
      : { tool: null, input: null };
  }
  if (WRITES.has(name)) {
    const p = filePath(args);
    if (p) return { tool: WHOLE_FILE.has(name) ? 'Write' : 'Edit', input: { file_path: p } };
    return { tool: 'Write', input: {}, shape_error: pre ? unreadableWrite('Antigravity', name) : null };
  }
  // A lazily loaded MCP tool (the default from CLI 1.5): one built-in tool carries the server and the tool.
  if (name === 'call_mcp_tool') {
    const server = str(args.ServerName);
    const called = str(args.ToolName);
    return server && called
      ? { tool: mcpName(server, called), input: obj(args.Arguments) }
      : { tool: null, input: null };
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
  // An eagerly loaded MCP tool is registered as `mcp_<server>_<tool>`; the double-underscore
  // spelling of other hosts is read too.
  if (name.startsWith('mcp__')) return { tool: name, input: args };
  const mcp = /^mcp_([^_]+)_(.+)$/.exec(name);
  if (mcp?.[1] && mcp[2]) return { tool: mcpName(mcp[1], mcp[2]), input: args };
  // Subagents, messages, tasks, schedules, questions, images, browser tools: not judged by Friday.
  return { tool: null, input: null };
}

/**
 * The fields every hook input carries. `lastUserInput`, `hookEventName` and `cwd` (the agent's
 * working directory, not the hook's) came with CLI 1.5.
 */
const COMMON_KEYS = [
  'conversationId',
  'workspacePaths',
  'transcriptPath',
  'artifactDirectoryPath',
  'modelName',
  'lastUserInput',
  'hookEventName',
  'cwd',
] as const;

export const antigravity: HostModule = {
  vendor: 'antigravity',
  name: 'Antigravity',
  knownKeys: {
    SessionStart: [...COMMON_KEYS],
    PreToolUse: [...COMMON_KEYS, 'toolCall', 'stepIdx'],
    PostToolUse: [...COMMON_KEYS, 'toolCall', 'stepIdx', 'error'],
    Stop: [...COMMON_KEYS, 'executionNum', 'terminationReason', 'error', 'fullyIdle', 'continuationActive'],
    PreInvocation: [...COMMON_KEYS, 'invocationNum', 'initialNumSteps'],
  },
  normalize(raw, hostEvent): NormalizedHook {
    const e = hostEvent || str(raw.hook_event_name) || 'unknown';
    // Before each model call (2026-11-19). Only the first of a turn (`invocationNum` 0) is the
    // person's prompt; every later one is the agent's own step, answered here with nothing sent.
    if (e === 'PreInvocation') {
      const first = raw.invocationNum === 0;
      const roots = Array.isArray(raw.workspacePaths) ? raw.workspacePaths : [];
      return finish({
        vendor: 'antigravity',
        event: first ? 'UserPromptSubmit' : null,
        host_event: e,
        session_id: str(raw.conversationId),
        tool_name: null,
        host_tool_name: null,
        tool_input: null,
        cwd: str(raw.cwd),
        project_dir: str(roots[0]),
        host_version: null,
        model: str(raw.modelName),
        source: null,
        stop_hook_active: null,
        stop_completed: null,
        stop_reason: null,
        reason: null,
        error: null,
        judging: 'full',
        can_ask: false,
        shape_error: null,
        prompt: first ? (str(raw.lastUserInput)?.slice(0, 2000) ?? null) : null,
      });
    }
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
      // A command's own folder, else the agent's working directory (`cwd`, from CLI 1.5).
      cwd: hostTool === 'run_command' ? str(args.Cwd) || str(raw.cwd) : null,
      project_dir: str(roots[0]),
      // Hook input does not carry the host's version; the doctor reads it from `agy --version`.
      host_version: null,
      model: str(raw.modelName),
      source: e === 'SessionStart' ? 'startup' : null,
      stop_hook_active: null,
      // Its page named `model_stop`, `max_steps_exceeded` and `error`; what a human's cancel gives was
      // not documented, so only the model's own end of its turn counts as completed. The guide
      // shipped with CLI 1.5 names the model's own end `NO_TOOL_CALL` (and a cancel `USER_CANCELED`),
      // so on that CLI this is false and Friday never holds a stop. It is left so on purpose: holding
      // a stop there has a message queue prompt a session that its person should be driving, which
      // Antigravity's terms keep off a personal account. Reading `NO_TOOL_CALL` (with
      // `continuationActive` as `stop_hook_active`) is a decision to take, not a correction to make.
      stop_completed: e === 'Stop' ? str(raw.terminationReason) === 'model_stop' : null,
      stop_reason: e === 'Stop' ? str(raw.terminationReason) : null,
      stop_error: e === 'Stop' ? str(raw.error) : null,
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
      // A call Friday's own rules pass, or one of Friday's own tools: it goes ahead. The owner chose
      // this over a prompt at every such step (HookJudgment, 2026-11-16).
      if (j.decision === 'allow') return reply({ decision: 'allow', reason: `Friday: ${j.reason}` });
      // A call Friday did not judge (a tool it has no rule for, or Friday is down): the person and
      // their own permissions decide.
      return { stdout: ANTIGRAVITY_NO_DECISION, stderr: '', exit_code: 0 };
    }
    if (e === 'SessionStart' && j.decision === 'context') {
      return reply({ injectSteps: [{ systemMessage: { systemMessage: j.text } }] });
    }
    if (e === 'Stop' && j.decision === 'continue')
      return reply({ decision: 'continue', reason: `Friday: ${j.reason}` });
    // `/friday` with nothing to take: the turn ends before the model is called ("Stops execution
    // immediately before calling the model"), with Friday's words. Which kind of step the person
    // sees on a terminated turn is not documented; an error message is the one meant for them.
    if (e === 'PreInvocation' && j.decision === 'halt') {
      return reply({ terminationBehavior: 'terminate', injectSteps: [{ errorMessage: { errorMessage: j.text } }] });
    }
    return { stdout: '{}', stderr: '', exit_code: 0 };
  },
};
