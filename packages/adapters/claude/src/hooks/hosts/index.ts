/**
 * The host modules the hook launcher loads (plan M8b.1): one per vendor, each turning its host's
 * hook input into Friday's one shape and Friday's judgment back into the host's reply.
 */
import { type HookVendor, type HostModule, isHookVendor } from '../types.js';
import { antigravity } from './antigravity.js';
import { claudeCode } from './claude-code.js';
import { cursor } from './cursor.js';
import { gemini } from './gemini.js';

export const HOST_MODULES: Record<HookVendor, HostModule> = {
  'claude-code': claudeCode,
  cursor,
  antigravity,
  gemini,
};

export const hostModule = (vendor: HookVendor): HostModule => HOST_MODULES[vendor];

/**
 * The launcher's arguments: `<vendor> <event>`, or Claude Code's `<Event>` alone, as every
 * `.claude/settings.json` Friday has written runs it (B9). A first argument that is not a vendor
 * is Claude Code's event, so those settings keep working unchanged.
 */
export function launcherArgs(argv: readonly string[]): { vendor: HookVendor; event: string } {
  const first = argv[2];
  if (isHookVendor(first)) return { vendor: first, event: argv[3] ?? '' };
  return { vendor: 'claude-code', event: first ?? 'unknown' };
}

/**
 * Cursor also runs Claude Code's hooks from `.claude/settings.json` (its third-party import, on by
 * default), with Cursor-shaped input. Where the project's `.cursor/hooks.json` runs Friday's
 * launcher, those hooks judge the call, so the Claude Code launcher answers nothing and records
 * nothing: each call is judged once. Where it does not, the launcher applies its own rules to the
 * call (`importedCursorCall`).
 *
 * Both the environment and the input must say Cursor: a real Claude Code session started from a
 * terminal inside Cursor may inherit Cursor's variables, and its calls must still be judged.
 */
export function importedByCursor(env: NodeJS.ProcessEnv, raw: Record<string, unknown>): boolean {
  const envSaysCursor = Boolean(env.CURSOR_VERSION || env.CURSOR_PROJECT_DIR);
  const inputSaysCursor = typeof raw.cursor_version === 'string' || typeof raw.conversation_id === 'string';
  return envSaysCursor && inputSaysCursor;
}

export { ANTIGRAVITY_NO_DECISION } from './antigravity.js';
export { claudeHookOutput } from './claude-code.js';
export { type FailureContext, failureJudgment, wireHook, wireHost, withoutAsk } from './common.js';
export {
  CURSOR_LAUNCHER_FILE,
  CURSOR_NO_DECISION,
  CURSOR_PERMISSION_HOOKS,
  cursorHookFailure,
  cursorRunsFriday,
  importedCursorCall,
  runsFridayLauncher,
} from './cursor.js';
export { webFetchUrls } from './gemini.js';
