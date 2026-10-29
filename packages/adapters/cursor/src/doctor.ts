/**
 * `friday harness doctor cursor` (plan M8b.2). Read-only: it never starts Cursor, never changes the
 * project or the daemon. It finds the IDE and the CLI, reads their versions from their folders,
 * checks Friday's files, runs the tracked launcher with Friday down to see it fail closed, and says
 * what Cursor also loads from Claude Code's files.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledHookSource, compareVersions, ROOT_PROGRAMS } from '@friday/adapter-claude';
import { DaemonClient, type ProjectRef, readDiscovery, readInstallInfo, readToken } from '@friday/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isFridayCursorHook, ruleIsOurs } from './config.js';
import { type CursorCli, type CursorIde, findCursorAgent, findCursorIde } from './detect.js';
import {
  CURSOR_HOOK_EVENTS,
  CURSOR_HOOK_TIMEOUTS,
  CURSOR_LAUNCH_MCP,
  CURSOR_MCP_ENTRY,
  CURSOR_PERMISSION_EVENTS,
} from './templates.js';

/** Same shape as the CLI's doctor results (the CLI renders them). */
export interface CursorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fix?: string;
}

export interface CursorDoctorReport {
  checks: CursorCheck[];
  ide: CursorIde | null;
  cli: CursorCli;
  /** What Friday reaches for this project in Cursor, from its files (plan B21); the daemon confirms it from each session's hooks. */
  achieved: 'L1 enforcing' | 'L1 unverified' | 'L1 degraded' | 'L0 observed' | 'not attached';
}

export interface CursorDoctorOptions {
  /** Skip starting the MCP server (tests, or `--quick`). */
  skipMcp?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Override detection (tests). */
  ide?: CursorIde | null;
  cli?: CursorCli;
}

/** The versions Friday's adapter was written against (Cursor's documentation, read 2026-10-18). */
export const DOCUMENTED_IDE = '3.24';
export const DOCUMENTED_CLI = '2026.10.16';
/** `preToolUse`, the hook before every agent tool, arrived in 2.4. */
export const PRE_TOOL_USE_MIN = '2.4';
/** 3.23 fixed hook commands on Windows that name a script without an extension. */
export const WINDOWS_HOOK_FIX = '3.23';
/**
 * The first versions whose documentation describes `failClosed` on a permission hook: the ones it
 * was read for. When Cursor added the key is not documented, so on an older Cursor a failing hook
 * may let the call through: its level stays unverified until the live check finds an earlier one.
 */
export const FAIL_CLOSED_IDE = DOCUMENTED_IDE;
export const FAIL_CLOSED_CLI = DOCUMENTED_CLI;

const HOOK_VERSION_RE = /friday-hook-launcher-version: (\S+)/;
const CONFIG_FIX = 're-run "friday harness config cursor"';

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function listFiles(dir: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), depth - 1) : [path.join(dir, e.name)],
  );
}

/** What Friday's entries in `.cursor/hooks.json` give: every event present, each failing closed and waiting long enough. */
export function inspectCursorHooks(file: Record<string, unknown> | undefined): {
  missing: string[];
  notFailClosed: string[];
  shortTimeout: string[];
} {
  const hooks = (file?.hooks ?? {}) as Record<string, unknown[]>;
  const missing: string[] = [];
  const notFailClosed: string[] = [];
  const shortTimeout: string[] = [];
  for (const event of CURSOR_HOOK_EVENTS) {
    const ours = (Array.isArray(hooks[event]) ? hooks[event] : []).filter(isFridayCursorHook) as {
      failClosed?: unknown;
      timeout?: unknown;
    }[];
    if (!ours.length) {
      missing.push(event);
      continue;
    }
    if (ours.some((h) => h.failClosed !== true)) notFailClosed.push(event);
    if (ours.some((h) => typeof h.timeout !== 'number' || h.timeout < CURSOR_HOOK_TIMEOUTS[event]))
      shortTimeout.push(event);
  }
  return { missing, notFailClosed, shortTimeout };
}

