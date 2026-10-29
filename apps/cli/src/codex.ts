import path from 'node:path';
import {
  bundledHookPath,
  ClaudeSpawnAdapter,
  claudeEnvironment,
  compareVersions,
  detectClaudeCode,
  SPAWN_MIN,
} from '@friday/adapter-claude';
import { CodexAdapter, type CodexSandbox, codexDoctor, findCodex, hostEnvironment } from '@friday/adapter-codex';
import { DaemonClient, type ProjectRef, privateDirFor } from '@friday/sdk';
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
  maxBudgetUsd?: string;
}

/**
 * An adapter's own folder in the project's private state folder: how an attempt ended waits there
 * until Friday records it, across restarts of the adapter (ADR-0032 §1, review M8-R05).
 */
function adapterState(ref: ProjectRef, vendor: string, agentKey: string): string {
  return path.join(privateDirFor(ref), 'adapters', `${vendor}-${agentKey.replace(/[^A-Za-z0-9_.-]/g, '_')}`);
}

/** A spending cap given on the command line, in dollars. */
function budgetOf(text: string): number {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--max-budget-usd takes a positive amount, not ${text}`);
  return n;
}

/**
 * `friday harness run codex|claude-code` (ADR-0032 §1): the host works for Friday in the
 * foreground, taking the tasks Friday gives its agent, until it is stopped; its sessions and their
 * work end with it.
 */
export function registerSpawnRun(harness: Command, g: () => GlobalOptions): void {
  harness
    .command('run <host>')
    .description('work for Friday as a spawn-mode harness, in the foreground (codex, claude-code)')
    .option('--agent <key>', 'the agent this host works as (default: FRIDAY_AGENT, else codex-1 or claude-1)')
    .option('--role <role>', 'its role, which delegation matches tasks against', 'developer')
    .addOption(
      new Option('--sandbox <mode>', 'codex: the sandbox Codex runs its commands in')
        .choices([...SANDBOXES])
        .default('workspace-write'),
    )
    .option('--effort <level>', 'reasoning effort for its turns (the host default otherwise)')
    .option(
      '--service-tier <tier>',
      'codex: service tier of its threads: default (standard speed) or priority (your Codex setting otherwise)',
    )
    .addOption(
      new Option(
        '--windows-sandbox <mode>',
        "codex: the Windows sandbox its commands run in: elevated needs an administrator's setup, unelevated does not (your Codex setting otherwise)",
      ).choices(['elevated', 'unelevated']),
    )
    .option('--max-budget-usd <amount>', "claude-code: a spending cap for each run attempt's session")
    .action(async (host: string, o: SpawnRunOptions) => {
      if (host === 'claude-code') return runClaudeSpawn(g, o);
      if (host !== 'codex') throw new UsageError(`spawn mode is built for codex and claude-code; ${host} is not`);
      const ref = project(g());
      const install = findCodex();
      if (!install.binary) throw new UsageError(install.problem ?? 'Codex was not found');
      const agentKey = o.agent ?? process.env.FRIDAY_AGENT ?? 'codex-1';
      const adapter = new CodexAdapter({
        bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'friday-codex' }),
        projectId: ref.project_id,
        agentKey,
        role: o.role,
        stateDir: adapterState(ref, 'codex', agentKey),
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

/**
 * `friday harness run claude-code` (ADR-0032 §11): the installed Claude Code, started headless for
 * each run attempt in the task's worktree, restricted to the tools Friday's hooks judge.
 */
async function runClaudeSpawn(g: () => GlobalOptions, o: SpawnRunOptions): Promise<void> {
  const ref = project(g());
  const install = detectClaudeCode();
  if (!install) throw new UsageError('Claude Code was not found (PATH, CLAUDE_CODE_BIN, the VS Code extension)');
  if (install.version && compareVersions(install.version, SPAWN_MIN) < 0) {
    throw new UsageError(
      `spawn mode needs Claude Code ${SPAWN_MIN} or newer (its restricted headless mode); this is ${install.version}`,
    );
  }
  const agentKey = o.agent ?? process.env.FRIDAY_AGENT ?? 'claude-1';
  const adapter = new ClaudeSpawnAdapter({
    bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'friday-claude-spawn' }),
    projectId: ref.project_id,
    agentKey,
    role: o.role,
    stateDir: adapterState(ref, 'claude-code', agentKey),
    host: { command: install.binary, ...(install.version ? { version: install.version } : {}) },
    hostEnv: claudeEnvironment(),
    hook: { command: process.execPath, args: [bundledHookPath()] },
    ...(o.effort ? { effort: o.effort } : {}),
    ...(o.maxBudgetUsd ? { maxBudgetUsd: budgetOf(o.maxBudgetUsd) } : {}),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const reg = await adapter.start();
  process.stdout.write(
    `Claude Code ${install.version ?? ''} works for Friday as ${reg.agent_key} (${reg.harness_id}), restricted to the tools Friday's hooks judge. Ctrl+C stops it and its work.\n`,
  );
  await new Promise<void>((resolve) => {
    const stop = () => {
      void adapter.close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (process.platform === 'win32') process.once('SIGBREAK', stop);
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
