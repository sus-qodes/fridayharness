/**
 * What `friday harness config|doctor|run gemini` do (plan M8b.4), for the `friday` command to call
 * with one line each, as it calls the other hosts' adapters: the command keeps its own parsing,
 * and this package keeps what is Gemini CLI's.
 */
import path from 'node:path';
import type { FileChange } from '@friday/adapter-claude';
import { DaemonClient, loadProject, type ProjectRef, privateDirFor } from '@friday/sdk';
import { GeminiSpawnAdapter } from './adapter.js';
import { applyGeminiPlan, planGemini } from './config.js';
import { compareVersions, findGemini, geminiEnvironment, MIN_VERSION } from './detect.js';
import { geminiDoctor, LEVEL_NOTE } from './doctor.js';

/** What the CLI lends these commands: its error for a misused command, and its doctor renderer. */
export interface GeminiCliParts {
  UsageError: new (message: string) => Error;
  renderDoctor: (
    checks: { id: string; status: 'ok' | 'warn' | 'fail' | 'info'; message: string; fix?: string }[],
  ) => string;
}

/** The root program's options. */
export interface GeminiGlobals {
  project?: string;
  json?: boolean;
}

const out = (g: GeminiGlobals, value: unknown, human: () => string) => {
  process.stdout.write(`${g.json ? JSON.stringify(value, null, 2) : human()}\n`);
};

/** Runs until a signal, or, with `--parent-stdin`, until standard input closes (the agent launcher). */
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

/** The adapter's own folder in the project's private state folder (ADR-0032 §1, review M8-R05). */
const adapterState = (ref: ProjectRef, agentKey: string) =>
  path.join(privateDirFor(ref), 'adapters', `gemini-${agentKey.replace(/[^A-Za-z0-9_.-]/g, '_')}`);

const actionOf = (c: { before: string | null; after: string | null }) =>
  c.before === null ? 'create' : c.after === null ? 'delete' : 'update';

/**
 * `friday harness config gemini [--print] [--remove] [--agent <key>] [--no-gemini-md]`.
 * `extraChanges`: what the command changes for every host (`.friday/.gitignore`), applied and
 * listed with Gemini CLI's own.
 */
export function geminiConfigCommand(
  g: GeminiGlobals,
  o: { agent?: string; print?: boolean; remove?: boolean; geminiMd?: boolean },
  extraChanges?: (root: string) => FileChange[],
): void {
  const ref = loadProject(g.project);
  const changes = planGemini({
    projectDir: ref.root,
    ...(o.agent ? { agentKey: o.agent } : {}),
    ...(o.remove ? { remove: true } : {}),
    ...(o.geminiMd === false ? { geminiMd: false } : {}),
  });
  if (!o.remove) changes.push(...(extraChanges?.(ref.root) ?? []));
  if (!o.print) applyGeminiPlan(changes, ref.root);
  const install = findGemini();
  const summary = {
    host: 'gemini',
    applied: !o.print,
    removed: Boolean(o.remove),
    experimental: true,
    changes: changes.map((c) => ({ path: c.display, action: actionOf(c), tracked: c.tracked, note: c.note })),
    gemini_cli: install.command ? { version: install.version, source: install.source } : null,
    level: LEVEL_NOTE,
  };
  out(g, summary, () => {
    const verb = o.print ? 'Would change' : o.remove ? 'Removed' : 'Configured';
    const agentLine = changes.find((c) => c.display.startsWith('(private)'))?.note;
    const lines = [`${verb} Gemini CLI for Friday project "${ref.name}"${agentLine ? ` (${agentLine})` : ''}:`];
    if (!changes.length) lines.push('  nothing to change; everything is already in place');
    for (const c of changes) {
      const mark = { create: '+', update: '~', delete: '-' }[actionOf(c)];
      lines.push(`  ${mark} ${c.display.padEnd(44)} ${c.note}${c.tracked ? '' : ' (not committed)'}`);
    }
    if (o.remove) return lines.join('\n');
    lines.push('');
    lines.push(
      install.command
        ? `Gemini CLI ${install.version ?? '(version unknown)'} (${install.source}).`
        : 'Gemini CLI was not found on this machine (npm install -g @google/gemini-cli).',
    );
    lines.push(`Level: ${LEVEL_NOTE}.`);
    lines.push('Experimental: the live check with your own key is still to do (docs/integration/gemini-cli.md).');
    if (!o.print) {
      lines.push('Next:');
      lines.push('  1. friday run                       (in another terminal, if it is not running)');
      lines.push("  2. start gemini in this folder (the project's root); trust the folder when it asks");
      lines.push('  3. ask it to start with friday_whoami');
      lines.push(
        'Commit .gemini/settings.json, GEMINI.md and .friday/harness/gemini/ so teammates and task worktrees get them.',
      );
      lines.push('Check everything with: friday harness doctor gemini');
    }
    return lines.join('\n');
  });
}

/** `friday harness doctor gemini [--quick]`: works outside a project too (the host only). */
export async function geminiDoctorCommand(
  g: GeminiGlobals,
  o: { quick?: boolean },
  parts: GeminiCliParts,
): Promise<void> {
  let ref: ProjectRef | null = null;
  try {
    ref = loadProject(g.project);
  } catch {
    ref = null;
  }
  const report = await geminiDoctor(ref, { ...(o.quick ? { quick: true } : {}) });
  out(g, report, () => `${parts.renderDoctor(report.checks)}\n\nEnforcement achieved: ${report.achieved}`);
  if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
}

/** `friday harness run gemini`: Gemini CLI works for Friday in the foreground until it is stopped. */
export async function geminiRunCommand(
  g: GeminiGlobals,
  o: { agent?: string; role?: string; hostBin?: string; parentStdin?: boolean; includeDirectories?: string[] },
  parts: GeminiCliParts,
): Promise<void> {
  const ref = loadProject(g.project);
  const install = findGemini(o.hostBin ? { ...process.env, GEMINI_CLI_BIN: o.hostBin } : process.env);
  if (!install.command) throw new parts.UsageError(install.problem ?? 'Gemini CLI was not found');
  if (install.version && compareVersions(install.version, MIN_VERSION) < 0) {
    throw new parts.UsageError(`spawn mode needs Gemini CLI ${MIN_VERSION} or newer; this is ${install.version}`);
  }
  const agentKey = o.agent ?? process.env.FRIDAY_AGENT ?? 'gemini-1';
  const adapter = new GeminiSpawnAdapter({
    bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'friday-gemini' }),
    projectId: ref.project_id,
    agentKey,
    role: o.role ?? 'developer',
    stateDir: adapterState(ref, agentKey),
    host: { command: install.command, args: install.args, ...(install.version ? { version: install.version } : {}) },
    hostEnv: geminiEnvironment(),
    ...(o.includeDirectories?.length ? { includeDirectories: o.includeDirectories.map((d) => path.resolve(d)) } : {}),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const reg = await adapter.start();
  process.stdout.write(
    `Gemini CLI ${install.version ?? ''} works for Friday as ${reg.agent_key} (${reg.harness_id}), every tool call through Friday's hooks (fail-open: a failing hook lets a call through). Experimental. Ctrl+C stops it and its work.\n`,
  );
  await untilStopped(() => adapter.close(), o.parentStdin);
}
