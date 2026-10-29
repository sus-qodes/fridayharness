import { tmpdir } from 'node:os';
import { ProcessGroups, startProcess } from '@friday/execution';
import { FRIDAY_VERSION } from '@friday/sdk';
import type { CodexSandbox } from './adapter.js';
import { findCodex, hostEnvironment } from './detect.js';
import { JsonRpcLines } from './rpc.js';

/** The host version the adapter's protocol was recorded against (M3.5, `tests/fixtures/codex/`). */
export const RECORDED_VERSION = '0.162.1';

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
  opts: { env?: NodeJS.ProcessEnv; sandbox?: CodexSandbox; probe?: boolean } = {},
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
  if (sandboxReady !== null) {
    if (sandbox === 'danger-full-access') {
      checks.push({
        id: 'codex.sandbox',
        status: 'warn',
        message: `Codex's commands run without its sandbox (--sandbox danger-full-access; its sandbox here: ${sandboxReady}); file changes Codex does not ask about are not judged before they happen`,
        fix: 'verification judges every change afterwards; use workspace-write where the sandbox is ready',
      });
    } else if (sandboxReady !== 'ready') {
      checks.push({
        id: 'codex.sandbox',
        status: 'warn',
        message: `Codex's Windows sandbox is ${sandboxReady}: under ${sandbox} the commands Friday approves fail to start (M3.5)`,
        fix: 'set the sandbox up as an administrator, or run with --sandbox danger-full-access and rely on approvals and verification',
      });
    } else {
      checks.push({ id: 'codex.sandbox', status: 'ok', message: `Codex's Windows sandbox is ready (${sandbox})` });
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
