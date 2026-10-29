import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { ProcessGroups, startProcess } from '@friday/execution';
import { FRIDAY_VERSION } from '@friday/sdk';
import type { CodexSandbox } from './adapter.js';
import { findCodex, hostEnvironment } from './detect.js';
import { JsonRpcLines } from './rpc.js';

/** The host version the adapter's protocol was recorded against (M3.5, `tests/fixtures/codex/`). */
export const RECORDED_VERSION = '0.162.1';

/**
 * Whether Codex's Windows sandbox starts a command here (`codex sandbox`, the sandbox a thread's
 * commands run in), and whether that command can start another program, as test runners and
 * package managers do: Node, in the system temp folder, starting Node once. No model is called.
 */
export function sandboxStarts(
  codex: string,
  env: NodeJS.ProcessEnv,
  mode?: 'elevated' | 'unelevated',
): Promise<{ ok: boolean; spawns: boolean; error: string }> {
  const args = [
    'sandbox',
    ...(mode ? ['-c', `windows.sandbox="${mode}"`] : []),
    process.execPath,
    '-e',
    "process.exit(require('child_process').spawnSync(process.execPath, ['-e', '0']).status === 0 ? 0 : 3)",
  ];
  return new Promise((resolve) => {
    execFile(
      codex,
      args,
      { cwd: tmpdir(), env: hostEnvironment(env), timeout: 30_000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (!err) return resolve({ ok: true, spawns: true, error: '' });
        if ((err as { code?: unknown }).code === 3) return resolve({ ok: true, spawns: false, error: '' });
        const why = String(stderr || err.message)
          .trim()
          .split('\n')
          .find((l) => l.trim())
          ?.slice(0, 200);
        resolve({ ok: false, spawns: false, error: why || 'it failed' });
      },
    );
  });
}

export interface CodexDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fix?: string;
}

/**
 * `friday harness doctor codex` (ADR-0032 §6): the executable and its version, the host's own
 * answer (`initialize`), the readiness of its Windows sandbox, the settings every thread Friday
 * starts pins, and the level that gives. It starts an app-server without a thread or a turn: no
 * model is called.
 */
