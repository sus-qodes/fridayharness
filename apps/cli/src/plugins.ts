/**
 * Registers adapter-provided commands, doctor checks and daemon extensions (plan M1.6, M1.10).
 * Imported for its side effects by the `friday` entry point and by `@friday/cli`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { antigravityConfigCli, antigravityDoctorCli } from '@friday/adapter-antigravity';
import {
  applyPlan,
  claudeCodeHooks,
  claudeDoctor,
  detectClaudeCode,
  type FileChange,
  hookLevel,
  planClaudeCode,
} from '@friday/adapter-claude';
import { cursorConfigCli, cursorDoctor, cursorDoctorCli } from '@friday/adapter-cursor';
import { geminiConfigCommand, geminiDoctor, geminiDoctorCommand } from '@friday/adapter-gemini';
import { newId } from '@friday/protocol';
import { type Command, Option } from 'commander';
import { createAgentLauncher } from './agent-launcher.js';
import { claudeSetupExtension } from './claude-setup-ext.js';
import { doctorCodex, registerSpawnRun } from './codex.js';
import { type GlobalOptions, out, project, UsageError } from './context.js';
import { extraDoctorChecks, renderDoctor } from './doctor.js';
import { materializeFixtureShop } from './fixture.js';
import { commandPlugins } from './program.js';
import { daemonPlugins } from './run.js';
import { FRIDAY_DIR_GITIGNORE } from './templates.js';

/**
 * The hosts `harness config` and `harness doctor` serve, each by its own adapter (plan M8b);
 * `harness doctor` also checks codex, a spawn-mode host with nothing to write into the project.
 */
const CONFIG_HOSTS = ['claude-code', 'cursor', 'antigravity', 'gemini'] as const;

function requireHost(host: string): void {
  if (host !== 'claude-code') {
    throw new UsageError(
      `unsupported host "${host}": this command configures ${CONFIG_HOSTS.join(', ')}; codex works as a spawn-mode harness and needs no files in the project (friday harness run codex)`,
    );
  }
}

/** What `harness config <host>` changes for every host besides the host's own files. */
const sharedChanges = (root: string): FileChange[] => {
  const gi = gitignoreChange(root);
  return gi ? [gi] : [];
};

/** How a host adapter's own `harness config|doctor <host>` prints (plan M8b): as every other command does. */
const hostIo = (g: () => GlobalOptions) => ({
  out: (value: unknown, text: () => string) => out(g(), value, text),
  diff: lineDiff,
  render: renderDoctor,
  extraChanges: sharedChanges,
});

/** Appendix 4 item 9: make sure `.friday/.gitignore` lists every runtime path (append-only). */
function gitignoreChange(root: string): FileChange | null {
  const file = path.join(root, '.friday', '.gitignore');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const have = new Set((before ?? '').split(/\r?\n/).map((l) => l.trim()));
  const missing = FRIDAY_DIR_GITIGNORE.split('\n').filter((l) => l.startsWith('/') && !have.has(l));
  if (before !== null && missing.length === 0) return null;
  const after =
    before === null ? FRIDAY_DIR_GITIGNORE : `${before}${before.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`;
  return {
    path: file,
    display: '.friday/.gitignore',
    before,
    after,
    tracked: true,
    note: 'keeps Friday runtime files out of git',
    owned: false,
  };
}

/** Small line diff for `--print` (files here are short; LCS is fine). */
export function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // lcs(i, j): length of the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  const lcs = (i: number, j: number) => table[i * width + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i -= 1)
    for (let j = b.length - 1; j >= 0; j -= 1)
      table[i * width + j] = a[i] === b[j] ? lcs(i + 1, j + 1) + 1 : Math.max(lcs(i + 1, j), lcs(i, j + 1));
  const outLines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (j < b.length && (i >= a.length || lcs(i, j + 1) >= lcs(i + 1, j))) {
      outLines.push(`+ ${b[j]}`);
      j += 1;
    } else {
      outLines.push(`- ${a[i]}`);
      i += 1;
    }
  }
  return outLines;
}

const actionOf = (c: FileChange) => (c.before === null ? 'create' : c.after === null ? 'delete' : 'update');

