/**
 * @friday/adapter-claude
 * Claude Code adapter: attach mode (hook launcher and daemon hook routes, host configurator,
 * detection and doctor checks) and spawn mode, which drives the installed Claude Code headless
 * with Friday's hooks (ADR-0032 §11).
 */
export const PACKAGE_NAME = '@friday/adapter-claude';

/** The program names a host's hook command starts from the project root, which Friday protects (host.config). */
export { ROOT_PROGRAMS } from '@friday/policy';
export {
  applyPlan,
  bundledHookPath,
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
  SPAWN_RUN_ENV,
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
  SPAWN_MIN,
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
  ANTIGRAVITY_NO_DECISION,
  CURSOR_LAUNCHER_FILE,
  CURSOR_NO_DECISION,
  CURSOR_PERMISSION_HOOKS,
  claudeHookOutput,
  cursorHookFailure,
  cursorRunsFriday,
  type FailureContext,
  failureJudgment,
  HOST_MODULES,
  hostModule,
  importedByCursor,
  importedCursorCall,
  launcherArgs,
  runsFridayLauncher,
  webFetchUrls,
  wireHook,
  wireHost,
  withoutAsk,
} from './hooks/hosts/index.js';
export {
  failureOutput,
  findRoot,
  LAUNCHER_BUDGET_MS,
  LAUNCHER_DEFAULT_BUDGET_MS,
  LAUNCHER_VERSION,
  main as runHookLauncher,
  projectIdOf,
  projectKeyOf,
  stateDirFromEnv,
} from './hooks/launcher.js';
export { claudeCodeHooks, claudeCodeHooks as hostHooks } from './hooks/router.js';
export {
  COMMAND_TOOLS,
  FRIDAY_HOOK_EVENTS,
  type FridayHookEvent,
  HOOK_INPUT_KEYS,
  HOOK_VENDORS,
  type HookEventName,
  type HookInput,
  type HookJudging,
  type HookJudgment,
  type HookVendor,
  type HostModule,
  type HostReply,
  isHookVendor,
  NETWORK_TOOLS,
  type NormalizedHook,
  POST_TOOL_MATCHER,
  PRE_TOOL_MATCHER,
  WRITE_TOOLS,
} from './hooks/types.js';
export {
  CLAUDE_SPAWN_RULES,
  ClaudeSpawnAdapter,
  type ClaudeSpawnOptions,
  FRIDAY_SERVER,
  SPAWN_TOOLS,
  STRUCTURED_OUTPUT,
} from './spawn/adapter.js';
export { claudeEnvironment } from './spawn/environment.js';
export { ToolEndpoints } from './spawn/tools.js';
