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
import { cursorRunCli, findCursorAgent } from '@friday/adapter-cursor';
import {
  findGemini,
  MIN_VERSION as GEMINI_MIN,
  geminiRunCommand,
  compareVersions as geminiVersionCompare,
} from '@friday/adapter-gemini';
import { opencodeRunCli, opencodeWorkerCli } from '@friday/adapter-opencode';
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
  /** claude-code, codex: what the agent's work costs (plan M13.3). */
  costClass?: 'free' | 'cheap' | 'standard';
  /** claude-code, codex: the only models routing may run for it, comma-separated (plan M13.3). */
  models?: string;
  /** Stop when standard input closes: the agent launcher ties the adapter's life to the daemon's. */
  parentStdin?: boolean;
  /** The host binary to run, resolved by the launcher outside the project (review SEC-12). */
  hostBin?: string;
  /** gemini: folders outside the worktree its sessions may also read. */
  includeDirectories?: string[];
  /** opencode: the model server on this machine its sessions use, and the model (plan M14.4). */
  modelUrl?: string;
  model?: string;
}

/** The cost class and models an agent declares (plan M13.3), as the adapters take them. */
function routingOptions(o: SpawnRunOptions): { costClass?: 'free' | 'cheap' | 'standard'; models?: string[] } {
  const models = (o.models ?? '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  return { ...(o.costClass ? { costClass: o.costClass } : {}), ...(models.length ? { models } : {}) };
}

/** The hosts `harness run` starts (ADR-0032 §1). */
export const SPAWN_HOSTS = ['codex', 'claude-code', 'cursor', 'gemini', 'opencode'] as const;

/**
 * Runs until a signal, or, with `--parent-stdin`, until standard input closes (plan M9 §5.12);
 * then the adapter closes its hosts and disconnects.
 */
function untilStopped(close: () => Promise<void>, parentStdin: boolean | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      void close().finally(resolve);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    if (process.platform === 'win32') process.once('SIGBREAK', stop);
    if (parentStdin) {
      process.stdin.on('end', stop);
      process.stdin.on('close', stop);
      process.stdin.resume();
    }
  });
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
 * `friday harness run codex|claude-code|cursor|gemini` (ADR-0032 §1): the host works for Friday in the
 * foreground, taking the tasks Friday gives its agent, until it is stopped; its sessions and their
 * work end with it.
 */