export async function codexDoctor(
  opts: {
    env?: NodeJS.ProcessEnv;
    sandbox?: CodexSandbox;
    windowsSandbox?: 'elevated' | 'unelevated';
    probe?: boolean;
  } = {},
): Promise<{ checks: CodexDoctorCheck[]; achieved: string }> {
  const env = opts.env ?? process.env;
  const sandbox = opts.sandbox ?? 'workspace-write';
  const checks: CodexDoctorCheck[] = [];
  const install = findCodex(env);
  if (!install.binary) {
    checks.push({ id: 'codex', status: 'fail', message: install.problem ?? 'Codex was not found' });
    return { checks, achieved: 'none: no Codex to run' };
  }
  checks.push({ id: 'codex', status: 'ok', message: `${install.binary} (${install.version ?? 'version unknown'})` });
  if (install.version !== RECORDED_VERSION) {
    checks.push({
      id: 'codex.version',
      status: 'warn',
      message: `Friday's adapter was recorded against Codex ${RECORDED_VERSION}; this is ${install.version ?? 'an unknown version'}`,
      fix: 'run the Codex conformance suite against it before relying on it',
    });
  }
  let sandboxReady: string | null = null;
  if (opts.probe !== false) {
    const groups = new ProcessGroups();
    const group = groups.create();
    let rpc: JsonRpcLines | undefined;
    const proc = startProcess({
      command: install.binary,
      args: ['app-server'],
      // A neutral folder: the probe starts no thread, so it needs no checkout.
      cwd: tmpdir(),
      env: hostEnvironment(env),
      group,
      onLine: (l) => rpc?.feed(l),
    });
    rpc = new JsonRpcLines((l) => proc.write(l), {
      onNotification: () => undefined,
      onRequest: async () => {
        throw new Error('the doctor answers nothing');
      },
    });
    try {
      const init = await rpc.request<{ userAgent?: string }>(
        'initialize',
        { clientInfo: { name: 'friday', title: 'Friday doctor', version: FRIDAY_VERSION }, capabilities: null },
        20_000,
      );
      rpc.notify('initialized');
      checks.push({
        id: 'codex.server',
        status: 'ok',
        message: `app-server answers: ${init.userAgent ?? 'no user agent'}`,
      });
      if (process.platform === 'win32') {
        const r = await rpc
          .request<{ status?: string }>('windowsSandbox/readiness', {}, 20_000)
          .catch((e: Error) => ({ status: `unknown (${e.message})` }));
        sandboxReady = r.status ?? 'unknown';
      }
      const read = await rpc
        .request<{ config?: { mcp_servers?: Record<string, unknown> | null } }>(
          'config/read',
          { includeLayers: false, cwd: tmpdir() },
          20_000,
        )
        .catch(() => null);
      const servers = Object.keys(read?.config?.mcp_servers ?? {}).sort();
      checks.push({
        id: 'codex.isolation',
        status: read ? 'info' : 'warn',
        message: read
          ? `Friday's threads run without your Codex plugins, ChatGPT apps, tool suggestions and web search${servers.length ? `, and with your MCP servers off (${servers.join(', ')})` : ''}; the checkout is untrusted for them, so a repository's own .codex/ files and AGENTS.md do not apply and nothing is added to your Codex configuration`
          : 'Codex did not show its configuration; each thread Friday starts reads it again, and starts no turn unless Codex confirms that no MCP server runs in it',
      });
    } catch (e) {
      checks.push({
        id: 'codex.server',
        status: 'fail',
        message: `the app-server did not answer: ${(e as Error).message}`,
      });
    } finally {
      await proc.stop().catch(() => undefined);
      await groups.close();
    }
  }
  if (sandbox === 'danger-full-access') {
    checks.push({
      id: 'codex.sandbox',
      status: 'warn',
      message: `Codex's commands run without its sandbox (--sandbox danger-full-access); file changes Codex does not ask about are not judged before they happen`,
      fix: 'verification judges every change afterwards; use workspace-write where the sandbox starts commands',
    });
  } else if (process.platform === 'win32' && opts.probe !== false) {
    // Codex's own readiness report said `ready` on a machine where every sandboxed command failed to
    // start (M3.5, and the live check of 2026-10-15): a command is started to see.
    const chosen = await sandboxStarts(install.binary, env, opts.windowsSandbox);
    const named = opts.windowsSandbox ? `the ${opts.windowsSandbox} sandbox` : 'the sandbox your Codex setting chooses';
    if (chosen.ok && chosen.spawns) {
      checks.push({ id: 'codex.sandbox', status: 'ok', message: `Codex starts commands in ${named} (${sandbox})` });
    } else if (chosen.ok) {
      checks.push({
        id: 'codex.sandbox',
        status: 'warn',
        message: `Codex starts commands in ${named} (${sandbox}), but they cannot start other programs (EPERM): test runners and package managers that start workers fail there`,
        fix: 'have tests run in one process (node --test --test-isolation=none), set the elevated sandbox up as an administrator, or run with --sandbox danger-full-access and rely on approvals and verification',
      });
    } else {
      const fallback =
        opts.windowsSandbox === 'unelevated' ? chosen : await sandboxStarts(install.binary, env, 'unelevated');
      checks.push({
        id: 'codex.sandbox',
        status: 'warn',
        message: `Codex cannot start commands in ${named} here (${chosen.error}; its readiness report: ${sandboxReady ?? 'unknown'}): every command Friday approves would fail`,
        fix:
          fallback.ok && opts.windowsSandbox !== 'unelevated'
            ? `run with --windows-sandbox unelevated, which starts commands here${fallback.spawns ? '' : ', though they cannot start other programs (run tests in one process: node --test --test-isolation=none)'}. In a check on 2026-10-15 it kept network connections out but not writes outside the folder; verification judges every change. Or set the elevated sandbox up as an administrator`
            : 'set the sandbox up as an administrator, or run with --sandbox danger-full-access and rely on approvals and verification',
      });
    }
  } else {
    checks.push({ id: 'codex.sandbox', status: 'info', message: `threads run with --sandbox ${sandbox}` });
  }
  checks.push({
    id: 'codex.policy',
    status: 'info',
    message:
      "every thread Friday starts pins approvalPolicy untrusted and approvalsReviewer user; commands and file changes that reach approval pass Friday's policy (tool.check); reads Codex deems safe are not mediated",
  });
  return {
    checks,
    achieved: checks.some((c) => c.status === 'fail')
      ? 'none: Codex cannot run here'
      : 'L1 (reported): commands and file changes that reach approval; reads not mediated',
  };
}
