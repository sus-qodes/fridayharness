/**
 * Claude Code's hooks (plan B9, Appendix 9). Its input already speaks Friday's vocabulary, since
 * Friday's router was written for it, so normalizing only names the fields; its replies are the
 * shapes the router has always returned.
 */
import { HOOK_INPUT_KEYS, type HookJudgment, type HostModule, type NormalizedHook } from '../types.js';
import { bool, finish, obj, str } from './common.js';

/** Claude Code's hook output for one judgment; `allow` is reserved for Friday's own spawned sessions (ADR-0032 §11). */
export function claudeHookOutput(
  j: HookJudgment | { decision: 'allow'; reason: string },
): Record<string, unknown> | string | null {
  switch (j.decision) {
    case 'none':
      return null;
    case 'deny':
    case 'ask':
    case 'allow':
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: j.decision,
          permissionDecisionReason: `Friday: ${j.reason}`,
        },
      };
    case 'context':
      // Claude Code adds a SessionStart hook's plain output to the session too; short notes go that way.
      return j.brief ? j.text : { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: j.text } };
    case 'continue':
      return { decision: 'block', reason: `Friday: ${j.reason}` };
  }
}

export const claudeCode: HostModule = {
  vendor: 'claude-code',
  name: 'Claude Code',
  knownKeys: HOOK_INPUT_KEYS,
  normalize(raw, hostEvent, env): NormalizedHook {
    const tool = str(raw.tool_name);
    const model = raw.model;
    return finish({
      vendor: 'claude-code',
      // Friday's event names are Claude Code's; one Friday does not handle reaches the router's default.
      event: hostEvent,
      host_event: hostEvent,
      session_id: str(raw.session_id),
      tool_name: tool,
      host_tool_name: tool,
      tool_input: tool ? obj(raw.tool_input) : null,
      cwd: str(raw.cwd),
      project_dir: str(env.CLAUDE_PROJECT_DIR),
      // Claude Code tells its MCP server its version (ADR-0016 §2), not its hooks.
      host_version: null,
      model: str(model) ?? str(obj(model).id),
      source: str(raw.source),
      stop_hook_active: bool(raw.stop_hook_active),
      // Claude Code runs no Stop hook when a human interrupts the turn.
      stop_completed: null,
      stop_reason: null,
      reason: str(raw.reason),
      error: str(raw.error),
      judging: 'full',
      can_ask: true,
      shape_error: null,
    });
  },
  render(j) {
    const out = claudeHookOutput(j);
    return {
      stdout: out === null ? '' : typeof out === 'string' ? out : JSON.stringify(out),
      stderr: '',
      exit_code: 0,
    };
  },
};
