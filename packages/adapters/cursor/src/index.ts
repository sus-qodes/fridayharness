/**
 * @friday/adapter-cursor (experimental, plan M8b.2)
 * Cursor attached through its project hooks, MCP server and rule (`friday harness config cursor`),
 * its doctor, and spawn mode, which drives the Cursor CLI headless with Friday's hooks for each run
 * attempt (`friday harness run cursor`). The hook launcher is the one every host shares, from
 * `@friday/adapter-claude`.
 */
export const PACKAGE_NAME = '@friday/adapter-cursor';

export {
  CURSOR_SPAWN_RULES,
  CursorSpawnAdapter,
  type CursorSpawnOptions,
  chatIdFrom,
  cursorHostUsage,
  FRIDAY_SERVER,
  finalFrom,
  hookShellCommand,
  MAX_FOLLOWUPS,
  projectHookEvents,
} from './adapter.js';
export {
  type CursorCliIo,
  type CursorConfigFlags,
  type CursorRunFlags,
  cursorConfigCli,
  cursorDoctorCli,
  cursorRunCli,
} from './cli.js';
export {
  applyCursorPlan,
  type CursorConfigOptions,
  isFridayCursorHook,
  mergeCursorHooks,
  mergeCursorMcp,
  planCursor,
  ruleIsOurs,
} from './config.js';
export {
  type CursorCli,
  type CursorIde,
  compareCliVersions,
  cursorAgentHome,
  cursorEnvironment,
  findCursorAgent,
  findCursorIde,
  installedVersions,
} from './detect.js';
export {
  type CursorCheck,
  type CursorDoctorOptions,
  type CursorDoctorReport,
  cursorDoctor,
  DOCUMENTED_CLI,
  DOCUMENTED_IDE,
  inspectCursorHooks,
  PRE_TOOL_USE_MIN,
  WINDOWS_HOOK_FIX,
} from './doctor.js';
export {
  CURSOR_HARNESS_DIR,
  CURSOR_HARNESS_README,
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_SCRIPT,
  CURSOR_HOOK_TIMEOUTS,
  CURSOR_LAUNCH_MCP,
  CURSOR_MCP_ENTRY,
  CURSOR_PERMISSION_EVENTS,
  CURSOR_RULE_MDC,
  CURSOR_TEMPLATE_VERSION,
  type CursorHookEntry,
  type CursorHookEvent,
  cursorHookCommand,
  fridayCursorHooks,
  RULE_MARKER,
  SPAWN_RUN_ENV,
} from './templates.js';