/**
 * Runs the tracked launcher as Cursor would, with no daemon reachable, and checks it fails closed
 * (plan M1.10): a read of Friday's database and an edit are refused, a shell command asks.
 */
function simulateLauncher(hookFile: string, root: string): CursorCheck {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'friday-doctor-'));
  const common = {
    conversation_id: 'friday-doctor',
    cursor_version: DOCUMENTED_IDE,
    workspace_roots: [root],
  };
  const run = (event: string, input: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, [hookFile, 'cursor', event], {
      input: JSON.stringify({ ...common, hook_event_name: event, ...input }),
      env: { ...process.env, CURSOR_PROJECT_DIR: root, FRIDAY_STATE_DIR: empty },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    let permission = 'none';
    try {
      permission = String((JSON.parse(r.stdout || '{}') as { permission?: unknown }).permission ?? 'none');
    } catch {
      permission = 'unreadable';
    }
    return `${permission}/${r.status}`;
  };
  try {
    const got = [
      run('beforeReadFile', { file_path: path.join(root, '.friday', 'project.db') }),
      run('preToolUse', {
        tool_name: 'Write',
        tool_input: { path: path.join(root, 'README.md'), fileText: 'x' },
        cwd: root,
      }),
      run('beforeShellExecution', { command: 'git status', cwd: root }),
    ];
    const want = ['deny/2', 'deny/2', 'ask/0'];
    return got.every((g, i) => g === want[i])
      ? {
          id: 'cursor.failsafe',
          status: 'ok',
          message:
            'with Friday down the launcher refuses reads of .friday/project.db and edits, and asks for shell commands',
        }
      : {
          id: 'cursor.failsafe',
          status: 'fail',
          message: `launcher answers with Friday down were ${got.join(', ')} (expected ${want.join(', ')})`,
          fix: CONFIG_FIX,
        };
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

/** Starts the MCP server the way Cursor would, with no daemon reachable, and lists its tools. */
async function probeMcp(root: string, entry: string): Promise<CursorCheck> {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'friday-doctor-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((kv): kv is [string, string] => typeof kv[1] === 'string'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, '.friday', 'harness', 'cursor', 'launch-mcp.mjs')],
    cwd: root,
    env: {
      ...env,
      ...CURSOR_MCP_ENTRY.env,
      FRIDAY_PROJECT_DIR: root,
      FRIDAY_STATE_DIR: empty,
      FRIDAY_MCP_ENTRY: entry,
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'friday-doctor', version: '0.1.0' });
  const started = Date.now();
  try {
    await client.connect(transport, { timeout: 10_000 });
    const names = (await client.listTools(undefined, { timeout: 10_000 })).tools.map((t) => t.name);
    return names.includes('friday_whoami') && names.includes('friday_claim_done')
      ? {
          id: 'cursor.mcp',
          status: 'ok',
          message: `MCP server starts (${Date.now() - started} ms) and lists ${names.length} friday tools`,
        }
      : { id: 'cursor.mcp', status: 'fail', message: `MCP server listed unexpected tools: ${names.join(', ')}` };
  } catch (e) {
    return {
      id: 'cursor.mcp',
      status: 'fail',
      message: `MCP server did not start: ${(e as Error).message}`,
      fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
    };
  } finally {
    await client.close().catch(() => undefined);
    rmSync(empty, { recursive: true, force: true });
  }
}

/** Whether a version written `3.24` or `3.24.1` is at least `min`. */
const atLeast = (version: string | null, min: string): boolean | null =>
  version && /^\d+\.\d+/.test(version) ? compareVersions(version, min) >= 0 : null;

export async function cursorDoctor(ref: ProjectRef, opts: CursorDoctorOptions = {}): Promise<CursorDoctorReport> {
  const env = opts.env ?? process.env;
  const root = ref.root;
  const checks: CursorCheck[] = [];
  checks.push({
    id: 'cursor.status',
    status: 'info',
    message: `experimental: written from Cursor's documentation (IDE ${DOCUMENTED_IDE}, CLI ${DOCUMENTED_CLI}) and tested against a scripted host; it becomes supported once the live check in docs/integration/cursor.md passes with your own login`,
  });

  // ---- the host -------------------------------------------------------------------------------
  const ide = opts.ide !== undefined ? opts.ide : findCursorIde(env);
  const cli = opts.cli ?? findCursorAgent(env);
  if (ide) {
    const pre = atLeast(ide.version, PRE_TOOL_USE_MIN);
    checks.push(
      pre === false
        ? {
            id: 'cursor.ide',
            status: 'fail',
            message: `Cursor ${ide.version} (${ide.dir}) has no preToolUse hook, so Friday's hooks would not see every tool`,
            fix: `update Cursor to ${PRE_TOOL_USE_MIN} or newer`,
          }
        : {
            id: 'cursor.ide',
            status: 'ok',
            message: `Cursor ${ide.version ?? '(version unknown)'} in ${ide.dir}${ide.version_source ? ` (read from ${path.basename(path.dirname(ide.version_source))}/${path.basename(ide.version_source)})` : ''}`,
          },
    );
    if (process.platform === 'win32' && atLeast(ide.version, WINDOWS_HOOK_FIX) === false) {
      checks.push({
        id: 'cursor.windows',
        status: 'warn',
        message: `Cursor before ${WINDOWS_HOOK_FIX} on Windows could start a hook command without its input and report success`,
        fix: `update Cursor to ${WINDOWS_HOOK_FIX} or newer`,
      });
    }
  }
  if (cli.binary || cli.versions.length) {
    checks.push({
      id: 'cursor.cli',
      status: cli.binary ? 'ok' : 'warn',
      message: cli.binary
        ? `Cursor CLI ${cli.version ?? '(version unknown)'}: ${cli.binary}`
        : (cli.problem ?? 'the Cursor CLI cannot be started'),
      ...(cli.binary ? {} : { fix: 'set CURSOR_AGENT_BIN to the agent executable' }),
    });
  }
  if (!ide && !cli.binary && !cli.versions.length) {
    checks.push({
      id: 'cursor.host',
      status: 'warn',
      message: 'Cursor was not found on this machine (the per-user IDE, or the CLI on PATH or in its install folder)',
      fix: 'install Cursor or its CLI, or set CURSOR_AGENT_BIN',
    });
  }
  checks.push({
    id: 'cursor.spawn',
    status: 'info',
    message: cli.binary
      ? "spawn mode available: friday harness run cursor drives this CLI headless (agent -p) for each run attempt, with Friday's hooks"
      : `spawn mode needs the CLI's executable: ${cli.problem ?? 'not found'}`,
  });

  // ---- Friday's files ---------------------------------------------------------------------------
  const harnessDir = path.join(root, '.friday', 'harness', 'cursor');
  const hookFile = path.join(harnessDir, 'hook.mjs');
  let hookOk = false;
  if (!existsSync(hookFile)) {
    checks.push({
      id: 'cursor.hook',
      status: 'fail',
      message: '.friday/harness/cursor/hook.mjs is missing',
      fix: CONFIG_FIX,
    });
  } else {
    const text = readFileSync(hookFile, 'utf8');
    const have = HOOK_VERSION_RE.exec(text)?.[1];
    let bundled: string | undefined;
    try {
      bundled = bundledHookSource();
    } catch {
      bundled = undefined;
    }
    hookOk = Boolean(have);
    checks.push(
      !have
        ? { id: 'cursor.hook', status: 'fail', message: 'hook.mjs has no Friday version header', fix: CONFIG_FIX }
        : !bundled || text === bundled
          ? {
              id: 'cursor.hook',
              status: 'ok',
              message: `hook launcher ${have}${bundled ? ' (matches this Friday build)' : ''}`,
            }
          : {
              id: 'cursor.hook',
              status: 'warn',
              message: `hook launcher ${have} differs from this Friday build (${HOOK_VERSION_RE.exec(bundled)?.[1] ?? '?'})`,
              fix: CONFIG_FIX,
            },
    );
  }
  const launch = path.join(harnessDir, 'launch-mcp.mjs');
  checks.push(
    !existsSync(launch)
      ? { id: 'cursor.launcher', status: 'fail', message: 'launch-mcp.mjs is missing', fix: CONFIG_FIX }
      : readFileSync(launch, 'utf8') === CURSOR_LAUNCH_MCP
        ? { id: 'cursor.launcher', status: 'ok', message: 'MCP launcher is current' }
        : {
            id: 'cursor.launcher',
            status: 'warn',
            message: 'launch-mcp.mjs differs from the current template',
            fix: CONFIG_FIX,
          },
  );

  const hooksFile = readJson(path.join(root, '.cursor', 'hooks.json'));
  const inspected = inspectCursorHooks(hooksFile);
  const configured = inspected.missing.length < CURSOR_HOOK_EVENTS.length;
  const complete = configured && inspected.missing.length === 0;
  const permission: readonly string[] = CURSOR_PERMISSION_EVENTS;
  const failClosed = complete && !inspected.notFailClosed.some((e) => permission.includes(e));
  checks.push(
    !configured
      ? {
          id: 'cursor.hooks',
          status: 'fail',
          message: "Friday's hooks are missing from .cursor/hooks.json",
          fix: CONFIG_FIX,
        }
      : !complete
        ? {
            id: 'cursor.hooks',
            status: 'fail',
            message: `.cursor/hooks.json lacks Friday's hooks for ${inspected.missing.join(', ')}${inspected.missing.some((e) => e === 'beforeShellExecution' || e === 'beforeMCPExecution') ? ': preToolUse leaves shell and MCP calls to those hooks, so they would go unjudged' : ''}`,
            fix: CONFIG_FIX,
          }
        : inspected.notFailClosed.length || inspected.shortTimeout.length
          ? {
              id: 'cursor.hooks',
              status: failClosed ? 'warn' : 'fail',
              message: [
                inspected.notFailClosed.length
                  ? `${inspected.notFailClosed.join(', ')} ${inspected.notFailClosed.length === 1 ? 'does' : 'do'} not set failClosed, so a hook that fails lets the call through`
                  : '',
                inspected.shortTimeout.length
                  ? `${inspected.shortTimeout.join(', ')} ${inspected.shortTimeout.length === 1 ? 'waits' : 'wait'} less than the launcher needs`
                  : '',
              ]
                .filter(Boolean)
                .join('; '),
              fix: CONFIG_FIX,
            }
          : {
              id: 'cursor.hooks',
              status: 'ok',
              message: `${CURSOR_HOOK_EVENTS.length} hook events in .cursor/hooks.json, each failing closed; preToolUse sees every agent tool, the shell and MCP hooks can ask a human`,
            },
  );
  checks.push({
    id: 'cursor.trust',
    status: 'info',
    message:
      'Cursor runs .cursor/hooks.json only in a trusted workspace: trust this folder when Cursor asks. Headless CLI runs need --trust, which spawn mode passes',
  });

  const mcp = readJson(path.join(root, '.cursor', 'mcp.json'));
  const entry = (mcp?.mcpServers as Record<string, unknown> | undefined)?.friday;
  const mcpOk = JSON.stringify(entry) === JSON.stringify(CURSOR_MCP_ENTRY);
  checks.push(
    mcpOk
      ? { id: 'cursor.mcp-json', status: 'ok', message: '.cursor/mcp.json registers the friday server with node' }
      : {
          id: 'cursor.mcp-json',
          status: 'fail',
          message: entry
            ? '.cursor/mcp.json friday entry is not the expected node launcher'
            : '.cursor/mcp.json has no friday server',
          fix: CONFIG_FIX,
        },
  );
  checks.push({
    id: 'cursor.mcp-approval',
    status: 'info',
    message:
      'Cursor asks once before it uses a project MCP server; approve "friday" (the CLI: agent mcp enable friday, or --approve-mcps)',
  });

  const rule = path.join(root, '.cursor', 'rules', 'friday.mdc');
  const ruleText = existsSync(rule) ? readFileSync(rule, 'utf8') : null;
  checks.push(
    ruleText !== null && ruleIsOurs(ruleText) && /^alwaysApply: true$/m.test(ruleText)
      ? {
          id: 'cursor.rule',
          status: 'ok',
          message: "Friday's rule .cursor/rules/friday.mdc is applied to every request",
        }
      : ruleText !== null
        ? {
            id: 'cursor.rule',
            status: 'warn',
            message: '.cursor/rules/friday.mdc is not the rule Friday writes; Friday leaves it alone',
          }
        : {
            id: 'cursor.rule',
            status: 'warn',
            message: "Friday's rule .cursor/rules/friday.mdc is missing",
            fix: CONFIG_FIX,
          },
  );

  // ---- what Cursor also loads from Claude Code's files ----------------------------------------------
  const claudeHooks = ['settings.json', 'settings.local.json'].some((f) => {
    const file = path.join(root, '.claude', f);
    return (
      existsSync(file) &&
      readFileSync(file, 'utf8').replaceAll('\\', '/').includes('.friday/harness/claude-code/hook.mjs')
    );
  });
  checks.push({
    id: 'cursor.claude-import',
    status: 'info',
    message: !claudeHooks
      ? "Cursor also runs Claude Code's hooks from .claude/settings.json by default (its third-party import); this project has none of Friday's there"
      : configured
        ? "Cursor also runs Claude Code's hooks from .claude/settings.json (its third-party import, on by default). With Friday's hooks in .cursor/hooks.json, Friday's launcher answers nothing on that path, so each call is judged once, by Cursor's own hooks. Cursor also loads .claude/skills/friday and, in the CLI, CLAUDE.md: Friday's guidance twice. To keep them out, turn off \"Include Third-Party Plugins, Skills, and Other Configs\" in Cursor's settings"
        : "Cursor also runs Claude Code's hooks from .claude/settings.json (its third-party import, on by default). Without Friday's hooks in .cursor/hooks.json, Friday applies only its protected-file rules on that path: no task scope, nothing recorded. Run friday harness config cursor",
  });

  // ---- this machine -----------------------------------------------------------------------------------
  const info = readInstallInfo(env);
  const mcpEntry = env.FRIDAY_MCP_ENTRY ?? info?.mcp_server_entry ?? undefined;
  const entryOk = Boolean(mcpEntry && existsSync(mcpEntry));
  checks.push(
    entryOk
      ? { id: 'cursor.install', status: 'ok', message: `MCP server entry: ${mcpEntry}` }
      : {
          id: 'cursor.install',
          status: 'fail',
          message: 'Friday is not set up on this machine (install.json has no MCP server entry)',
          fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
        },
  );

  // Secrets: the live tokens must not appear in any file Cursor can read in the project.
  const live = [readToken(ref, 'operator', env), readToken(ref, 'bootstrap', env)].filter((t): t is string =>
    Boolean(t),
  );
  const files = [...listFiles(path.join(root, '.cursor')), ...listFiles(harnessDir)].filter(
    (f) => existsSync(f) && statSync(f).isFile(),
  );
  const leaked = files.filter((f) => live.some((t) => readFileSync(f, 'utf8').includes(t)));
  checks.push(
    leaked.length
      ? {
          id: 'cursor.secrets',
          status: 'fail',
          message: `Friday tokens found in ${leaked.map((f) => path.relative(root, f)).join(', ')}`,
          fix: 'delete those lines and run "friday token rotate"',
        }
      : { id: 'cursor.secrets', status: 'ok', message: `no Friday tokens in ${files.length} Cursor-readable file(s)` },
  );

  const discovery = readDiscovery(ref, env);
  if (!discovery) {
    checks.push({
      id: 'cursor.daemon',
      status: 'warn',
      message: 'daemon not running: edits are refused and commands need confirmation until it is',
      fix: 'run "friday run"',
    });
  } else {
    try {
      const client = new DaemonClient({
        baseUrl: discovery.url,
        token: readToken(ref, 'bootstrap', env) ?? '',
        tokenClass: 'bootstrap',
        projectId: ref.project_id,
        timeoutMs: 2000,
        clientName: 'friday-doctor',
      });
      await client.get('/health');
      checks.push({
        id: 'cursor.daemon',
        status: 'ok',
        message: `daemon reachable at ${discovery.url} with the bootstrap token`,
      });
    } catch (e) {
      checks.push({
        id: 'cursor.daemon',
        status: 'warn',
        message: `daemon did not answer: ${(e as Error).message}`,
        fix: 'restart with "friday run"',
      });
    }
  }

  if (hookOk) checks.push(simulateLauncher(hookFile, root));
  if (!opts.skipMcp && entryOk && mcpOk && existsSync(launch)) checks.push(await probeMcp(root, mcpEntry as string));

  // A program named `node` or `git` at the root would run instead of the real one wherever Cursor's
  // shell looks in the current folder first (cmd.exe), and answer for Friday's hooks.
  const planted = ROOT_PROGRAMS.filter((f) => existsSync(path.join(root, f)));
  checks.push(
    planted.length
      ? {
          id: 'cursor.root-programs',
          status: 'fail',
          message: `${planted.join(', ')} at the project root could run instead of ${[...new Set(planted.map((f) => f.split('.')[0]))].join(' and ')} for Cursor's hooks, which start it by its bare name from the root`,
          fix: 'remove or rename the file (agents may not create one there: Friday protects these names)',
        }
      : { id: 'cursor.root-programs', status: 'ok', message: 'no program named node or git at the project root' },
  );

  // Which Cursor runs the hooks: the IDE where it is installed, else the CLI.
  const documented = ide
    ? atLeast(ide.version, FAIL_CLOSED_IDE)
    : cli.binary
      ? atLeast(cli.version, FAIL_CLOSED_CLI)
      : null;
  const which = ide
    ? `Cursor ${ide.version ?? '(version unknown)'}`
    : cli.binary
      ? `Cursor CLI ${cli.version ?? '(version unknown)'}`
      : 'a Cursor this doctor did not find';
  const attached = hookOk && complete && mcpOk && !planted.length;
  const achieved: CursorDoctorReport['achieved'] = !attached
    ? mcpOk
      ? 'L0 observed'
      : 'not attached'
    : !failClosed
      ? 'L1 degraded'
      : documented === true
        ? 'L1 enforcing'
        : 'L1 unverified';
  checks.push({
    id: 'cursor.level',
    status: 'info',
    message:
      achieved === 'L1 enforcing'
        ? `L1 enforcing once a Cursor session's hooks reach Friday: the permission hooks fail closed, and ${which} is one whose documentation describes failClosed, so a hook that fails blocks the call`
        : achieved === 'L1 unverified'
          ? `L1 unverified once a session's hooks reach Friday: failClosed is documented from Cursor ${FAIL_CLOSED_IDE} (CLI ${FAIL_CLOSED_CLI}), and whether ${which} honours it is not known`
          : achieved === 'L1 degraded'
            ? "L1 degraded once a session's hooks reach Friday: a permission hook without failClosed lets the call through when it fails"
            : achieved === 'L0 observed'
              ? "L0: Friday's tools only, nothing of Cursor's is judged"
              : 'not attached: run friday harness config cursor',
  });
  return { checks, ide, cli, achieved };
}
