/**
 * `friday harness doctor antigravity` (plan M8b.3): read-only checks of the host, the files Friday
 * wrote, the launcher's answers with Friday down, and the level this gives. It never changes the
 * project, the daemon or Antigravity, and it starts no conversation: the only host command it runs
 * is `agy --version`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledHookSource, compareVersions } from '@friday/adapter-claude';
import { DaemonClient, type ProjectRef, readDiscovery, readInstallInfo, readToken } from '@friday/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  type AntigravityFound,
  type AntigravityInstall,
  BOM_SAFE,
  DOCUMENTED_VERSION,
  findAntigravity,
  HOOKS_MIN,
} from './detect.js';
import {
  type AntigravityLevel,
  FAILURE_EVIDENCE,
  type FailureEvidence,
  levelFromEvidence,
  levelReason,
} from './evidence.js';
import {
  HARNESS_DIR,
  HOOK_EVENTS,
  HOOK_GROUP,
  HOOK_TIMEOUTS_S,
  hookCommand,
  LAUNCH_MCP,
  launcherBudgetMs,
  MCP_ENTRY,
  TOOL_MATCHER,
} from './templates.js';

/** Same shape as the CLI's doctor results (the CLI renders them). */
export interface AntigravityCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fix?: string;
}

export interface AntigravityDoctorReport {
  checks: AntigravityCheck[];
  install: { cli: AntigravityInstall | null; app: AntigravityInstall | null };
  /** The L1 status the evidence supports once Friday's hooks reach the daemon (B21, ADR-0016). */
  hook_level: AntigravityLevel;
  /** What Friday achieves with Antigravity on this machine for this project. */
  achieved: 'L1 enforcing' | 'L1 degraded' | 'L1 unverified' | 'L0 observed' | 'not attached';
}

export interface AntigravityDoctorOptions {
  /** Skip starting the MCP server (tests, or `--quick`). */
  skipMcp?: boolean;
  /** Override detection (tests). */
  found?: AntigravityFound;
  /** Override the recorded failure behaviour (tests). */
  evidence?: FailureEvidence;
  env?: NodeJS.ProcessEnv;
}

