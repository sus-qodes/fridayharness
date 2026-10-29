/**
 * What `friday harness config antigravity` and `friday harness doctor antigravity` do, for the
 * `friday` command to call with one line each, as it calls the other hosts' adapters. The command
 * keeps its own parsing and printing (`io`); this package keeps what is Antigravity's.
 */
import type { FileChange } from '@friday/adapter-claude';
import { FridayError } from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import { applyAntigravityPlan, planAntigravity } from './config.js';
import { findAntigravity } from './detect.js';
import { type AntigravityCheck, type AntigravityDoctorOptions, antigravityDoctor } from './doctor.js';
import { FAILURE_EVIDENCE, levelFromEvidence, levelReason } from './evidence.js';

export interface AntigravityCliIo {
  /** Prints a value: as JSON with `--json`, else the text. */
  out(value: unknown, text: () => string): void;
  /** A short line diff for `--print`. */
  diff?(before: string, after: string): string[];
  /** Renders doctor checks as the other hosts' doctors are rendered. */
  render?(checks: AntigravityCheck[]): string;
  /** Changes the command makes for every host (`.friday/.gitignore`), applied and listed with Antigravity's own. */
  extraChanges?(root: string): FileChange[];
}

export interface AntigravityConfigFlags {
  agent?: string;
  scope?: string;
  print?: boolean;
  remove?: boolean;
  claudeMd?: boolean;
  requireEnforcing?: boolean;
}

const actionOf = (c: FileChange) => (c.before === null ? 'create' : c.after === null ? 'delete' : 'update');

/** At most 80 lines of a change's diff; none for Friday's bundled launcher or private files. */
function changeDiff(c: FileChange, diff: AntigravityCliIo['diff']): string[] | null {
  if (c.after === null || c.display.endsWith('hook.mjs') || c.display.startsWith('(private)')) return null;
  const lines = c.before === null ? c.after.split('\n').map((l) => `+ ${l}`) : (diff?.(c.before, c.after) ?? []);
  return [...lines.slice(0, 80), ...(lines.length > 80 ? [`... ${lines.length - 80} more line(s)`] : [])];
}

/** `friday harness config antigravity`: writes, shows (`--print`) or removes (`--remove`) Friday's files. */
export function antigravityConfigCli(
  ref: ProjectRef,
  flags: AntigravityConfigFlags,
  io: AntigravityCliIo,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (flags.scope === 'local') {
    throw new FridayError(
      'invalid_request',
      '--scope local is for claude-code; Antigravity reads project hooks from .agents/hooks.json',
    );
  }
  if (flags.claudeMd) {
    throw new FridayError(
      'invalid_request',
      "--claude-md is for claude-code; Antigravity gets Friday's guidance in AGENTS.md",
    );
  }
  const level = levelFromEvidence(FAILURE_EVIDENCE);
  if (flags.requireEnforcing && !flags.remove && level !== 'enforcing') {
    throw new FridayError(
      'invalid_request',
      `Antigravity cannot be shown to enforce Friday's hooks yet (L1 ${level}): ${levelReason(FAILURE_EVIDENCE)}`,
    );
  }
  const found = flags.remove ? null : findAntigravity(env);
  const changes = planAntigravity({
    projectDir: ref.root,
    env,
    ...(flags.agent ? { agentKey: flags.agent } : {}),
    ...(flags.remove ? { remove: true } : {}),
  });
  if (!flags.remove) changes.push(...(io.extraChanges?.(ref.root) ?? []));
  if (!flags.print) applyAntigravityPlan(changes);
  const agentLine = changes.find((c) => c.display.startsWith('(private)'))?.note;
  const summary = {
    host: 'antigravity',
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
    antigravity: found
      ? {
          cli: found.cli ? { binary: found.cli.binary, version: found.cli.version } : null,
          app: found.app ? { binary: found.app.binary, version: found.app.version } : null,
          hook_level: level,
        }
      : null,
  };
  io.out(summary, () => {
    const lines: string[] = [];
    const verb = flags.print ? 'Would change' : flags.remove ? 'Removed' : 'Configured';
    lines.push(`${verb} Antigravity for Friday project "${ref.name}"${agentLine ? ` (${agentLine})` : ''}:`);
    if (changes.length === 0) lines.push('  nothing to change; everything is already in place');
    for (const c of changes) {
      const mark = { create: '+', update: '~', delete: '-' }[actionOf(c)];
      lines.push(`  ${mark} ${c.display.padEnd(44)} ${c.note}${c.tracked ? '' : ' (not committed)'}`);
      if (flags.print) for (const d of changeDiff(c, io.diff) ?? []) lines.push(`      ${d}`);
    }
    if (flags.remove) return lines.join('\n');
    lines.push('');
    const host = [
      found?.cli ? `Antigravity CLI ${found.cli.version ?? '(version unknown)'}` : null,
      found?.app ? `the Antigravity App ${found.app.version ?? '(version unknown)'}` : null,
    ].filter(Boolean);
    lines.push(
      `${host.length ? host.join(' and ') : 'Antigravity was not found on this machine'}: experimental. L1 ${level} once a session's hooks reach Friday: ${levelReason(FAILURE_EVIDENCE)}.`,
    );
    lines.push('There is no spawn mode: Antigravity attaches when you run it yourself.');
    if (!flags.print) {
      lines.push('Next:');
      lines.push('  1. friday run                       (in another terminal, if it is not running)');
      lines.push(
        '  2. open this folder in Antigravity (the App, agy or the IDE) and trust it: hooks run only in a trusted folder',
      );
      lines.push(
        '  3. approve the friday tools when Antigravity asks (or allow mcp(friday/*) in your Antigravity settings)',
      );
      lines.push('  4. ask the agent to call friday_whoami and take its Friday task');
      lines.push(
        'Commit .agents/hooks.json, .agents/mcp_config.json, AGENTS.md and .friday/harness/antigravity/ so teammates get the same setup.',
      );
      lines.push('Check everything with: friday harness doctor antigravity');
    }
    return lines.join('\n');
  });
}

/** `friday harness doctor antigravity`: read-only; a failed check sets the exit code. */
export async function antigravityDoctorCli(
  ref: ProjectRef,
  flags: { quick?: boolean },
  io: AntigravityCliIo,
  opts: Pick<AntigravityDoctorOptions, 'env' | 'found'> = {},
): Promise<void> {
  const report = await antigravityDoctor(ref, { ...opts, ...(flags.quick ? { skipMcp: true } : {}) });
  const render =
    io.render ??
    ((checks: AntigravityCheck[]) =>
      checks.map((c) => `[${c.status}] ${c.id} ${c.message}${c.fix ? ` (fix: ${c.fix})` : ''}`).join('\n'));
  io.out(report, () => `${render(report.checks)}\n\nEnforcement: ${report.achieved} (experimental)`);
  if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
}
