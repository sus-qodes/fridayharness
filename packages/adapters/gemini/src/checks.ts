/**
 * What the doctor and the spawn adapter both read before trusting Friday's hooks to run: the
 * project's `.gemini/settings.json` and launcher, and the settings layers that can switch hooks off.
 * Read only: nothing of the user's or the project's is changed.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettings } from './config.js';
import {
  GEMINI_HOOK_EVENTS,
  GEMINI_HOOK_FILE,
  GEMINI_HOOK_NAME,
  GEMINI_MCP_ENTRY,
  geminiHookCommand,
} from './templates.js';

export const LAUNCHER_HEADER = /friday-hook-launcher-version: (\S+)/;

type HookDef = { type?: unknown; command?: unknown; name?: unknown; timeout?: unknown };
type HookGroup = { matcher?: unknown; hooks?: HookDef[] };

export interface ProjectHooks {
  /** `.gemini/settings.json` read (with comments allowed), or null when it is missing or not JSON. */
  settings: Record<string, unknown> | null;
  /** Why it could not be read. */
  settingsError: string | null;
  /** The Gemini CLI events whose Friday hook is missing or not what Friday writes. */
  missing: string[];
  /** Hooks on `BeforeTool` that are not Friday's: each may rewrite a call after Friday judged it. */
  otherBeforeTool: string[];
  /** The `friday` server is the one Friday writes. */
  mcpOk: boolean;
  /** The launcher's version header, or null when the file is missing or has none. */
  launcherVersion: string | null;
}

const groups = (settings: Record<string, unknown> | null, event: string): HookGroup[] => {
  const v = (settings?.hooks as Record<string, unknown> | undefined)?.[event];
  return Array.isArray(v) ? (v as HookGroup[]) : [];
};

/** Reads a project folder's Gemini CLI configuration as Friday wrote it (the doctor; a spawned session's worktree). */
export function readProjectHooks(dir: string): ProjectHooks {
  const file = path.join(dir, '.gemini', 'settings.json');
  let settings: Record<string, unknown> | null = null;
  let settingsError: string | null = null;
  if (!existsSync(file)) settingsError = '.gemini/settings.json is missing';
  else {
    try {
      settings = readSettings(readFileSync(file, 'utf8'), '.gemini/settings.json').value;
    } catch (e) {
      settingsError = (e as Error).message;
    }
  }
  const missing = GEMINI_HOOK_EVENTS.filter((e) => {
    const want = geminiHookCommand(e.event);
    return !groups(settings, e.event).some(
      (g) =>
        ('matcher' in e ? g.matcher === e.matcher : true) &&
        (g.hooks ?? []).some((h) => h?.command === want && (typeof h.timeout !== 'number' || h.timeout >= e.timeout)),
    );
  }).map((e) => e.event);
  const otherBeforeTool = groups(settings, 'BeforeTool')
    .flatMap((g) => g.hooks ?? [])
    .filter((h) => !(typeof h?.command === 'string' && h.command.replaceAll('\\', '/').includes(GEMINI_HOOK_FILE)))
    .map((h) => String(h?.name ?? h?.command ?? '?'));
  const server = (settings?.mcpServers as Record<string, { command?: unknown; args?: unknown }> | undefined)?.friday;
  const mcpOk =
    server?.command === GEMINI_MCP_ENTRY.command &&
    JSON.stringify(server.args) === JSON.stringify(GEMINI_MCP_ENTRY.args);
  const hookFile = path.join(dir, ...GEMINI_HOOK_FILE.split('/'));
  let launcherVersion: string | null = null;
  if (existsSync(hookFile)) {
    try {
      launcherVersion = LAUNCHER_HEADER.exec(readFileSync(hookFile, 'utf8').slice(0, 400))?.[1] ?? null;
    } catch {
      launcherVersion = null;
    }
  }
  return { settings, settingsError, missing, otherBeforeTool, mcpOk, launcherVersion };
}

/** Gemini CLI's user settings file, as it finds it (`GEMINI_CLI_HOME` moves the home folder). */
export function userSettingsPath(env: NodeJS.ProcessEnv): string {
  return path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'settings.json');
}

/** Gemini CLI's system settings file, which overrides the others (`GEMINI_CLI_SYSTEM_SETTINGS_PATH` moves it). */
export function systemSettingsPath(env: NodeJS.ProcessEnv): string {
  if (env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (process.platform === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  if (process.platform === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
  return '/etc/gemini-cli/settings.json';
}

/** Gemini CLI's system defaults, beside the system settings unless `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` moves them. */
export function systemDefaultsPath(env: NodeJS.ProcessEnv): string {
  if (env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH) return env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
  const settings = systemSettingsPath(env);
  return path.join(path.dirname(settings), 'system-defaults.json');
}

/**
 * Why Friday's hooks would not run, from the settings layers that can switch them off: hooks
 * disabled as a whole (`hooksConfig.enabled: false`), or Friday's by name or command
 * (`hooksConfig.disabled`). Empty when nothing says so. A layer that cannot be read says nothing.
 */
export function hooksSwitchedOff(dir: string, env: NodeJS.ProcessEnv): string[] {
  const why: string[] = [];
  const layers: [string, string][] = [
    ['the system settings', systemSettingsPath(env)],
    ['your user settings', userSettingsPath(env)],
    ["the project's .gemini/settings.json", path.join(dir, '.gemini', 'settings.json')],
  ];
  const ours = new Set<string>([GEMINI_HOOK_NAME, ...GEMINI_HOOK_EVENTS.map((e) => geminiHookCommand(e.event))]);
  for (const [label, file] of layers) {
    let value: Record<string, unknown>;
    try {
      if (!existsSync(file)) continue;
      value = readSettings(readFileSync(file, 'utf8'), file).value;
    } catch {
      continue;
    }
    const cfg = (value.hooksConfig ?? {}) as { enabled?: unknown; disabled?: unknown };
    if (cfg.enabled === false) why.push(`${label} switch hooks off (hooksConfig.enabled: false)`);
    const disabled = Array.isArray(cfg.disabled) ? cfg.disabled.filter((x): x is string => typeof x === 'string') : [];
    const hit = disabled.filter((d) => ours.has(d));
    if (hit.length) why.push(`${label} disable Friday's hooks (hooksConfig.disabled: ${hit.join(', ')})`);
  }
  return why;
}