const HOOK_VERSION_RE = /friday-hook-launcher-version: (\S+)/;
const CONFIG_FIX = 're-run "friday harness config antigravity"';
const BOM = '﻿';

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function parseObject(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

type Handler = { type?: unknown; command?: unknown; timeout?: unknown };

/** What is wrong with Friday's hook group, or null when it is exactly what Friday writes. */
export function hookGroupProblem(group: unknown): string | null {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return `no "${HOOK_GROUP}" hook group`;
  const g = group as Record<string, unknown>;
  if (g.enabled === false) return `the "${HOOK_GROUP}" hook group is disabled (enabled: false)`;
  for (const event of HOOK_EVENTS) {
    const entries = g[event];
    if (!Array.isArray(entries) || entries.length === 0) return `${event} is missing`;
    let handlers: Handler[];
    if (event === 'PreToolUse' || event === 'PostToolUse') {
      // Antigravity's hooks page names both "*" and "" as every tool; Friday writes "*".
      const ours = entries.find((e) => [TOOL_MATCHER, ''].includes((e as { matcher?: unknown })?.matcher as string)) as
        | { hooks?: unknown }
        | undefined;
      if (!ours) return `${event} does not match every tool (matcher "${TOOL_MATCHER}")`;
      handlers = Array.isArray(ours.hooks) ? (ours.hooks as Handler[]) : [];
    } else handlers = entries as Handler[];
    const h = handlers.find((x) => x?.command === hookCommand(event));
    if (!h) return `${event} does not run the launcher as "${hookCommand(event)}"`;
    if (h.type !== undefined && h.type !== 'command') return `${event} is not a command hook`;
    // The default is 30 s; a timeout at or below the launcher's budget would cut its answer off.
    const seconds = typeof h.timeout === 'number' ? h.timeout : 30;
    if (seconds * 1000 <= launcherBudgetMs(event))
      return `${event} times out after ${seconds} s, before the launcher's own answer (${launcherBudgetMs(event) / 1000} s); Friday writes ${HOOK_TIMEOUTS_S[event]} s`;
  }
  return null;
}

/** Runs the tracked launcher as Antigravity would, with no daemon reachable, and checks it fails safe. */
function simulateLauncher(hookFile: string, root: string): AntigravityCheck {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'friday-doctor-'));
  const decide = (toolCall: Record<string, unknown>): string => {
    const r = spawnSync(process.execPath, [hookFile, 'antigravity', 'PreToolUse'], {
      input: JSON.stringify({ conversationId: 'friday-doctor', workspacePaths: [root], toolCall, stepIdx: 0 }),
      env: { ...process.env, FRIDAY_STATE_DIR: empty },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    try {
      const out = JSON.parse(r.stdout || '{}') as { decision?: unknown };
      return typeof out.decision === 'string' ? out.decision : 'none';
    } catch {
      return 'unreadable';
    }
  };
  try {
    const got = [
      decide({ name: 'view_file', args: { AbsolutePath: path.join(root, '.friday', 'project.db') } }),
      decide({ name: 'write_to_file', args: { TargetFile: path.join(root, 'README.md') } }),
      decide({ name: 'run_command', args: { CommandLine: 'git status', Cwd: root } }),
    ];
    const ok = got[0] === 'deny' && got[1] === 'deny' && got[2] === 'force_ask';
    return ok
      ? {
          id: 'ag.failsafe',
          status: 'ok',
          message:
            'with Friday down the launcher denies .friday/project.db reads and edits, and has a human confirm shell commands (force_ask)',
        }
      : {
          id: 'ag.failsafe',
          status: 'fail',
          message: `launcher fail-safe decisions were read=${got[0]} edit=${got[1]} command=${got[2]} (expected deny, deny, force_ask)`,
          fix: CONFIG_FIX,
        };
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

/** Starts the MCP server the way Antigravity would, with no daemon reachable, and lists its tools. */
async function probeMcp(root: string, entry: string): Promise<AntigravityCheck> {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'friday-doctor-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((kv): kv is [string, string] => typeof kv[1] === 'string'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, ...HARNESS_DIR.split('/'), 'launch-mcp.mjs')],
    cwd: root,
    env: { ...env, ...MCP_ENTRY.env, FRIDAY_STATE_DIR: empty, FRIDAY_MCP_ENTRY: entry },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'friday-doctor', version: '0.1.0' });
  const started = Date.now();
  try {
    await client.connect(transport, { timeout: 10_000 });
    const names = (await client.listTools(undefined, { timeout: 10_000 })).tools.map((t) => t.name);
    return names.includes('friday_whoami') && names.includes('friday_claim_done')
      ? {
          id: 'ag.mcp',
          status: 'ok',
          message: `MCP server starts (${Date.now() - started} ms) and lists ${names.length} friday tools`,
        }
      : { id: 'ag.mcp', status: 'fail', message: `MCP server listed unexpected tools: ${names.join(', ')}` };
  } catch (e) {
    return {
      id: 'ag.mcp',
      status: 'fail',
      message: `MCP server did not start: ${(e as Error).message}`,
      fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
    };
  } finally {
    await client.close().catch(() => undefined);
    rmSync(empty, { recursive: true, force: true });
  }
}

function listFiles(dir: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), depth - 1) : [path.join(dir, e.name)],
  );
}