function registerHarness(program: Command): void {
  const g = (): GlobalOptions => program.opts<GlobalOptions>();
  const harness = program.command('harness').description('connect coding harnesses to this project');

  harness
    .command('config <host>')
    .description(
      `write Friday hooks, the friday MCP server entry and Friday guidance for a host (${CONFIG_HOSTS.join(', ')})`,
    )
    .option('--agent <key>', 'agent identity on this machine (default: the current one, else dev-1)')
    .addOption(new Option('--scope <scope>', 'where the hooks go').choices(['project', 'local']).default('project'))
    .option('--print', 'show what would change, without writing anything')
    .option('--remove', 'remove everything Friday added for this host')
    .option('--claude-md', 'also add a short Friday block to CLAUDE.md')
    .option('--require-enforcing', 'refuse unless Claude Code can enforce hooks (2.1.295 or newer)')
    .option('--no-gemini-md', 'gemini: leave GEMINI.md alone')
    .action(
      (
        host: string,
        opts: {
          agent?: string;
          scope: 'project' | 'local';
          print?: boolean;
          remove?: boolean;
          claudeMd?: boolean;
          requireEnforcing?: boolean;
          geminiMd?: boolean;
        },
      ) => {
        if (host !== 'gemini' && opts.geminiMd === false) throw new UsageError('--no-gemini-md is for gemini');
        if (host === 'antigravity') return antigravityConfigCli(project(g()), opts, hostIo(g));
        if (host === 'cursor') return cursorConfigCli(project(g()), opts, hostIo(g));
        if (host === 'gemini') {
          for (const [given, name] of [
            [opts.scope === 'local', '--scope local'],
            [opts.claudeMd, '--claude-md'],
            [opts.requireEnforcing, '--require-enforcing'],
          ] as const) {
            if (given)
              throw new UsageError(
                `${name} is for claude-code; Gemini CLI reads project hooks from .gemini/settings.json`,
              );
          }
          return geminiConfigCommand(g(), opts, sharedChanges);
        }
        requireHost(host);
        const ref = project(g());
        const install = opts.remove ? null : detectClaudeCode();
        const level = hookLevel(install?.version ?? null);
        if (opts.requireEnforcing && !opts.remove && level !== 'enforcing') {
          throw new UsageError(
            `Claude Code ${install?.version ?? '(not found)'} cannot enforce Friday hooks (${level}); install 2.1.295 or newer`,
          );
        }
        const changes = planClaudeCode({
          projectDir: ref.root,
          scope: opts.scope,
          ...(opts.agent ? { agentKey: opts.agent } : {}),
          ...(opts.claudeMd ? { claudeMd: true } : {}),
          ...(opts.remove ? { remove: true } : {}),
        });
        const gi = opts.remove ? null : gitignoreChange(ref.root);
        if (gi) changes.push(gi);
        if (!opts.print) applyPlan(changes);
        const agentLine = changes.find((c) => c.display.startsWith('(private)'))?.note;
        const summary = {
          host,
          applied: !opts.print,
          removed: Boolean(opts.remove),
          changes: changes.map((c) => ({
            path: c.display,
            action: actionOf(c),
            tracked: c.tracked,
            note: c.note,
            // A short line diff, so an interface can show what changes before it applies (plan M9 §5.10).
            diff: changeDiff(c),
          })),
          claude_code: install ? { version: install.version, source: install.source, hook_level: level } : null,
        };
        out(g(), summary, () => {
          const lines: string[] = [];
          const verb = opts.print ? 'Would change' : opts.remove ? 'Removed' : 'Configured';
          lines.push(`${verb} Claude Code for Friday project "${ref.name}"${agentLine ? ` (${agentLine})` : ''}:`);
          if (changes.length === 0) lines.push('  nothing to change; everything is already in place');
          for (const c of changes) {
            const mark = { create: '+', update: '~', delete: '-' }[actionOf(c)];
            lines.push(`  ${mark} ${c.display.padEnd(44)} ${c.note}${c.tracked ? '' : ' (not committed)'}`);
            if (
              opts.print &&
              c.after !== null &&
              !c.display.endsWith('hook.mjs') &&
              !c.display.startsWith('(private)')
            ) {
              const diff = c.before === null ? c.after.split('\n').map((l) => `+ ${l}`) : lineDiff(c.before, c.after);
              for (const d of diff.slice(0, 80)) lines.push(`      ${d}`);
              if (diff.length > 80) lines.push(`      ... ${diff.length - 80} more line(s)`);
            }
          }
          if (opts.remove) return lines.join('\n');
          lines.push('');
          lines.push(
            install
              ? `Claude Code ${install.version} (${install.source}): ${level === 'enforcing' ? 'L1 enforcing, hooks fail closed' : `${level}; 2.1.295 or newer enforces hooks`}`
              : 'Claude Code was not found on this machine (PATH, CLAUDE_CODE_BIN, VS Code extension).',
          );
          if (!opts.print) {
            lines.push('Next:');
            lines.push('  1. friday run                       (in another terminal, if it is not running)');
            lines.push('  2. open this folder in Claude Code; accept the folder-trust and "friday" MCP server prompts');
            lines.push('  3. ask Claude: /friday start');
            lines.push(
              'Commit .mcp.json, .claude/settings.json, .claude/skills/friday/ and .friday/harness/ so teammates get the same setup.',
            );
            lines.push('Check everything with: friday harness doctor claude-code');
          }
          return lines.join('\n');
        });
      },
    );

  harness
    .command('doctor <host>')
    .description('check that a host is wired to Friday and which enforcement level it reaches (read-only)')
    .option('--quick', 'skip starting the MCP server')
    .addOption(
      new Option('--sandbox <mode>', 'codex: the sandbox its threads would run with')
        .choices(['read-only', 'workspace-write', 'danger-full-access'])
        .default('workspace-write'),
    )
    .addOption(
      new Option(
        '--windows-sandbox <mode>',
        'codex: the Windows sandbox its commands would run in (your Codex setting otherwise)',
      ).choices(['elevated', 'unelevated']),
    )
    .action(
      async (
        host: string,
        opts: {
          quick?: boolean;
          sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
          windowsSandbox?: 'elevated' | 'unelevated';
        },
      ) => {
        // A spawn-mode host writes nothing into the project: its doctor checks the host itself (ADR-0032).
        if (host === 'codex') return doctorCodex(g, opts.sandbox, opts.windowsSandbox);
        if (host === 'antigravity') return antigravityDoctorCli(project(g()), opts, hostIo(g));
        if (host === 'cursor') return cursorDoctorCli(project(g()), opts, hostIo(g));
        if (host === 'gemini') return geminiDoctorCommand(g(), opts, { UsageError, renderDoctor });
        requireHost(host);
        const ref = project(g());
        const report = await claudeDoctor(ref, { ...(opts.quick ? { skipMcp: true } : {}) });
        out(g(), report, () => `${renderDoctor(report.checks)}\n\nEnforcement achieved: ${report.achieved}`);
        if (report.checks.some((c) => c.status === 'fail')) process.exitCode = 1;
      },
    );

  registerSpawnRun(harness, g);
}

