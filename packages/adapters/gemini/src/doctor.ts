import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bundledHookSource } from '@friday/adapter-claude';
import { DaemonClient, type ProjectRef, readDiscovery, readInstallInfo, readToken } from '@friday/sdk';
import { hooksSwitchedOff, LAUNCHER_HEADER, readProjectHooks } from './checks.js';
import {
  compareVersions,
  findGemini,
  type GeminiInstall,
  geminiLoginHints,
  MIN_VERSION,
  RECORDED_VERSION,
} from './detect.js';
import { hookShell, runHookCommand } from './shell.js';
import { GEMINI_HARNESS_DIR, GEMINI_HOOK_FILE, GEMINI_LAUNCH_MCP, geminiHookCommand } from './templates.js';

/** Same shape as the CLI's doctor results (the CLI renders them). */
export interface GeminiCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fix?: string;
}

export interface GeminiDoctorReport {
  checks: GeminiCheck[];
  install: GeminiInstall;
  /** What Friday reaches with Gemini CLI in this project (plan B21): fail-open at best. */
  achieved: 'L1 degraded' | 'L0 observed' | 'not attached';
}

export interface GeminiDoctorOptions {
  /** Skip running the hook command through the host's shell (`--quick`). */
  quick?: boolean;
  /** Override detection (tests). */
  install?: GeminiInstall;
  env?: NodeJS.ProcessEnv;
}

const CONFIG_FIX = 're-run "friday harness config gemini"';

/** Plainly what Gemini CLI needs since 2026-06-18, whatever this machine has. */
export const ACCOUNT_NOTE =
  'Gemini CLI no longer serves consumer accounts (Google AI Pro and Ultra, and free Gemini Code Assist for individuals) since 2026-06-18: it needs a paid Gemini API key, a Vertex AI project, or a Gemini Code Assist Standard or Enterprise licence';

/** The level Gemini CLI gives Friday at best, and why (plan A.5, Appendix 10). */
export const LEVEL_NOTE =
  "L1 degraded (fail-open): every tool call passes Friday's BeforeTool hook once the session's hooks reach Friday, but a hook that crashes, times out or cannot start node lets the call through, and no Gemini CLI version offers a setting that blocks instead";

function listFiles(dir: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(path.join(dir, e.name), depth - 1) : [path.join(dir, e.name)],
  );
}

/** The environment of a doctor's launcher run: this one's, without another host's or Friday's variables. */
function probeEnv(env: NodeJS.ProcessEnv, stateDir: string, root: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^(FRIDAY_|CLAUDE|CURSOR_|GEMINI_PROJECT_DIR$|GEMINI_CWD$)/i.test(k)) continue;
    out[k] = v;
  }
  return { ...out, FRIDAY_STATE_DIR: stateDir, GEMINI_PROJECT_DIR: root, GEMINI_CWD: root };
}

const beforeTool = (root: string, tool: string, input: Record<string, unknown>) => ({
  session_id: 'friday-doctor',
  transcript_path: path.join(os.tmpdir(), 'friday-doctor.json'),
  cwd: root,
  hook_event_name: 'BeforeTool',
  timestamp: new Date().toISOString(),
  tool_name: tool,
  tool_input: input,
});

/**
 * Runs the tracked launcher with no daemon reachable, as Gemini CLI would run it, and checks it
 * still restricts (plan M1.10): a read of Friday's database and an edit are denied, a shell command
 * asks. Then, unless `quick`, runs the configured command line through the host's shell, the way
 * Gemini CLI runs it on this machine, and checks that the denial reaches the host.
 */