function hostCheck(found: AntigravityFound): AntigravityCheck[] {
  const { cli, app } = found;
  if (!cli && !app) {
    return [
      {
        id: 'ag.binary',
        status: 'warn',
        message: `Antigravity not found (looked at AGY_BIN, PATH, %LOCALAPPDATA%\\agy\\bin and the App's program folders${found.shim ? `; ${found.shim} is a shim Friday does not run` : ''})`,
        fix: 'install Antigravity (the CLI agy or the App), or set AGY_BIN to the agy executable',
      },
    ];
  }
  const checks: AntigravityCheck[] = [];
  if (cli) {
    const old = cli.version !== null && compareVersions(cli.version, HOOKS_MIN) < 0;
    const other = cli.version !== null && !cli.version.startsWith(`${DOCUMENTED_VERSION}.`);
    checks.push({
      id: 'ag.binary',
      status: old ? 'warn' : 'ok',
      message: `Antigravity CLI ${cli.version ?? '(version unknown)'} at ${cli.binary} (${cli.source})${
        old
          ? `: older than ${HOOKS_MIN}, whose workspace hooks load after a folder is trusted`
          : other
            ? `; Friday's hooks were written from the ${DOCUMENTED_VERSION} documentation`
            : ''
      }`,
      ...(old ? { fix: 'update Antigravity (agy updates itself; or reinstall it)' } : {}),
    });
  }
  if (app) {
    checks.push({
      id: cli ? 'ag.app' : 'ag.binary',
      status: 'ok',
      message: `Antigravity App ${app.version ?? '(version unknown)'} at ${app.binary}; it reads the same .agents files as the CLI`,
    });
  }
  return checks;
}

/** `friday harness doctor antigravity`. Read-only. */
export async function antigravityDoctor(
  ref: ProjectRef,
  opts: AntigravityDoctorOptions = {},
): Promise<AntigravityDoctorReport> {
  const env = opts.env ?? process.env;
  const root = ref.root;
  const checks: AntigravityCheck[] = [];
  const found = opts.found ?? findAntigravity(env);
  checks.push(...hostCheck(found));
  checks.push({
    id: 'ag.spawn',
    status: 'info',
    message:
      'no spawn mode: Antigravity\'s terms do not support running "agy -p" inside third-party software under consumer plans, so Friday attaches to the Antigravity you run yourself',
  });

  const harnessDir = path.join(root, ...HARNESS_DIR.split('/'));
  const hookFile = path.join(harnessDir, 'hook.mjs');
  const hookText = readText(hookFile);
  let hookOk = false;
  if (hookText === undefined) {
    checks.push({ id: 'ag.hook', status: 'fail', message: `${HARNESS_DIR}/hook.mjs is missing`, fix: CONFIG_FIX });
  } else {
    const have = HOOK_VERSION_RE.exec(hookText)?.[1];
    let bundled: string | undefined;
    try {
      bundled = bundledHookSource();
    } catch {
      bundled = undefined;
    }
    hookOk = Boolean(have);
    checks.push(
      !have
        ? { id: 'ag.hook', status: 'fail', message: 'hook.mjs has no Friday version header', fix: CONFIG_FIX }
        : !bundled || hookText === bundled
          ? {
              id: 'ag.hook',
              status: 'ok',
              message: `hook launcher ${have}${bundled ? ' (matches this Friday build)' : ''}`,
            }
          : {
              id: 'ag.hook',
              status: 'warn',
              message: `hook launcher ${have} differs from this Friday build (${HOOK_VERSION_RE.exec(bundled)?.[1] ?? '?'})`,
              fix: CONFIG_FIX,
            },
    );
  }
  const launch = path.join(harnessDir, 'launch-mcp.mjs');
  const launchText = readText(launch);
  checks.push(
    launchText === undefined
      ? { id: 'ag.launcher', status: 'fail', message: 'launch-mcp.mjs is missing', fix: CONFIG_FIX }
      : launchText === LAUNCH_MCP
        ? { id: 'ag.launcher', status: 'ok', message: 'MCP launcher is current' }
        : {
            id: 'ag.launcher',
            status: 'warn',
            message: 'launch-mcp.mjs differs from the current template',
            fix: CONFIG_FIX,
          },
  );

  const hooksText = readText(path.join(root, '.agents', 'hooks.json'));
  const hooksJson = parseObject(hooksText);
  const problem =
    hooksText === undefined
      ? '.agents/hooks.json is missing'
      : !hooksJson
        ? '.agents/hooks.json is not a JSON object'
        : hookGroupProblem(hooksJson[HOOK_GROUP]);
  const hooksOk = problem === null;
  const cliVersion = found.cli?.version ?? null;
  const bomRisk = hooksText?.startsWith(BOM) && (cliVersion === null || compareVersions(cliVersion, BOM_SAFE) < 0);
  checks.push(
    hooksOk
      ? bomRisk
        ? {
            id: 'ag.hooks',
            status: 'warn',
            message: `.agents/hooks.json starts with a byte-order mark, which Antigravity before ${BOM_SAFE} fails to load`,
            fix: 'save it as UTF-8 without a byte-order mark, or re-run "friday harness config antigravity"',
          }
        : {
            id: 'ag.hooks',
            status: 'ok',
            message: `the "${HOOK_GROUP}" group in .agents/hooks.json runs the launcher on ${HOOK_EVENTS.join(', ')}; PreToolUse matches every tool`,
          }
      : { id: 'ag.hooks', status: 'fail', message: problem, fix: CONFIG_FIX },
  );

  const mcpConfig = parseObject(readText(path.join(root, '.agents', 'mcp_config.json')));
  const entry = (mcpConfig?.mcpServers as Record<string, Record<string, unknown>> | undefined)?.friday;
  const mcpOk =
    entry?.command === MCP_ENTRY.command &&
    JSON.stringify(entry.args) === JSON.stringify(MCP_ENTRY.args) &&
    entry.disabled !== true;
  checks.push(
    mcpOk
      ? { id: 'ag.mcp-json', status: 'ok', message: '.agents/mcp_config.json registers the friday server with node' }
      : {
          id: 'ag.mcp-json',
          status: 'fail',
          message: !entry
            ? '.agents/mcp_config.json has no friday server'
            : entry.disabled === true
              ? 'the friday server is disabled in .agents/mcp_config.json'
              : 'the friday entry in .agents/mcp_config.json is not the expected node launcher',
          fix: CONFIG_FIX,
        },
  );

  const agentsMd = readText(path.join(root, 'AGENTS.md'));
  checks.push(
    agentsMd?.includes('<!-- friday:begin -->')
      ? { id: 'ag.agents-md', status: 'ok', message: "AGENTS.md carries Friday's guidance" }
      : { id: 'ag.agents-md', status: 'warn', message: 'AGENTS.md has no Friday block', fix: CONFIG_FIX },
  );

  const info = readInstallInfo(env);
  const mcpEntry = env.FRIDAY_MCP_ENTRY ?? info?.mcp_server_entry ?? undefined;
  const entryOk = Boolean(mcpEntry && existsSync(mcpEntry));
  checks.push(
    entryOk
      ? { id: 'ag.install', status: 'ok', message: `MCP server entry: ${mcpEntry}` }
      : {
          id: 'ag.install',
          status: 'fail',
          message: 'Friday is not set up on this machine (install.json has no MCP server entry)',
          fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
        },
  );

  // Secrets: the live tokens must not appear in any file Antigravity loads from the project.
  const live = [readToken(ref, 'operator', env), readToken(ref, 'bootstrap', env)].filter((t): t is string =>
    Boolean(t),
  );
  const files = [
    path.join(root, 'AGENTS.md'),
    ...listFiles(path.join(root, '.agents')),
    ...listFiles(harnessDir),
  ].filter((f) => existsSync(f) && statSync(f).isFile());
  const leaked = files.filter((f) => live.some((t) => readFileSync(f, 'utf8').includes(t)));
  checks.push(
    leaked.length
      ? {
          id: 'ag.secrets',
          status: 'fail',
          message: `Friday tokens found in ${leaked.map((f) => path.relative(root, f).replaceAll('\\', '/')).join(', ')}`,
          fix: 'delete those lines and run "friday token rotate"',
        }
      : { id: 'ag.secrets', status: 'ok', message: `no Friday tokens in ${files.length} file(s) Antigravity reads` },
  );

  const discovery = readDiscovery(ref, env);
  if (!discovery) {
    checks.push({
      id: 'ag.daemon',
      status: 'warn',
      message: 'daemon not running: edits are paused and commands need a human until it is',
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
        id: 'ag.daemon',
        status: 'ok',
        message: `daemon reachable at ${discovery.url} with the bootstrap token`,
      });
    } catch (e) {
      checks.push({
        id: 'ag.daemon',
        status: 'warn',
        message: `daemon did not answer: ${(e as Error).message}`,
        fix: 'restart with "friday run"',
      });
    }
  }

  if (hookOk) checks.push(simulateLauncher(hookFile, root));
  if (!opts.skipMcp && entryOk && mcpOk && launchText !== undefined)
    checks.push(await probeMcp(root, mcpEntry as string));

  checks.push({
    id: 'ag.trust',
    status: 'info',
    message:
      'Antigravity runs the hooks in .agents/hooks.json only in a folder it trusts; Friday cannot read that setting',
    fix: 'open this folder in Antigravity once and trust it when asked',
  });
  checks.push({
    id: 'ag.tools',
    status: 'info',
    message:
      'Antigravity asks before each friday tool call unless your own Antigravity settings allow mcp(friday/*); Friday does not change them',
  });

  const evidence = opts.evidence ?? FAILURE_EVIDENCE;
  const hookLevel = levelFromEvidence(evidence, cliVersion);
  checks.push({
    id: 'ag.level',
    status: hookLevel === 'enforcing' ? 'ok' : 'warn',
    message: `L1 ${hookLevel} once Friday's hooks reach the daemon: ${levelReason(evidence, cliVersion)}`,
    ...(hookLevel === 'enforcing'
      ? {}
      : { fix: 'see "The live check still to do" in docs/integration/antigravity.md' }),
  });

  const attached = hookOk && hooksOk && mcpOk;
  const achieved: AntigravityDoctorReport['achieved'] = attached
    ? `L1 ${hookLevel}`
    : mcpOk
      ? 'L0 observed'
      : 'not attached';
  return { checks, install: { cli: found.cli, app: found.app }, hook_level: hookLevel, achieved };
}
