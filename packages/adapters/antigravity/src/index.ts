/**
 * @friday/adapter-antigravity
 * Antigravity adapter, attach only and experimental (plan M8b.3): `friday harness config
 * antigravity` writes Friday's hooks into `.agents/hooks.json`, the friday MCP server into
 * `.agents/mcp_config.json` and Friday's guidance into `AGENTS.md`; `friday harness doctor
 * antigravity` checks them. The hooks run the one launcher of @friday/adapter-claude, whose
 * Antigravity module answers deny, ask or nothing, never an approval. There is no spawn mode.
 */
export const PACKAGE_NAME = '@friday/adapter-antigravity';

export {
  type AntigravityCliIo,
  type AntigravityConfigFlags,
  antigravityConfigCli,
  antigravityDoctorCli,
} from './cli.js';
export {
  type AntigravityConfigOptions,
  applyAntigravityPlan,
  mergeAgentsMd,
  mergeHooks,
  mergeMcpConfig,
  planAntigravity,
  readJsonObject,
} from './config.js';
export {
  type AntigravityFound,
  type AntigravityInstall,
  agyVersion,
  BOM_SAFE,
  DOCUMENTED_VERSION,
  findAntigravity,
  HOOKS_MIN,
  parseVersion,
} from './detect.js';
export {
  type AntigravityCheck,
  type AntigravityDoctorOptions,
  type AntigravityDoctorReport,
  antigravityDoctor,
  hookGroupProblem,
} from './doctor.js';
export {
  type AntigravityLevel,
  FAILURE_EVIDENCE,
  type FailureEvidence,
  type FailureOutcome,
  levelFromEvidence,
  levelReason,
} from './evidence.js';
export {
  AGENTS_MD_BLOCK,
  type AntigravityHookEvent,
  fridayHookGroup,
  HARNESS_DIR,
  HARNESS_README,
  HOOK_EVENTS,
  HOOK_GROUP,
  HOOK_PATH,
  HOOK_TIMEOUTS_S,
  hookCommand,
  LAUNCH_MCP,
  LAUNCH_MCP_PATH,
  launcherBudgetMs,
  MCP_ENTRY,
  TOOL_MATCHER,
  VENDOR,
} from './templates.js';
