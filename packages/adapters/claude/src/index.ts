/**
 * @friday/adapter-claude
 * Claude Code adapter (attach mode): hook launcher and daemon hook routes, host configurator,
 * Claude Code detection and doctor checks. Spawn mode via the Agent SDK follows.
 */
export const PACKAGE_NAME = '@friday/adapter-claude';

export {
  applyPlan,
  bundledHookSource,
  type ClaudeConfigOptions,
  type FileChange,
  mergeSettings,
  planClaudeCode,
} from './config/claude-code.js';
export {
  CLAUDE_MD_BLOCK,
  fridayHooks,
  HARNESS_README,
  HOOK_PATH_ARG,
  LAUNCH_MCP,
  MCP_ALLOW_RULE,
  MCP_ENTRY,
  SKILL_MD,
  SKILL_REFERENCE_MD,
  TEMPLATE_VERSION,
} from './config/templates.js';
export {
  type ClaudeInstall,
  compareVersions,
  DEGRADED_MIN,
  detectClaudeCode,
  ENFORCING_MIN,
  type HookLevel,
  hookLevel,
} from './detect.js';
export {
  type ClaudeCheck,
  type ClaudeDoctorOptions,
  type ClaudeDoctorReport,
  claudeDoctor,
  workspaceTrusted,
} from './doctor.js';
export { actionFromTool, stripHookPayload } from './hooks/actions.js';
export {
  failureOutput,
  findRoot,
  LAUNCHER_VERSION,
  main as runHookLauncher,
  projectIdOf,
  projectKeyOf,
  stateDirFromEnv,
} from './hooks/launcher.js';
export { claudeCodeHooks } from './hooks/router.js';
export {
  COMMAND_TOOLS,
  HOOK_INPUT_KEYS,
  type HookEventName,
  type HookInput,
  NETWORK_TOOLS,
  POST_TOOL_MATCHER,
  PRE_TOOL_MATCHER,
  WRITE_TOOLS,
} from './hooks/types.js';
