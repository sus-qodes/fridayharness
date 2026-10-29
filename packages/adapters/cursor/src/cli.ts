/**
 * What `friday harness config|doctor|run cursor` do, for the `friday` command to call with one line
 * each. The command keeps its own parsing and printing (`io`); this package keeps what is Cursor's.
 */
import path from 'node:path';
import { bundledHookPath, compareVersions, type FileChange } from '@friday/adapter-claude';
import { FridayError } from '@friday/protocol';
import { DaemonClient, type ProjectRef, privateDirFor } from '@friday/sdk';
import { CursorSpawnAdapter } from './adapter.js';
import { applyCursorPlan, planCursor } from './config.js';
import { cursorEnvironment, findCursorAgent, findCursorIde } from './detect.js';
import { type CursorCheck, cursorDoctor, PRE_TOOL_USE_MIN } from './doctor.js';

export interface CursorCliIo {
  /** Prints a value: as JSON with `--json`, else the text. */
  out(value: unknown, text: () => string): void;
  /** A short line diff for `--print`. */
  diff?(before: string, after: string): string[];
  /** Renders doctor checks as the other hosts' doctors are rendered. */
  render?(checks: CursorCheck[]): string;
  /** Changes the command makes for every host (`.friday/.gitignore`), applied and listed with Cursor's own. */
  extraChanges?(root: string): FileChange[];
}

export interface CursorConfigFlags {
  agent?: string;
  scope?: string;
  print?: boolean;
  remove?: boolean;
  claudeMd?: boolean;
  requireEnforcing?: boolean;
}

const actionOf = (c: FileChange) => (c.before === null ? 'create' : c.after === null ? 'delete' : 'update');

/** At most 80 lines of a change's diff; none for Friday's bundled launcher or private files. */
function changeDiff(c: FileChange, diff: CursorCliIo['diff']): string[] | null {
  if (c.after === null || c.display.endsWith('hook.mjs') || c.display.startsWith('(private)')) return null;
  const lines = c.before === null ? c.after.split('\n').map((l) => `+ ${l}`) : (diff?.(c.before, c.after) ?? []);
  return [...lines.slice(0, 80), ...(lines.length > 80 ? [`... ${lines.length - 80} more line(s)`] : [])];
}

/** `friday harness config cursor`: writes, shows (`--print`) or removes (`--remove`) Friday's Cursor files. */
export function cursorConfigCli(ref: ProjectRef, flags: CursorConfigFlags, io: CursorCliIo): void {
  if (flags.scope === 'local') {
    throw new FridayError(
      'invalid_request',
      '--scope local is for claude-code; Cursor reads project hooks from .cursor/hooks.json',
    );
  }
  if (flags.claudeMd) {
    throw new FridayError(
      'invalid_request',
      "--claude-md is for claude-code; Cursor gets Friday's rule in .cursor/rules/friday.mdc",
    );
  }
  const ide = flags.remove ? null : findCursorIde();
  const cli = flags.remove ? null : findCursorAgent();
  if (flags.requireEnforcing && !flags.remove && ide?.version && compareVersions(ide.version, PRE_TOOL_USE_MIN) < 0) {
    throw new FridayError(
      'invalid_request',
      `Cursor ${ide.version} has no preToolUse hook, so Friday's hooks would not see every tool; install ${PRE_TOOL_USE_MIN} or newer`,
    );
  }
  const changes = planCursor({
    projectDir: ref.root,
    ...(flags.agent ? { agentKey: flags.agent } : {}),
    ...(flags.remove ? { remove: true } : {}),
  });
  if (!flags.remove) changes.push(...(io.extraChanges?.(ref.root) ?? []));
  if (!flags.print) applyCursorPlan(changes, ref.root);
  const agentLine = changes.find((c) => c.display.startsWith('(private)'))?.note;
  const summary = {
    host: 'cursor',
    experimental: true,
    applied: !flags.print,
    removed: Boolean(flags.remove),
    changes: changes.map((c) => ({
      path: c.display,
      action: actionOf(c),
      tracked: c.tracked,
      note: c.note,
      diff: changeDiff(c, io.diff)?.join('\n') ?? null,
    })),
    cursor: flags.remove
      ? null
      : {
          ide: ide ? { dir: ide.dir, version: ide.version } : null,
          cli: cli?.binary || cli?.versions.length ? { binary: cli.binary, version: cli.version } : null,
        },
  };
  io.out(summary, () => {
    const lines: string[] = [];
    const verb = flags.print ? 'Would change' : flags.remove ? 'Removed' : 'Configured';
    lines.push(`${verb} Cursor for Friday project "${ref.name}"${agentLine ? ` (${agentLine})` : ''}:`);
    if (changes.length === 0) lines.push('  nothing to change; everything is already in place');
    for (const c of changes) {
      const mark = { create: '+', update: '~', delete: '-' }[actionOf(c)];
      lines.push(`  ${mark} ${c.display.padEnd(44)} ${c.note}${c.tracked ? '' : ' (not committed)'}`);
      if (flags.print) for (const d of changeDiff(c, io.diff) ?? []) lines.push(`      ${d}`);
    }
    if (flags.remove) return lines.join('\n');
    lines.push('');
    const host = [
      ide ? `Cursor ${ide.version ?? '(version unknown)'}` : null,
      cli?.binary || cli?.versions.length ? `Cursor CLI ${cli.version ?? '(version unknown)'}` : null,
    ].filter(Boolean);
    lines.push(host.length ? `Found ${host.join(' and ')}.` : 'Cursor was not found on this machine.');
    lines.push(
      "Friday's Cursor adapter is experimental: L1 enforcing once a session's hooks reach Friday on Cursor 3.24 or later, since Friday's permission hooks fail closed; unverified on an older Cursor or one whose version is not known (when Cursor added failClosed is not documented).",
    );
    if (!flags.print) {
      lines.push('Next:');
      lines.push('  1. friday run                       (in another terminal, if it is not running)');
      lines.push('  2. open this folder in Cursor; trust the workspace and approve the "friday" MCP server');
      lines.push('  3. ask the agent to call friday_whoami and take its Friday task');
      lines.push(
        'Commit .cursor/hooks.json, .cursor/mcp.json, .cursor/rules/friday.mdc and .friday/harness/cursor/ so teammates get the same setup.',
      );
      lines.push(
        "Cursor also runs Claude Code's hooks from .claude/settings.json by default; with these hooks in place Friday's launcher answers nothing there, so each call is judged once.",
      );
      lines.push('Check everything with: friday harness doctor cursor');
    }
    return lines.join('\n');
  });
}

