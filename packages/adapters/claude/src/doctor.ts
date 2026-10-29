import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonClient, type ProjectRef, readDiscovery, readInstallInfo, readToken } from '@friday/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bundledHookSource } from './config/claude-code.js';
import { fridayHooks, LAUNCH_MCP, MCP_ENTRY } from './config/templates.js';
import { type ClaudeInstall, detectClaudeCode, ENFORCING_MIN, type HookLevel, hookLevel } from './detect.js';
import { PRE_TOOL_MATCHER } from './hooks/types.js';

/** Same shape as the CLI's doctor results (the CLI renders them). */
export interface ClaudeCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fix?: string;
}

export interface ClaudeDoctorReport {
  checks: ClaudeCheck[];
  install: ClaudeInstall | null;
  hook_level: HookLevel;
  /** What Friday achieves on this machine for this project (plan B21). */
  achieved: 'L1 enforcing' | 'L1 degraded' | 'L0 observed' | 'not attached';
}

export interface ClaudeDoctorOptions {
  /** Skip spawning the MCP server (tests, or `--quick`). */
  skipMcp?: boolean;
  /** Override Claude Code detection (tests). */
  install?: ClaudeInstall | null;
  env?: NodeJS.ProcessEnv;
}

const HOOK_VERSION_RE = /friday-hook-launcher-version: (\S+)/;
const CONFIG_FIX = 're-run "friday harness config claude-code"';

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Whether the user accepted Claude Code's trust prompt for `root` or a folder above it, read from Claude Code's
 * per-user state (`$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`). Read only; undefined when unknown.
 */
export function workspaceTrusted(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): { trusted: boolean; via?: string } | undefined {
  const file = env.CLAUDE_CONFIG_DIR
    ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  const projects = readJson(file)?.projects as Record<string, { hasTrustDialogAccepted?: unknown }> | undefined;
  if (!projects || typeof projects !== 'object') return undefined;
  const norm = (p: string) => {
    const s = path.resolve(p).replaceAll('\\', '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? s.toLowerCase() : s;
  };
  const trusted = new Map<string, string>();
  for (const [key, value] of Object.entries(projects))
    if (value?.hasTrustDialogAccepted === true) trusted.set(norm(key), key);
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const hit = trusted.get(norm(dir));
    if (hit) return { trusted: true, via: hit };
    if (path.dirname(dir) === dir) return { trusted: false };
  }
}

type HookEntry = { matcher?: string; hooks?: { args?: string[]; onFailure?: string }[] };

function ourEntries(settings: Record<string, unknown> | undefined, event: string): HookEntry[] {
  const list = ((settings?.hooks as Record<string, HookEntry[]> | undefined)?.[event] ?? []) as HookEntry[];
  return list.filter((e) =>
    (e.hooks ?? []).some((h) =>
      (h.args ?? []).some((a) => a.replaceAll('\\', '/').endsWith('.friday/harness/claude-code/hook.mjs')),
    ),
  );
}

/** Runs the tracked launcher with no daemon reachable and checks it fails closed (plan M1.10). */
function simulateLauncher(hookFile: string, root: string): ClaudeCheck[] {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'friday-doctor-'));
  const runHook = (event: string, input: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, [hookFile, event], {
      input: JSON.stringify({ hook_event_name: event, session_id: 'friday-doctor', cwd: root, ...input }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, FRIDAY_STATE_DIR: empty },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    try {
      return {
        code: r.status,
        out: r.stdout ? (JSON.parse(r.stdout) as { hookSpecificOutput?: { permissionDecision?: string } }) : {},
      };
    } catch {
      return { code: r.status, out: {} };
    }
  };
  try {
    const read = runHook('PreToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: path.join(root, '.friday', 'project.db') },
    });
    const edit = runHook('PreToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: path.join(root, 'README.md'), old_string: 'a', new_string: 'b' },
    });
    const bash = runHook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } });
    const got = [read, edit, bash].map((r) => r.out.hookSpecificOutput?.permissionDecision ?? 'none');
    const ok = got[0] === 'deny' && got[1] === 'deny' && got[2] === 'ask';
    return [
      ok
        ? {
            id: 'cc.failsafe',
            status: 'ok',
            message:
              'with Friday down the launcher denies .friday/project.db reads and edits, and asks for shell commands',
          }
        : {
            id: 'cc.failsafe',
            status: 'fail',
            message: `launcher fail-safe decisions were read=${got[0]} edit=${got[1]} bash=${got[2]} (expected deny, deny, ask)`,
            fix: CONFIG_FIX,
          },
    ];
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

