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

/**
 * Tools whose PreToolUse decision Friday makes (ADR-0009, spike S8), and from M6d every MCP tool
 * (ADR-0030): Friday's own get no decision, third-party ones pass the server policy.
 */
export const PRE_TOOL_MATCHER = 'Read|Glob|Grep|Edit|Write|NotebookEdit|Bash|PowerShell|WebFetch|WebSearch|mcp__.*';
/** Tools Friday observes after they ran. EnterWorktree/ExitWorktree change the working directory. */
export const POST_TOOL_MATCHER = 'Edit|Write|NotebookEdit|Bash|PowerShell|EnterWorktree|ExitWorktree|mcp__.*';
/** Friday's own MCP tools: judged by the protocol behind them, never by the hook. */
export const isFridayTool = (name: string) => name.startsWith('mcp__friday__');
/** `mcp__<server>__<tool>` of another server, or null. */
export function thirdPartyMcp(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__') || isFridayTool(name)) return null;
  const [, server, ...rest] = name.split('__');
  return server && rest.length ? { server, tool: rest.join('__') } : null;
}
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
/**
 * Shell tools. `Shell` is Friday's name for another host's shell whose dialect the hook does not
 * say (Cursor's, Antigravity's, Gemini CLI's): its commands are read in every dialect the
 * classifier knows, which is the stricter reading.
 */
export const COMMAND_TOOLS = new Set(['Bash', 'PowerShell', 'Shell']);
export const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch']);

// ---- every host (plan M8b.1) ---------------------------------------------------------------

/**
 * The hosts whose hooks the launcher reads, by the vendor id the daemon's route
 * (`/hooks/<vendor>/<event>`) and its harness records use.
 */
export const HOOK_VENDORS = ['claude-code', 'cursor', 'antigravity', 'gemini'] as const;
export type HookVendor = (typeof HOOK_VENDORS)[number];
export const isHookVendor = (v: unknown): v is HookVendor => HOOK_VENDORS.includes(v as HookVendor);

/** Friday's names for the hook events it acts on: Claude Code's, whose router came first. */
export const FRIDAY_HOOK_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'SessionEnd',
] as const;
export type FridayHookEvent = (typeof FRIDAY_HOOK_EVENTS)[number];

/**
 * How much of Friday's judgment one host event gets:
 * - `full`: the launcher's own rules, then the daemon;
 * - `local`: the launcher's own rules only; a call they pass gets no decision and nothing is sent,
 *   because another hook of the host carries the same call to the daemon (Cursor's
 *   `beforeReadFile` beside its `preToolUse` Read);
 * - `defer`: no decision and nothing sent, because a dedicated hook of the host fires for the same
 *   call and can carry Friday's whole answer (Cursor's shell and MCP hooks can ask a human, its
 *   `preToolUse` cannot).
 */
export type HookJudging = 'full' | 'local' | 'defer';

/**
 * One hook input in Friday's terms, whatever host sent it. A host module (`hosts/<vendor>.ts`)
 * builds it from the host's stdin JSON; unknown values are null, never guessed.
 */
export interface NormalizedHook {
  vendor: HookVendor;
  /** Friday's name for the event; null when Friday does nothing with this host event. */
  event: string | null;
  /** The event as the host named it (the launcher's argument, else the input's own field). */
  host_event: string;
  /** The host's session id: Claude Code's `session_id`, Cursor's `conversation_id`, … */
  session_id: string | null;
  /** The tool in Friday's vocabulary (Claude Code's names, plus `Shell`); null when Friday does not judge it. */
  tool_name: string | null;
  /** The tool as the host named it. */
  host_tool_name: string | null;
  /** The tool's input under the keys `actions.ts` reads (`file_path`, `command`, …); no file bodies. */
  tool_input: Record<string, unknown> | null;
  /** What `actionFromTool` derives from the two above. */
  paths: string[];
  command: string | null;
  cwd: string | null;
  /** Where the host says the project is (its environment or input), before Friday finds the root. */
  project_dir: string | null;
  host_version: string | null;
  model: string | null;
  /** SessionStart: startup, resume, clear or compact. */
  source: string | null;
  /** Stop: whether the host is already continuing because of a stop hook; null when it does not say. */
  stop_hook_active: boolean | null;
  /**
   * Stop: whether the host says the agent ended its turn itself (Cursor's `status: "completed"`,
   * Antigravity's `terminationReason: "model_stop"`). False when it ended any other way: a human
   * stopped it, an error, a step limit. Friday never holds such a stop, since the host would take
   * Friday's message for the next prompt and go on against the human's decision. Null where the
   * host does not say: Claude Code runs no Stop hook on an interrupt, Gemini CLI's AfterAgent
   * follows an answer.
   */
  stop_completed: boolean | null;
  /** Stop: how the host says the turn ended, in its own words (Cursor's `status`, Antigravity's `terminationReason`). */
  stop_reason: string | null;
  /** SessionEnd: why the session ended. */
  reason: string | null;
  /** PostToolUseFailure: the host's error text. */
  error: string | null;
  judging: HookJudging;
  /** Whether this host event can ask a human; where it cannot, Friday's "ask" becomes a refusal with a pending approval. */
  can_ask: boolean;
  /** Why the module could not read this call's input; a write it cannot read is declined. */
  shape_error: string | null;
}

/**
 * Friday's answer to one hook, before a host module turns it into the host's reply. Friday only
 * restricts (B9): there is no "allow" here, and a host module never answers allow or approve.
 * Reasons carry no "Friday:" prefix; each host's reply adds it.
 */
export type HookJudgment =
  | { decision: 'none' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string }
  /** SessionStart: text for the session. `brief` marks a one-line note rather than the context packet. */
  | { decision: 'context'; text: string; brief?: boolean }
  /** Stop: keep the agent working once, with this message. */
  | { decision: 'continue'; reason: string };

/** What the launcher prints and how it exits, for one host. */
export interface HostReply {
  stdout: string;
  stderr: string;
  exit_code: number;
}

/** One host's translation, in and out (`hosts/<vendor>.ts`). */
export interface HostModule {
  vendor: HookVendor;
  /** The host's name in messages and harness records. */
  name: string;
  /** The host's stdin JSON (and the environment it gave the hook) in Friday's terms. */
  normalize(raw: Record<string, unknown>, hostEvent: string, env: NodeJS.ProcessEnv): NormalizedHook;
  /** Friday's judgment as the host's reply: its JSON shape and exit code. */
  render(judgment: HookJudgment, input: NormalizedHook): HostReply;
  /** Input keys the module reads or knowingly leaves out, per host event: drift tests compare fixtures against these. */
  knownKeys: Record<string, readonly string[]>;
}
