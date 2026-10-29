import { CodexAdapter, type CodexSandbox, codexDoctor, findCodex, hostEnvironment } from '@friday/adapter-codex';
import { DaemonClient } from '@friday/sdk';
import { type Command, Option } from 'commander';
import { type GlobalOptions, out, project, UsageError } from './context.js';
import { renderDoctor } from './doctor.js';

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'] as const;

interface SpawnRunOptions {
  agent?: string;
  role: string;
  sandbox: CodexSandbox;
  effort?: string;
  serviceTier?: string;
  windowsSandbox?: 'elevated' | 'unelevated';
}

/**
 * `friday harness run codex` (ADR-0032 §1): Codex works for Friday in the foreground, taking the
 * tasks Friday gives its agent, until it is stopped; its hosts and their work end with it.
 */
export function registerSpawnRun(harness: Command, g: () => GlobalOptions): void {
  harness
    .command('run <host>')
    .description('work for Friday as a spawn-mode harness, in the foreground (codex)')
    .option('--agent <key>', 'the agent this host works as (default: FRIDAY_AGENT, else codex-1)')
    .option('--role <role>', 'its role, which delegation matches tasks against', 'developer')
    .addOption(
      new Option('--sandbox <mode>', 'the sandbox Codex runs its commands in')
        .choices([...SANDBOXES])
        .default('workspace-write'),
    )
    .option('--effort <level>', 'reasoning effort for its turns (the host default otherwise)')
    .option(
      '--service-tier <tier>',
      'service tier of its threads: default (standard speed) or priority (your Codex setting otherwise)',
    )
    .addOption(
      new Option(
        '--windows-sandbox <mode>',
        "the Windows sandbox its commands run in: elevated needs an administrator's setup, unelevated does not (your Codex setting otherwise)",
      ).choices(['elevated', 'unelevated']),
    )
    .action(async (host: string, o: SpawnRunOptions) => {
      if (host !== 'codex') throw new UsageError(`spawn mode is built for codex; ${host} is not supported yet`);
      const ref = project(g());
      const install = findCodex();
      if (!install.binary) throw new UsageError(install.problem ?? 'Codex was not found');
      const agentKey = o.agent ?? process.env.FRIDAY_AGENT ?? 'codex-1';
      const adapter = new CodexAdapter({
        bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'friday-codex' }),
        projectId: ref.project_id,
        agentKey,
        role: o.role,
        host: {
          command: install.binary,
          args: ['app-server'],
          ...(install.version ? { version: install.version } : {}),
        },
        hostEnv: hostEnvironment(),
        sandbox: o.sandbox,
        ...(o.effort ? { effort: o.effort } : {}),
        ...(o.serviceTier ? { serviceTier: o.serviceTier } : {}),
        ...(o.windowsSandbox ? { windowsSandbox: o.windowsSandbox } : {}),
        log: (m) => process.stderr.write(`${m}\n`),
      });
      const reg = await adapter.start();
      process.stdout.write(
        `Codex ${install.version ?? ''} works for Friday as ${reg.agent_key} (${reg.harness_id}), sandbox ${o.sandbox}. Ctrl+C stops it and its work.\n`,
      );
      await new Promise<void>((resolve) => {
        const stop = () => {
          void adapter.close().finally(resolve);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
        if (process.platform === 'win32') process.once('SIGBREAK', stop);
      });
    });
}

/** `friday harness doctor codex`: what Friday would run, and the level it gives (no model call). */
export async function doctorCodex(
  g: () => GlobalOptions,
  sandbox: CodexSandbox,
  windowsSandbox?: 'elevated' | 'unelevated',
): Promise<void> {
  const report = await codexDoctor({ sandbox, ...(windowsSandbox ? { windowsSandbox } : {}) });
  out(g(), report, () => `${renderDoctor(report.checks)}\n\nEnforcement: ${report.achieved}`);
  if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
}
