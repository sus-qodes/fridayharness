import path from 'node:path';
import type { FileChange } from '@friday/adapter-claude';
import { DaemonClient, type ProjectRef, privateDirFor } from '@friday/sdk';
import { OpenCodeSpawnAdapter } from './adapter.js';
import { applyOpenCodePlan, planOpenCode } from './config.js';
import { findOpenCode, opencodeDoctor } from './doctor.js';
import { configured, LEVEL_NOTE, loopbackModelUrl, OPENCODE_VERSION } from './profile.js';
import { OpenCodeWorker } from './worker.js';

interface Io {
  out(value: unknown, text: () => string): void;
  extraChanges?(root: string): FileChange[];
}
export function opencodeConfigCli(
  ref: ProjectRef,
  flags: {
    agent?: string;
    print?: boolean;
    remove?: boolean;
    scope?: string;
    claudeMd?: boolean;
    requireEnforcing?: boolean;
  },
  io: Io,
): void {
  if (flags.agent) throw new Error('OpenCode preflight agent identity is selected by harness run opencode --agent');
  if (flags.scope === 'local' || flags.claudeMd || flags.requireEnforcing)
    throw new Error('OpenCode supports only an experimental project preflight declaration');
  const changes = planOpenCode({ projectDir: ref.root, ...(flags.remove ? { remove: true } : {}) });
  if (!flags.remove) changes.push(...(io.extraChanges?.(ref.root) ?? []));
  if (!flags.print) applyOpenCodePlan(changes);
  io.out(
    {
      host: 'opencode',
      experimental: true,
      applied: !flags.print,
      removed: Boolean(flags.remove),
      level: LEVEL_NOTE,
      changes: changes.map((c) => ({
        path: c.display,
        action: c.after === null ? 'delete' : c.before === null ? 'create' : 'update',
      })),
    },
    () =>
      (flags.print ? 'Would configure' : flags.remove ? 'Removed' : 'Configured') +
      ' OpenCode no-model preflight.\n' +
      LEVEL_NOTE,
  );
}
export function opencodeDoctorCli(ref: ProjectRef, _flags: unknown, io: Io): void {
  const report = opencodeDoctor(ref.root);
  io.out(report, () => report.checks.map((c) => `${c.status}: ${c.message}`).join('\n'));
  if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
}
/**
 * `friday harness run opencode --model-url <loopback> --model <name>` (plan M14.4, experimental):
 * OpenCode works for Friday on a model on this machine, each run attempt in its own controlled
 * server and session, until it is stopped. Resolves with the started worker and what to print.
 */
export async function opencodeWorkerCli(
  ref: ProjectRef,
  flags: { agent?: string; role?: string; hostBin?: string; modelUrl: string; model: string },
): Promise<{ worker: OpenCodeWorker; message: string }> {
  if (!configured(ref.root)) throw new Error('Run friday harness config opencode first');
  const command = flags.hostBin ?? findOpenCode();
  const dependenciesDir = process.env.FRIDAY_OPENCODE_DEPS_DIR;
  if (!command || !dependenciesDir)
    throw new Error('OpenCode native executable and FRIDAY_OPENCODE_DEPS_DIR are required');
  const agentKey = flags.agent ?? (process.env.FRIDAY_AGENT || 'opencode-1');
  const worker = new OpenCodeWorker({
    bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'friday-opencode' }),
    projectId: ref.project_id,
    agentKey,
    ...(flags.role ? { role: flags.role } : {}),
    host: { command },
    dependenciesDir,
    inference: { baseURL: loopbackModelUrl(flags.modelUrl), model: flags.model },
    workDir: privateDirFor(ref),
    // Where an attempt's ending waits until Friday records it, as every spawn adapter keeps it.
    stateDir: path.join(privateDirFor(ref), 'adapters', `opencode-${agentKey.replace(/[^A-Za-z0-9_.-]/g, '_')}`),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const reg = await worker.start();
  return {
    worker,
    message: `OpenCode ${OPENCODE_VERSION} works for Friday as ${reg.agent_key} (${reg.harness_id}) on ${flags.model} at ${flags.modelUrl}. ${LEVEL_NOTE}. Ctrl+C stops it and its work.`,
  };
}

/** Runs A/B preflight and closes. It does not poll tasks, submit prompts or read provider credentials. */
export async function opencodeRunCli(
  ref: ProjectRef,
  flags: { agent?: string; hostBin?: string },
  io: Io,
): Promise<void> {
  if (!configured(ref.root)) throw new Error('Run friday harness config opencode first');
  const command = flags.hostBin ?? findOpenCode();
  const dependenciesDir = process.env.FRIDAY_OPENCODE_DEPS_DIR;
  if (!command || !dependenciesDir)
    throw new Error('OpenCode native executable and FRIDAY_OPENCODE_DEPS_DIR are required');
  const adapter = new OpenCodeSpawnAdapter({
    bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'friday-opencode' }),
    projectId: ref.project_id,
    agentKey: flags.agent ?? (process.env.FRIDAY_AGENT || 'opencode-1'),
    cwd: ref.root,
    host: { command },
    dependenciesDir,
    workDir: privateDirFor(ref),
  });
  try {
    const result = await adapter.start();
    io.out(result, () => `OpenCode no-model preflight passed. ${result.level}`);
  } finally {
    await adapter.close();
  }
}