/** Starts the MCP server the way Claude Code would, with no daemon reachable, and lists its tools. */
async function probeMcp(root: string, entry: string): Promise<ClaudeCheck> {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'friday-doctor-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter((kv): kv is [string, string] => typeof kv[1] === 'string'),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, '.friday', 'harness', 'claude-code', 'launch-mcp.mjs')],
    cwd: root,
    env: { ...env, ...MCP_ENTRY.env, CLAUDE_PROJECT_DIR: root, FRIDAY_STATE_DIR: empty, FRIDAY_MCP_ENTRY: entry },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'friday-doctor', version: '0.1.0' });
  const started = Date.now();
  try {
    await client.connect(transport, { timeout: 10_000 });
    const tools = await client.listTools(undefined, { timeout: 10_000 });
    const names = tools.tools.map((t) => t.name);
    const ok = names.includes('friday_whoami') && names.includes('friday_claim_done');
    return ok
      ? {
          id: 'cc.mcp',
          status: 'ok',
          message: `MCP server starts (${Date.now() - started} ms) and lists ${names.length} friday tools`,
        }
      : { id: 'cc.mcp', status: 'fail', message: `MCP server listed unexpected tools: ${names.join(', ')}` };
  } catch (e) {
    return {
      id: 'cc.mcp',
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

/** `friday harness doctor claude-code` (plan M1.10). Read-only: it never changes the project or the daemon. */
export async function claudeDoctor(ref: ProjectRef, opts: ClaudeDoctorOptions = {}): Promise<ClaudeDoctorReport> {
  const checks: ClaudeCheck[] = [];
  const root = ref.root;

  const install = opts.install !== undefined ? opts.install : detectClaudeCode(opts.env);
  const level = hookLevel(install?.version ?? null);
  if (!install) {
    checks.push({
      id: 'cc.binary',
      status: 'warn',
      message: 'Claude Code not found (PATH, CLAUDE_CODE_BIN, VS Code extension, claude-cli-nodejs)',
      fix: 'install Claude Code, or set CLAUDE_CODE_BIN',
    });
  } else {
    const status = level === 'enforcing' ? 'ok' : level === 'degraded' ? 'warn' : 'fail';
    const note =
      level === 'enforcing'
        ? 'hooks fail closed'
        : level === 'degraded'
          ? `hooks fail open on timeout or crash; ${ENFORCING_MIN} or newer enforces`
          : `too old for Friday hooks; ${ENFORCING_MIN} or newer is required`;
    checks.push({
      id: 'cc.binary',
      status,
      message: `Claude Code ${install.version} via ${install.source} (${level}: ${note})`,
      ...(level === 'enforcing' ? {} : { fix: 'update Claude Code' }),
    });
  }

  const harnessDir = path.join(root, '.friday', 'harness', 'claude-code');
  const hookFile = path.join(harnessDir, 'hook.mjs');
  let hookOk = false;
  if (!existsSync(hookFile)) {
    checks.push({
      id: 'cc.hook',
      status: 'fail',
      message: '.friday/harness/claude-code/hook.mjs is missing',
      fix: CONFIG_FIX,
    });
  } else {
    const have = HOOK_VERSION_RE.exec(readFileSync(hookFile, 'utf8'))?.[1];
    let bundled: string | undefined;
    try {
      bundled = bundledHookSource();
    } catch {
      bundled = undefined;
    }
    const want = bundled ? HOOK_VERSION_RE.exec(bundled)?.[1] : undefined;
    const same = bundled !== undefined && readFileSync(hookFile, 'utf8') === bundled;
    hookOk = Boolean(have);
    checks.push(
      !have
        ? { id: 'cc.hook', status: 'fail', message: 'hook.mjs has no Friday version header', fix: CONFIG_FIX }
        : same || !bundled
          ? {
              id: 'cc.hook',
              status: 'ok',
              message: `hook launcher ${have}${bundled ? ' (matches this Friday build)' : ''}`,
            }
          : {
              id: 'cc.hook',
              status: 'warn',
              message: `hook launcher ${have} differs from this Friday build (${want ?? '?'})`,
              fix: CONFIG_FIX,
            },
    );
  }
  const launch = path.join(harnessDir, 'launch-mcp.mjs');
  checks.push(
    !existsSync(launch)
      ? { id: 'cc.launcher', status: 'fail', message: 'launch-mcp.mjs is missing', fix: CONFIG_FIX }
      : readFileSync(launch, 'utf8') === LAUNCH_MCP
        ? { id: 'cc.launcher', status: 'ok', message: 'MCP launcher is current' }
        : {
            id: 'cc.launcher',
            status: 'warn',
            message: 'launch-mcp.mjs differs from the current template',
            fix: CONFIG_FIX,
          },
  );

  const mcp = readJson(path.join(root, '.mcp.json'));
  const entry = (mcp?.mcpServers as Record<string, { command?: string; args?: string[] }> | undefined)?.friday;
  const mcpOk = entry?.command === 'node' && JSON.stringify(entry.args) === JSON.stringify(MCP_ENTRY.args);
  checks.push(
    mcpOk
      ? { id: 'cc.mcp-json', status: 'ok', message: '.mcp.json registers the friday server with node' }
      : {
          id: 'cc.mcp-json',
          status: 'fail',
          message: entry
            ? '.mcp.json friday entry is not the expected node launcher'
            : '.mcp.json has no friday server',
          fix: CONFIG_FIX,
        },
  );

  const shared = readJson(path.join(root, '.claude', 'settings.json'));
  const local = readJson(path.join(root, '.claude', 'settings.local.json'));
  const events = Object.keys(fridayHooks());
  const where = events.every((e) => ourEntries(shared, e).length)
    ? '.claude/settings.json'
    : events.every((e) => ourEntries(local, e).length)
      ? '.claude/settings.local.json'
      : null;
  const settings = where === '.claude/settings.json' ? shared : local;
  const pre = ourEntries(settings, 'PreToolUse')[0];
  const failClosed = Boolean(pre?.hooks?.some((h) => h.onFailure === 'block'));
  const matcherOk = pre?.matcher === PRE_TOOL_MATCHER;
  const hooksOk = Boolean(where) && failClosed && matcherOk;
  checks.push(
    !where
      ? {
          id: 'cc.hooks',
          status: 'fail',
          message: 'Friday hooks are missing from .claude/settings.json',
          fix: CONFIG_FIX,
        }
      : hooksOk
        ? {
            id: 'cc.hooks',
            status: 'ok',
            message: `${events.length} hook events in ${where}; PreToolUse covers ${PRE_TOOL_MATCHER.split('|').filter((t) => !t.startsWith('mcp__')).length} tools and every MCP tool with onFailure=block`,
          }
        : {
            id: 'cc.hooks',
            status: 'fail',
            message: `hooks in ${where} are outdated (${!failClosed ? 'PreToolUse does not fail closed' : 'PreToolUse matcher differs'})`,
            fix: CONFIG_FIX,
          },
  );
  const enabled = (local?.enabledMcpjsonServers as string[] | undefined)?.includes('friday');
  checks.push(
    enabled
      ? { id: 'cc.enabled', status: 'ok', message: 'friday MCP server pre-approved in .claude/settings.local.json' }
      : {
          id: 'cc.enabled',
          status: 'info',
          message: 'Claude Code will ask once to approve the project MCP server "friday"',
        },
  );

  const skill = path.join(root, '.claude', 'skills', 'friday', 'SKILL.md');
  checks.push(
    existsSync(skill) && /^name: friday$/m.test(readFileSync(skill, 'utf8'))
      ? { id: 'cc.skill', status: 'ok', message: 'friday skill present' }
      : { id: 'cc.skill', status: 'warn', message: 'the friday skill is missing', fix: CONFIG_FIX },
  );

  const info = readInstallInfo(opts.env);
  const mcpEntry = opts.env?.FRIDAY_MCP_ENTRY ?? info?.mcp_server_entry ?? undefined;
  const entryOk = Boolean(mcpEntry && existsSync(mcpEntry));
  checks.push(
    entryOk
      ? { id: 'cc.install', status: 'ok', message: `MCP server entry: ${mcpEntry}` }
      : {
          id: 'cc.install',
          status: 'fail',
          message: 'Friday is not set up on this machine (install.json has no MCP server entry)',
          fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
        },
  );

  // Secrets: the live tokens must not appear in any file Claude can read in the project.
  const live = [readToken(ref, 'operator', opts.env), readToken(ref, 'bootstrap', opts.env)].filter((t): t is string =>
    Boolean(t),
  );
  const files = [
    path.join(root, '.mcp.json'),
    path.join(root, 'CLAUDE.md'),
    ...listFiles(path.join(root, '.claude')),
    ...listFiles(harnessDir),
  ].filter((f) => existsSync(f) && statSync(f).isFile());
  const leaked = files.filter((f) => {
    const text = readFileSync(f, 'utf8');
    return live.some((t) => text.includes(t));
  });
  checks.push(
    leaked.length
      ? {
          id: 'cc.secrets',
          status: 'fail',
          message: `Friday tokens found in ${leaked.map((f) => path.relative(root, f)).join(', ')}`,
          fix: 'delete those lines and run "friday token rotate"',
        }
      : { id: 'cc.secrets', status: 'ok', message: `no Friday tokens in ${files.length} Claude-readable file(s)` },
  );

  const discovery = readDiscovery(ref, opts.env);
  if (!discovery) {
    checks.push({
      id: 'cc.daemon',
      status: 'warn',
      message: 'daemon not running: edits are paused and commands need confirmation until it is',
      fix: 'run "friday run"',
    });
  } else {
    try {
      const token = readToken(ref, 'bootstrap', opts.env) ?? '';
      const client = new DaemonClient({
        baseUrl: discovery.url,
        token,
        tokenClass: 'bootstrap',
        projectId: ref.project_id,
        timeoutMs: 2000,
        clientName: 'friday-doctor',
      });
      await client.get('/health');
      checks.push({
        id: 'cc.daemon',
        status: 'ok',
        message: `daemon reachable at ${discovery.url} with the bootstrap token`,
      });
    } catch (e) {
      checks.push({
        id: 'cc.daemon',
        status: 'warn',
        message: `daemon did not answer: ${(e as Error).message}`,
        fix: 'restart with "friday run"',
      });
    }
  }

  if (hookOk) checks.push(...simulateLauncher(hookFile, root));
  if (!opts.skipMcp && entryOk && mcpOk && existsSync(launch)) checks.push(await probeMcp(root, mcpEntry as string));

  const trust = workspaceTrusted(root, opts.env);
  checks.push(
    trust?.trusted
      ? {
          id: 'cc.trust',
          status: 'ok',
          message: `Claude Code trusts this folder${trust.via && path.resolve(trust.via) !== path.resolve(root) ? ` (through ${trust.via})` : ''}`,
        }
      : {
          id: 'cc.trust',
          status: 'info',
          message:
            'Claude Code has not trusted this folder yet. Until it does, it ignores permissions.allow in .claude/settings.json, so friday tools ask before they run (and are refused in -p mode)',
          fix: 'open Claude Code here once and accept the trust prompt; headless runs can pass --allowedTools mcp__friday',
        },
  );

  const attached = hookOk && hooksOk && mcpOk;
  const achieved: ClaudeDoctorReport['achieved'] = !attached
    ? mcpOk
      ? 'L0 observed'
      : 'not attached'
    : level === 'enforcing'
      ? 'L1 enforcing'
      : level === 'degraded' || level === 'unknown'
        ? 'L1 degraded'
        : 'L0 observed';
  return { checks, install, hook_level: level, achieved };
}
