/**
 * @friday/adapter-gemini (experimental)
 * Gemini CLI for Friday (plan M8b.4): the project's hooks and `friday` server in
 * `.gemini/settings.json` with a `GEMINI.md` block, its doctor, and spawn mode, which drives the
 * installed Gemini CLI headless with Friday's hooks and its tools for spawned agents for each run
 * attempt (ADR-0032). Level L1 degraded: a failing hook lets the call through, and no Gemini CLI
 * version can change that.
 */
export const PACKAGE_NAME = '@friday/adapter-gemini';

export {
  FRIDAY_SERVER,
  finalFrom,
  GEMINI_SPAWN_RULES,
  GeminiSpawnAdapter,
  type GeminiSpawnOptions,
  geminiAttemptUsage,
  geminiHostUsage,
  geminiSpawnRules,
  MAX_FOLLOWUPS,
  MAX_PROMPT_CHARS,
  systemSettingsFor,
  worktreeProblem,
} from './adapter.js';
export {
  hooksSwitchedOff,
  type ProjectHooks,
  readProjectHooks,
  systemDefaultsPath,
  systemSettingsPath,
  userSettingsPath,
} from './checks.js';
export {
  type GeminiCliParts,
  type GeminiGlobals,
  geminiConfigCommand,
  geminiDoctorCommand,
  geminiRunCommand,
} from './cli.js';
export {
  applyGeminiPlan,
  type GeminiConfigOptions,
  isFridayGeminiEntry,
  mergeGeminiMd,
  mergeGeminiSettings,
  planGemini,
  readSettings,
  stripJsonComments,
} from './config.js';
export {
  compareVersions,
  findGemini,
  type GeminiInstall,
  geminiEnvironment,
  geminiLoginHints,
  MIN_VERSION,
  RECORDED_VERSION,
} from './detect.js';
export {
  ACCOUNT_NOTE,
  type GeminiCheck,
  type GeminiDoctorOptions,
  type GeminiDoctorReport,
  geminiDoctor,
  LEVEL_NOTE,
} from './doctor.js';
export { type HookRun, type HookShell, hookShell, hostCommandLine, hostQuote, runHookCommand } from './shell.js';
export {
  GEMINI_HARNESS_DIR,
  GEMINI_HARNESS_README,
  GEMINI_HOOK_EVENTS,
  GEMINI_HOOK_FILE,
  GEMINI_HOOK_NAME,
  GEMINI_LAUNCH_MCP,
  GEMINI_LAUNCH_MCP_FILE,
  GEMINI_MCP_ENTRY,
  GEMINI_MD_BLOCK,
  geminiHookCommand,
  geminiHooks,
  SPAWN_DENIED_TOOLS,
  spawnPolicyToml,
} from './templates.js';