function registerFixture(program: Command): void {
  const g = (): GlobalOptions => program.opts<GlobalOptions>();
  program
    .command('fixture')
    .description('development fixtures')
    .command('init <dir>')
    .description('create a copy of fixture-shop (a small git repository already set up for Friday)')
    .action((dir: string) => {
      const res = materializeFixtureShop(dir, { projectId: newId('proj') });
      out(g(), res, () =>
        [
          `Created fixture-shop at ${res.root} (project ${res.project_id}, HEAD ${res.head.slice(0, 12)})`,
          'It is already a Friday project. Next:',
          `  cd ${res.root}`,
          '  friday run',
          '  friday harness config claude-code --agent dev-1',
        ].join('\n'),
      );
    });
}

/** At most 80 lines of a change's diff; none for Friday's bundled launcher or private files. */
function changeDiff(c: { display: string; before: string | null; after: string | null }): string | null {
  if (c.after === null || c.display.endsWith('hook.mjs') || c.display.startsWith('(private)')) return null;
  const diff = c.before === null ? c.after.split('\n').map((l) => `+ ${l}`) : lineDiff(c.before, c.after);
  const more = diff.length > 80 ? [`... ${diff.length - 80} more line(s)`] : [];
  return [...diff.slice(0, 80), ...more].join('\n');
}

let registered = false;
if (!registered) {
  registered = true;
  // The hooks route, and the interface's agent launcher and Claude Code setup (plan M9 §5.9, §5.10).
  daemonPlugins.extensions.push(claudeCodeHooks(), createAgentLauncher(), claudeSetupExtension());
  commandPlugins.push(registerHarness, registerFixture);
  extraDoctorChecks.push(async (ref) => {
    if (!ref || !existsSync(path.join(ref.root, '.friday', 'harness', 'claude-code'))) return [];
    const report = await claudeDoctor(ref, { skipMcp: true });
    return [
      ...report.checks.filter((c) => c.status === 'fail' || c.status === 'warn'),
      {
        id: 'claude-code',
        status: 'info' as const,
        message: `Claude Code attach: ${report.achieved} (details: friday harness doctor claude-code)`,
      },
    ];
  });
  // The other hosts set up in this project (plan M8b), read-only and without starting any host.
  extraDoctorChecks.push(async (ref) => {
    if (!ref) return [];
    const has = (host: string) => existsSync(path.join(ref.root, '.friday', 'harness', host));
    const out: { id: string; status: 'ok' | 'warn' | 'fail' | 'info'; message: string; fix?: string }[] = [];
    const add = (host: string, name: string, report: { checks: typeof out; achieved: string }) => {
      out.push(...report.checks.filter((c) => c.status === 'fail' || c.status === 'warn'), {
        id: host,
        status: 'info',
        message: `${name} attach (experimental): ${report.achieved} (details: friday harness doctor ${host})`,
      });
    };
    if (has('cursor')) add('cursor', 'Cursor', await cursorDoctor(ref, { skipMcp: true }));
    if (has('gemini')) add('gemini', 'Gemini CLI', await geminiDoctor(ref, { quick: true }));
    // Reading Antigravity's version runs its CLI, which `friday doctor` does not do.
    if (has('antigravity')) {
      out.push({
        id: 'antigravity',
        status: 'info',
        message:
          'Antigravity attach (experimental): set up in this project (details: friday harness doctor antigravity)',
      });
    }
    return out;
  });
}
