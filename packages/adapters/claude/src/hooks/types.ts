/**
 * Claude Code hook payloads, as recorded by the M0 spike against 2.1.296
 * (tests/fixtures/hooks/claude-code/v2.1/spike). Versioned with the fixtures.
 */
export interface HookCommon {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: HookEventName;
  permission_mode?: string;
  prompt_id?: string;
  effort?: { level: string };
  agent_id?: string;
  agent_type?: string;
}

export type HookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'SessionEnd'
  | 'SubagentStart';

export interface ToolHookInput extends HookCommon {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  mcp_server?: string;
}

export interface SessionStartInput extends HookCommon {
  source?: 'startup' | 'resume' | 'clear' | 'compact' | string;
  model?: string;
}

export interface StopInput extends HookCommon {
  stop_hook_active?: boolean;
  last_assistant_message?: string;
}

export interface SessionEndInput extends HookCommon {
  reason?: string;
}

export type HookInput = ToolHookInput | SessionStartInput | StopInput | SessionEndInput;

/** Keys the router understands per event; fixture drift tests compare recordings against these. */
export const HOOK_INPUT_KEYS: Record<HookEventName, readonly string[]> = {
  SessionStart: [
    'session_id',
    'transcript_path',
    'cwd',
    'hook_event_name',
    'source',
    'model',
    'agent_id',
    'agent_type',
  ],
  PreToolUse: [
    'session_id',
    'transcript_path',
    'cwd',
    'prompt_id',
    'permission_mode',
    'effort',
    'hook_event_name',
    'tool_name',
    'tool_input',
    'tool_use_id',
    'mcp_server',
    'agent_id',
    'agent_type',
  ],
  PostToolUse: [
    'session_id',
    'transcript_path',
    'cwd',
    'prompt_id',
    'permission_mode',
    'effort',
    'hook_event_name',
    'tool_name',
    'tool_input',
    'tool_response',
    'tool_use_id',
    'mcp_server',
    'agent_id',
    'agent_type',
    'duration_ms',
  ],
  PostToolUseFailure: [
    'session_id',
    'transcript_path',
    'cwd',
    'prompt_id',
    'permission_mode',
    'effort',
    'hook_event_name',
    'tool_name',
    'tool_input',
    'tool_use_id',
    'error',
    'is_interrupt',
    'mcp_server',
    'agent_id',
    'agent_type',
    'duration_ms',
  ],
  Stop: [
    'session_id',
    'transcript_path',
    'cwd',
    'prompt_id',
    'permission_mode',
    'effort',
    'hook_event_name',
    'stop_hook_active',
    'last_assistant_message',
    'turn_index',
    'background_tasks',
    'session_crons',
  ],
  SessionEnd: ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'reason', 'prompt_id', 'permission_mode'],
  SubagentStart: [
    'session_id',
    'transcript_path',
    'cwd',
    'hook_event_name',
    'agent_id',
    'agent_type',
    'prompt_id',
    'permission_mode',
    'effort',
  ],
};

/** Tools whose PreToolUse decision Friday makes (ADR-0009, spike S8). */
export const PRE_TOOL_MATCHER = 'Read|Glob|Grep|Edit|Write|NotebookEdit|Bash|PowerShell|WebFetch|WebSearch';
/** Tools Friday observes after they ran. EnterWorktree/ExitWorktree change the working directory. */
export const POST_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash|PowerShell|EnterWorktree|ExitWorktree';
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const COMMAND_TOOLS = new Set(['Bash', 'PowerShell']);
export const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);