export function registerSpawnRun(harness: Command, g: () => GlobalOptions): void {
  harness
    .command('run <host>')
    .description(
      `work for Friday as a spawn-mode harness, in the foreground (${SPAWN_HOSTS.join(', ')}; opencode: the no-model preflight, or with --model-url and --model a worker on a model on this machine, experimental)`,
    )
    .option(
      '--agent <key>',
      'the agent this host works as (default: FRIDAY_AGENT, else codex-1, claude-1, cursor-1, gemini-1 or opencode-1)',
    )
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
    .addOption(
      new Option(
        '--cost-class <class>',
        "claude-code, codex: what this agent's work costs (else its model's class)",
      ).choices(['free', 'cheap', 'standard']),
    )
    .option('--models <ids>', 'claude-code, codex: the only models routing may run for this agent, comma-separated')
    .option('--parent-stdin', 'stop when standard input closes (used by the agent launcher)')
    .option('--host-bin <path>', 'the host binary to run, instead of finding it')
    .option('--include-directories <dirs...>', 'gemini: folders outside the worktree its sessions may also read')
    .option(
      '--model-url <url>',
      'opencode: the model server on this machine its sessions use, a loopback http address such as http://127.0.0.1:11434/v1',
    )
    .option('--model <name>', 'opencode: the model that server has, such as qwen2.5:7b')
    .action(async (host: string, o: SpawnRunOptions) => {
      if (host !== 'gemini' && o.includeDirectories?.length)
        throw new UsageError('--include-directories is for gemini');
      if ((o.modelUrl || o.model) && host !== 'opencode')
        throw new UsageError('--model-url and --model are for opencode');
      if (host === 'opencode' && Boolean(o.modelUrl) !== Boolean(o.model))
        throw new UsageError('opencode takes --model-url and --model together');
      if ((o.costClass || o.models) && host !== 'claude-code' && host !== 'codex')
        throw new UsageError('--cost-class and --models are for claude-code and codex');
      if (host === 'claude-code') return runClaudeSpawn(g, o);
      if (host === 'opencode' && o.modelUrl && o.model) {
        const { worker, message } = await opencodeWorkerCli(project(g()), {
          ...(o.agent ? { agent: o.agent } : {}),
          role: o.role,
          ...(o.hostBin ? { hostBin: o.hostBin } : {}),
          modelUrl: o.modelUrl,
          model: o.model,
        });
        process.stdout.write(`${message}\n`);
        return untilStopped(() => worker.close(), o.parentStdin);
      }
      if (host === 'opencode') return opencodeRunCli(project(g()), o, { out: (v, text) => out(g(), v, text) });
      if (host === 'cursor') return cursorRunCli(project(g()), o);
      if (host === 'gemini') {
        for (const [given, name] of [
          [o.effort, '--effort'],
          [o.serviceTier, '--service-tier'],
          [o.windowsSandbox, '--windows-sandbox'],
          [o.maxBudgetUsd, '--max-budget-usd'],
        ] as const) {
          if (given !== undefined) throw new UsageError(`${name} is not a setting Gemini CLI takes`);
        }
        return geminiRunCommand(g(), o, { UsageError, renderDoctor });
      }
      if (host !== 'codex') throw new UsageError(`spawn mode is built for ${SPAWN_HOSTS.join(', ')}; ${host} is not`);
      const ref = project(g());
      const found = findCodex();
      const install = o.hostBin ? { ...found, binary: o.hostBin } : found;
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
        ...routingOptions(o),
        log: (m) => process.stderr.write(`${m}\n`),
      });
      const reg = await adapter.start();
      process.stdout.write(
        `Codex ${install.version ?? ''} works for Friday as ${reg.agent_key} (${reg.harness_id}), sandbox ${o.sandbox}. Ctrl+C stops it and its work.\n`,
      );
      await untilStopped(() => adapter.close(), o.parentStdin);
    });

  harness
    .command('hosts')
    .description('the coding hosts Friday can start on this machine (used by the agent launcher)')
    .action(() => {
      const claude = detectClaudeCode();
      const codex = findCodex();
      const cursor = findCursorAgent();
      const gemini = findGemini();
      const hosts = [
        {
          host: 'claude-code',
          found: Boolean(claude),
          version: claude?.version ?? null,
          supported: Boolean(claude?.version && compareVersions(claude.version, SPAWN_MIN) >= 0),
          path: claude?.binary ?? null,
          reason: !claude
            ? 'Claude Code was not found (PATH, CLAUDE_CODE_BIN, the VS Code extension)'
            : claude.version && compareVersions(claude.version, SPAWN_MIN) < 0
              ? `spawn mode needs Claude Code ${SPAWN_MIN} or newer; this is ${claude.version}`
              : null,
        },
        {
          host: 'codex',
          found: Boolean(codex.binary),
          version: codex.version ?? null,
          supported: Boolean(codex.binary),
          path: codex.binary ?? null,
          reason: codex.binary ? null : (codex.problem ?? 'Codex was not found'),
        },
        // Found from their install folders; neither is started to be found (plan M8b).
        {
          host: 'cursor',
          found: Boolean(cursor.binary),
          version: cursor.version ?? null,
          supported: Boolean(cursor.binary),
          path: cursor.binary ?? null,
          reason: cursor.binary ? null : (cursor.problem ?? 'the Cursor CLI was not found'),
        },
        {
          host: 'gemini',
          found: Boolean(gemini.command),
          version: gemini.version ?? null,
          supported: Boolean(
            gemini.command && (!gemini.version || geminiVersionCompare(gemini.version, GEMINI_MIN) >= 0),
          ),
          // What `--host-bin` hands back to GEMINI_CLI_BIN: the package folder, else its entry script or executable.
          path: gemini.packageDir ?? gemini.args[0] ?? gemini.command ?? null,
          reason: !gemini.command
            ? (gemini.problem ?? 'Gemini CLI was not found')
            : gemini.version && geminiVersionCompare(gemini.version, GEMINI_MIN) < 0
              ? `spawn mode needs Gemini CLI ${GEMINI_MIN} or newer; this is ${gemini.version}`
              : null,
        },
      ];
      out(g(), { hosts }, () =>
        hosts
          .map((h) => `${h.host.padEnd(12)} ${h.found ? (h.version ?? '?') : '-'}  ${h.reason ?? h.path ?? ''}`)
          .join('\n'),
      );
    });
}

/**
 * `friday harness run claude-code` (ADR-0032 §11): the installed Claude Code, started headless for
 * each run attempt in the task's worktree, restricted to the tools Friday's hooks judge.
 */
async function runClaudeSpawn(g: () => GlobalOptions, o: SpawnRunOptions): Promise<void> {
  const ref = project(g());
  const found = detectClaudeCode();
  const install = o.hostBin ? { binary: o.hostBin, version: found?.version ?? null, source: 'PATH' as const } : found;
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
    ...routingOptions(o),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const reg = await adapter.start();
  process.stdout.write(
    `Claude Code ${install.version ?? ''} works for Friday as ${reg.agent_key} (${reg.harness_id}), restricted to the tools Friday's hooks judge. Ctrl+C stops it and its work.\n`,
  );
  await untilStopped(() => adapter.close(), o.parentStdin);
}

/** `friday harness doctor codex`: what Friday would run, and the level it gives (no model call). */
export async function doctorCodex(
  g: () => GlobalOptions,
  sandbox: CodexSandbox,
  windowsSandbox?: 'elevated' | 'unelevated',
): Promise<Awaited<ReturnType<typeof codexDoctor>>> {
  const report = await codexDoctor({ sandbox, ...(windowsSandbox ? { windowsSandbox } : {}) });
  out(g(), report, () => `${renderDoctor(report.checks)}\n\nEnforcement: ${report.achieved}`);
  if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  return report;
}