async function simulate(root: string, env: NodeJS.ProcessEnv, quick: boolean): Promise<GeminiCheck[]> {
  const empty = mkdtempSync(path.join(os.tmpdir(), 'friday-doctor-'));
  const hookFile = path.join(root, ...GEMINI_HOOK_FILE.split('/'));
  const runEnv = probeEnv(env, empty, root);
  const decide = (tool: string, input: Record<string, unknown>) => {
    const r = spawnSync(process.execPath, [hookFile, 'gemini', 'BeforeTool'], {
      input: JSON.stringify(beforeTool(root, tool, input)),
      cwd: root,
      env: runEnv,
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    try {
      return String((JSON.parse(r.stdout || '{}') as { decision?: unknown }).decision ?? 'none');
    } catch {
      return 'none';
    }
  };
  const protectedRead = { file_path: path.join(root, '.friday', 'project.db') };
  try {
    const got = [
      decide('read_file', protectedRead),
      decide('write_file', { file_path: path.join(root, 'README.md'), content: 'x' }),
      decide('run_shell_command', { command: 'git status' }),
    ];
    const checks: GeminiCheck[] = [
      got[0] === 'deny' && got[1] === 'deny' && got[2] === 'ask'
        ? {
            id: 'gemini.failsafe',
            status: 'ok',
            message:
              'with Friday down the launcher denies .friday/project.db reads and edits, and asks for shell commands',
          }
        : {
            id: 'gemini.failsafe',
            status: 'fail',
            message: `the launcher's decisions with Friday down were read=${got[0]} edit=${got[1]} shell=${got[2]} (expected deny, deny, ask)`,
            fix: CONFIG_FIX,
          },
    ];
    if (!quick) {
      const shell = hookShell(env);
      const r = await runHookCommand(geminiHookCommand('BeforeTool'), beforeTool(root, 'read_file', protectedRead), {
        cwd: root,
        env: runEnv,
        timeoutMs: 20_000,
        shell,
      });
      const name = path.basename(shell.executable);
      checks.push(
        r.json?.decision === 'deny'
          ? {
              id: 'gemini.shell',
              status: 'ok',
              message: `Friday's BeforeTool command runs through ${name} as Gemini CLI runs it here, and its denial reaches the host (exit ${r.code})`,
            }
          : {
              id: 'gemini.shell',
              status: 'fail',
              message: `Friday's BeforeTool command did not reach the launcher through ${name}: ${r.error ?? (r.stderr.trim().split('\n')[0] || `exit ${r.code}, no answer`)}. Gemini CLI would let every tool call through`,
              fix: 'make sure "node" starts from that shell (it is on PATH), then run the doctor again',
            },
      );
    }
    return checks;
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
}

/**
 * `friday harness doctor gemini` (plan M8b.4). Read only: it never changes the project, the
 * daemon or Gemini CLI's settings, and it never starts Gemini CLI or calls a model. Without a
 * project it checks the installed host only.
 */
export async function geminiDoctor(
  ref: ProjectRef | null,
  opts: GeminiDoctorOptions = {},
): Promise<GeminiDoctorReport> {
  const env = opts.env ?? process.env;
  const checks: GeminiCheck[] = [];
  const install = opts.install ?? findGemini(env);

  if (!install.command) {
    checks.push({
      id: 'gemini.cli',
      status: 'warn',
      message: install.problem ?? 'Gemini CLI was not found',
      fix: 'install it for your user: npm install -g @google/gemini-cli',
    });
  } else {
    checks.push({
      id: 'gemini.cli',
      status: 'ok',
      message: `Gemini CLI ${install.version ?? '(version unknown)'} via ${install.source ?? '?'} (${install.args[0] ?? install.command})`,
    });
    if (install.version && compareVersions(install.version, MIN_VERSION) < 0) {
      checks.push({
        id: 'gemini.version',
        status: 'fail',
        message: `Gemini CLI ${install.version} cannot ask a human from a hook; Friday needs ${MIN_VERSION} or newer`,
        fix: 'update it: gemini update, or npm install -g @google/gemini-cli',
      });
    } else if (install.version !== RECORDED_VERSION) {
      checks.push({
        id: 'gemini.version',
        status: 'info',
        message: `Friday's adapter follows Gemini CLI ${RECORDED_VERSION}'s documented behaviour; this is ${install.version ?? 'an unknown version'}`,
      });
    }
  }
  const hints = geminiLoginHints(env);
  checks.push({
    id: 'gemini.account',
    status: 'info',
    message: `${ACCOUNT_NOTE}. ${hints.length ? `Set here: ${hints.join(', ')}` : 'None of GEMINI_API_KEY, GOOGLE_API_KEY or GOOGLE_GENAI_USE_VERTEXAI is set here; a Code Assist licence signs in through Gemini CLI itself'}`,
  });
  checks.push({
    id: 'gemini.experimental',
    status: 'info',
    message:
      "experimental: built from Gemini CLI's documented behaviour and source, and tested against a scripted host; the live check with your own key is still to do (docs/integration/gemini-cli.md)",
  });

  if (!ref) {
    checks.push({ id: 'gemini.level', status: 'info', message: `best reachable: ${LEVEL_NOTE}` });
    return { checks, install, achieved: 'not attached' };
  }

  const root = ref.root;
  const project = readProjectHooks(root);
  let bundled: string | undefined;
  try {
    bundled = bundledHookSource();
  } catch {
    bundled = undefined;
  }
  const hookFile = path.join(root, ...GEMINI_HOOK_FILE.split('/'));
  const want = bundled ? LAUNCHER_HEADER.exec(bundled)?.[1] : undefined;
  checks.push(
    !existsSync(hookFile)
      ? { id: 'gemini.hook', status: 'fail', message: `${GEMINI_HOOK_FILE} is missing`, fix: CONFIG_FIX }
      : !project.launcherVersion
        ? { id: 'gemini.hook', status: 'fail', message: 'hook.mjs has no Friday version header', fix: CONFIG_FIX }
        : bundled && readFileSync(hookFile, 'utf8') !== bundled
          ? {
              id: 'gemini.hook',
              status: 'warn',
              message: `hook launcher ${project.launcherVersion} differs from this Friday build (${want ?? '?'})`,
              fix: CONFIG_FIX,
            }
          : {
              id: 'gemini.hook',
              status: 'ok',
              message: `hook launcher ${project.launcherVersion}${bundled ? ' (matches this Friday build)' : ''}`,
            },
  );
  const launch = path.join(root, ...GEMINI_HARNESS_DIR.split('/'), 'launch-mcp.mjs');
  checks.push(
    !existsSync(launch)
      ? { id: 'gemini.launcher', status: 'fail', message: 'launch-mcp.mjs is missing', fix: CONFIG_FIX }
      : readFileSync(launch, 'utf8') === GEMINI_LAUNCH_MCP
        ? { id: 'gemini.launcher', status: 'ok', message: 'MCP launcher is current' }
        : {
            id: 'gemini.launcher',
            status: 'warn',
            message: 'launch-mcp.mjs differs from the current template',
            fix: CONFIG_FIX,
          },
  );
  const hooksOk = project.settings !== null && project.missing.length === 0;
  checks.push(
    hooksOk
      ? {
          id: 'gemini.settings',
          status: 'ok',
          message:
            '.gemini/settings.json runs Friday on SessionStart, BeforeTool (every tool, matcher ".*"), AfterTool, AfterAgent and SessionEnd',
        }
      : {
          id: 'gemini.settings',
          status: 'fail',
          message: project.settingsError ?? `Friday's hooks are missing or outdated for ${project.missing.join(', ')}`,
          fix: CONFIG_FIX,
        },
  );
  checks.push(
    project.mcpOk
      ? { id: 'gemini.mcp', status: 'ok', message: '.gemini/settings.json registers the friday server with node' }
      : {
          id: 'gemini.mcp',
          status: 'fail',
          message: '.gemini/settings.json has no friday server Friday wrote',
          fix: CONFIG_FIX,
        },
  );
  const md = path.join(root, 'GEMINI.md');
  checks.push(
    existsSync(md) && readFileSync(md, 'utf8').includes('<!-- friday:begin -->')
      ? { id: 'gemini.md', status: 'ok', message: "GEMINI.md carries Friday's block" }
      : {
          id: 'gemini.md',
          status: 'info',
          message: "GEMINI.md has no Friday block; the friday server's instructions still reach the model",
        },
  );
  if (project.otherBeforeTool.length) {
    checks.push({
      id: 'gemini.others',
      status: 'warn',
      message: `other BeforeTool hooks in .gemini/settings.json (${project.otherBeforeTool.join(', ')}) can rewrite a tool call after Friday judged it`,
      fix: 'remove them, or keep them only if you trust what they change',
    });
  }
  const off = hooksSwitchedOff(root, env);
  if (off.length) {
    checks.push({
      id: 'gemini.switched',
      status: 'fail',
      message: `Friday's hooks would not run: ${off.join('; ')}`,
      fix: 'remove those settings: without the hooks Gemini CLI runs every tool call unjudged',
    });
  }

  const info = readInstallInfo(env);
  const mcpEntry = env.FRIDAY_MCP_ENTRY ?? info?.mcp_server_entry ?? undefined;
  checks.push(
    mcpEntry && existsSync(mcpEntry)
      ? { id: 'gemini.install', status: 'ok', message: `MCP server entry: ${mcpEntry}` }
      : {
          id: 'gemini.install',
          status: 'fail',
          message: 'Friday is not set up on this machine (install.json has no MCP server entry)',
          fix: 'run "pnpm build" in the Friday repository, then "friday setup"',
        },
  );

  // Secrets: the live tokens must not appear in any file Gemini CLI reads or runs in the project.
  const live = [readToken(ref, 'operator', env), readToken(ref, 'bootstrap', env)].filter((t): t is string =>
    Boolean(t),
  );
  const files = [
    md,
    ...listFiles(path.join(root, '.gemini')),
    ...listFiles(path.join(root, ...GEMINI_HARNESS_DIR.split('/'))),
  ].filter((f) => existsSync(f) && statSync(f).isFile());
  const leaked = files.filter((f) => live.some((t) => readFileSync(f, 'utf8').includes(t)));
  checks.push(
    leaked.length
      ? {
          id: 'gemini.secrets',
          status: 'fail',
          message: `Friday tokens found in ${leaked.map((f) => path.relative(root, f)).join(', ')}`,
          fix: 'delete those lines and run "friday token rotate"',
        }
      : { id: 'gemini.secrets', status: 'ok', message: `no Friday tokens in ${files.length} file(s) Gemini CLI reads` },
  );

  const discovery = readDiscovery(ref, env);
  if (!discovery) {
    checks.push({
      id: 'gemini.daemon',
      status: 'warn',
      message: 'daemon not running: edits are paused and commands need confirmation until it is',
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
        id: 'gemini.daemon',
        status: 'ok',
        message: `daemon reachable at ${discovery.url} with the bootstrap token`,
      });
    } catch (e) {
      checks.push({
        id: 'gemini.daemon',
        status: 'warn',
        message: `daemon did not answer: ${(e as Error).message}`,
        fix: 'restart with "friday run"',
      });
    }
  }

  if (project.launcherVersion) checks.push(...(await simulate(root, env, Boolean(opts.quick))));

  checks.push({
    id: 'gemini.trust',
    status: 'info',
    message:
      "Gemini CLI runs a project's hooks only in a folder you trusted, and lists new or changed project hooks once before it runs them. Start gemini from the project's root: it reads .gemini/settings.json only from the folder it starts in",
  });
  checks.push({
    id: 'gemini.spawn',
    status: 'info',
    message:
      "spawn mode: friday harness run gemini starts this Gemini CLI headless for each run attempt, in the task's worktree, with these hooks; commit .gemini/settings.json and .friday/harness/gemini/ so every worktree has them",
  });

  const attached =
    Boolean(project.launcherVersion) &&
    hooksOk &&
    project.mcpOk &&
    off.length === 0 &&
    !checks.some((c) => (c.id === 'gemini.failsafe' || c.id === 'gemini.shell') && c.status === 'fail');
  const achieved: GeminiDoctorReport['achieved'] = attached
    ? 'L1 degraded'
    : project.mcpOk
      ? 'L0 observed'
      : 'not attached';
  checks.push({
    id: 'gemini.level',
    status: attached ? 'warn' : 'info',
    message: attached
      ? LEVEL_NOTE
      : `${achieved}: Friday's hooks are not all in place; once they are, ${LEVEL_NOTE.replace(/^L1 degraded \(fail-open\): /, 'the level is L1 degraded (fail-open): ')}`,
  });
  return { checks, install, achieved };
}