/** `friday harness doctor cursor`: read-only; a failed check sets the exit code. */
export async function cursorDoctorCli(ref: ProjectRef, flags: { quick?: boolean }, io: CursorCliIo): Promise<void> {
  const report = await cursorDoctor(ref, { ...(flags.quick ? { skipMcp: true } : {}) });
  const render =
    io.render ??
    ((checks: CursorCheck[]) =>
      checks.map((c) => `[${c.status}] ${c.id} ${c.message}${c.fix ? ` (fix: ${c.fix})` : ''}`).join('\n'));
  io.out(report, () => `${render(report.checks)}\n\nEnforcement: ${report.achieved} (experimental)`);
  if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
}

export interface CursorRunFlags {
  agent?: string;
  role?: string;
  effort?: string;
  serviceTier?: string;
  windowsSandbox?: string;
  maxBudgetUsd?: string;
  /** Stop when standard input closes: the agent launcher ties the adapter's life to the daemon's. */
  parentStdin?: boolean;
  /** The CLI executable to run, instead of finding it. */
  hostBin?: string;
}

/**
 * Runs until a signal, or, with `--parent-stdin`, until standard input closes; then the adapter
 * ends its sessions and disconnects.
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

/** `friday harness run cursor`: the Cursor CLI works for Friday in the foreground until it is stopped. */
export async function cursorRunCli(
  ref: ProjectRef,
  flags: CursorRunFlags,
  write: (text: string) => void = (t) => process.stdout.write(t),
): Promise<void> {
  for (const [given, name] of [
    [flags.effort, '--effort'],
    [flags.serviceTier, '--service-tier'],
    [flags.windowsSandbox, '--windows-sandbox'],
    [flags.maxBudgetUsd, '--max-budget-usd'],
  ] as const) {
    if (given !== undefined) throw new FridayError('invalid_request', `${name} is not a setting the Cursor CLI takes`);
  }
  const found = findCursorAgent();
  const binary = flags.hostBin ?? found.binary;
  if (!binary) throw new FridayError('invalid_request', found.problem ?? 'the Cursor CLI was not found');
  const agentKey = flags.agent ?? process.env.FRIDAY_AGENT ?? 'cursor-1';
  const adapter = new CursorSpawnAdapter({
    bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'friday-cursor' }),
    projectId: ref.project_id,
    agentKey,
    ...(flags.role ? { role: flags.role } : {}),
    // The adapter's own folder in the project's private state: how an attempt ended waits there (review M8-R05).
    stateDir: path.join(privateDirFor(ref), 'adapters', `cursor-${agentKey.replace(/[^A-Za-z0-9_.-]/g, '_')}`),
    host: { command: binary, ...(found.version ? { version: found.version } : {}) },
    hostEnv: cursorEnvironment(),
    hook: { command: process.execPath, args: [bundledHookPath()] },
    log: (m) => process.stderr.write(`${m}\n`),
  });
  const reg = await adapter.start();
  write(
    `Cursor CLI ${found.version ?? ''} works for Friday as ${reg.agent_key} (${reg.harness_id}), experimental: Friday's hooks judge each run's tool calls. Ctrl+C stops it and its work.\n`,
  );
  await untilStopped(() => adapter.close(), flags.parentStdin);
}
