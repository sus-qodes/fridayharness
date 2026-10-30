import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyPlan, detectClaudeCode, type FileChange } from '@friday/adapter-claude';
import { findCodex } from '@friday/adapter-codex';
import { findCursorAgent } from '@friday/adapter-cursor';
import {
  DEEPSEEK_STATUS,
  deepseekConfigPath,
  findDeepSeekHarness,
  findOnPath,
  mergeDeepSeekConfig,
} from '@friday/adapter-deepseek';
import { findGemini } from '@friday/adapter-gemini';
import { readInstallInfo, stateDir, writePrivateFile } from '@friday/sdk';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out, UsageError } from './context.js';
import { table } from './output.js';

/**
 * First-run host setup (ADR-0036): one `friday` MCP entry per installed host in the host's own user
 * configuration, pointing at the machine launcher Friday owns. Merge-only, backed up, byte-stable
 * when nothing changes, and `friday hosts remove` takes it back out. Project-local attach files
 * (`friday harness config <host>`) stay the way a repository's sessions get Friday's hooks.
 */

export type HostId = 'claude-code' | 'codex' | 'gemini' | 'opencode' | 'cursor' | 'deepseek' | 'antigravity';
export const HOST_IDS: readonly HostId[] = [
  'claude-code',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'deepseek',
  'antigravity',
];

const LABELS: Record<HostId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  cursor: 'Cursor',
  deepseek: 'DeepSeek Harness',
  antigravity: 'Antigravity',
};

/** The project-local attach files of each host, relative to the repository (what `harness config` writes). */
const PROJECT_FILES: Record<HostId, string[]> = {
  'claude-code': ['.mcp.json', '.claude/settings.json'],
  codex: [],
  gemini: ['.gemini/settings.json'],
  opencode: ['.friday/harness/opencode/config.json'],
  cursor: ['.cursor/mcp.json'],
  deepseek: [],
  antigravity: ['.agents/mcp_config.json'],
};

export const MACHINE_LAUNCHER_NAME = 'friday-local-mcp.mjs';

/** The home folder host files live under; `FRIDAY_HOSTS_HOME` redirects it (tests never touch a real home). */
export function hostsHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FRIDAY_HOSTS_HOME ? path.resolve(env.FRIDAY_HOSTS_HOME) : os.homedir();
}

export function machineLauncherPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'hosts', MACHINE_LAUNCHER_NAME);
}

/**
 * The machine launcher: Friday's own file, private to this machine. It reads `install.json` from
 * the state folder it was written for at run time, so a rebuilt Friday (`friday setup` again)
 * needs no rewrite of any host file. It holds no secret.
 */
export function machineLauncherSource(stateDirPath: string): string {
  return `#!/usr/bin/env node
// Friday's machine launcher, written by "friday setup" (ADR-0036): starts this machine's installed
// Friday MCP server for the host that names it (FRIDAY_HARNESS). Private to this machine; no secrets.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

if (process.env.FRIDAY_SPAWN_RUN) {
  process.stderr.write("[friday] This session was started by Friday, which gives it Friday's tools itself.\\n");
  process.exit(0);
}
const stateDir = ${JSON.stringify(stateDirPath)};
let entry = process.env.FRIDAY_MCP_ENTRY;
if (!entry) {
  try {
    entry = JSON.parse(readFileSync(path.join(stateDir, 'install.json'), 'utf8')).mcp_server_entry;
  } catch {
    entry = undefined;
  }
}
if (!entry || !existsSync(entry)) {
  process.stderr.write('[friday] Friday is not set up on this machine: run "friday setup" after building Friday.\\n');
  process.exit(1);
}
process.env.FRIDAY_HOST_PID ??= String(process.ppid);
await import(pathToFileURL(entry).href);
`;
}

/** Writes the machine launcher into the state folder; returns its path. */
export function writeMachineLauncher(env: NodeJS.ProcessEnv = process.env): string {
  const dir = path.join(stateDir(env), 'hosts');
  return writePrivateFile(dir, MACHINE_LAUNCHER_NAME, machineLauncherSource(stateDir(env)));
}

// ---------------------------------------------------------------- the entries

/** Friday's entry for a JSON host file, as that host reads it. */
export function hostEntry(host: HostId, launcher: string): Record<string, unknown> | null {
  switch (host) {
    case 'claude-code':
      return { command: 'node', args: [launcher], env: { FRIDAY_HARNESS: 'claude-code' } };
    case 'cursor':
      return {
        type: 'stdio',
        command: 'node',
        args: [launcher],
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Cursor substitutes ${workspaceFolder}.
        env: { FRIDAY_HARNESS: 'cursor', FRIDAY_PROJECT_DIR: '${workspaceFolder}' },
      };
    case 'gemini':
      return { command: 'node', args: [launcher], env: { FRIDAY_HARNESS: 'gemini' }, trust: true };
    case 'opencode':
      return { type: 'local', command: ['node', launcher], enabled: true, environment: { FRIDAY_HARNESS: 'opencode' } };
    default:
      return null;
  }
}

/** Where Friday's entry sits in a JSON host file. */
function jsonKeys(host: HostId): [string, string] | null {
  if (host === 'opencode') return ['mcp', 'friday'];
  if (host === 'claude-code' || host === 'cursor' || host === 'gemini') return ['mcpServers', 'friday'];
  return null;
}

export type EntryState = 'configured' | 'missing' | 'outdated' | 'manual';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const stringify = (o: Record<string, unknown>) => `${JSON.stringify(o, null, 2)}\n`;

/**
 * A JSON host file with Friday's entry set (`entry`) or removed (null): every other key kept,
 * written with two-space indentation only when Friday's part changes. A file that does not parse,
 * or whose section is not an object, is `manual` and never touched.
 */
export function mergeJsonEntry(
  existing: string | null,
  keys: [string, string],
  entry: Record<string, unknown> | null,
): { state: EntryState; text: string | null; changed: boolean } {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = existing === null || existing.trim() === '' ? {} : JSON.parse(existing);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    obj = { ...(parsed as Record<string, unknown>) };
  } catch {
    return { state: 'manual', text: null, changed: false };
  }
  const [k1, k2] = keys;
  const sectionRaw = obj[k1];
  if (sectionRaw !== undefined && (!sectionRaw || typeof sectionRaw !== 'object' || Array.isArray(sectionRaw))) {
    return { state: 'manual', text: null, changed: false };
  }
  const section: Record<string, unknown> = { ...((sectionRaw as Record<string, unknown> | undefined) ?? {}) };
  const current = section[k2];
  const state: EntryState =
    current === undefined ? 'missing' : entry !== null && same(current, entry) ? 'configured' : 'outdated';
  if (entry === null) {
    if (current === undefined) return { state, text: existing, changed: false };
    delete section[k2];
    if (Object.keys(section).length) obj[k1] = section;
    else delete obj[k1];
    return { state, text: Object.keys(obj).length ? stringify(obj) : null, changed: true };
  }
  if (state === 'configured') return { state, text: existing, changed: false };
  section[k2] = entry;
  obj[k1] = section;
  return { state, text: stringify(obj), changed: true };
}

const CODEX_BEGIN = '# >>> friday: managed by "friday hosts setup"; remove with "friday hosts remove codex" >>>';
const CODEX_END = '# <<< friday <<<';
const CODEX_BLOCK_RE = /\n?# >>> friday:[^\n]*>>>\n[\s\S]*?# <<< friday <<<\n?/;

/** Friday's block for `~/.codex/config.toml`: Codex's own sessions reach Friday as a plain MCP client. */
export function codexBlock(launcher: string): string {
  return [
    CODEX_BEGIN,
    '[mcp_servers.friday]',
    'command = "node"',
    `args = [${JSON.stringify(launcher)}]`,
    'env = { FRIDAY_HARNESS = "generic" }',
    CODEX_END,
    '',
  ].join('\n');
}

/**
 * The TOML file with Friday's block added, replaced or removed, the rest kept byte for byte; never
 * parsed. `manual` when the file declares `[mcp_servers.friday]` itself outside Friday's block.
 */
export function mergeCodexConfig(
  existing: string | null,
  launcher: string,
  install: boolean,
): string | null | 'manual' {
  const rest = (existing ?? '').replace(CODEX_BLOCK_RE, '');
  if (install && /^\[mcp_servers\.friday\]/m.test(rest)) return 'manual';
  if (!install) return existing === null || rest.trim() === '' ? null : rest.endsWith('\n') ? rest : `${rest}\n`;
  const base = rest.trim() === '' ? '' : rest.endsWith('\n') ? rest : `${rest}\n`;
  return `${base}${base ? '\n' : ''}${codexBlock(launcher)}`;
}

// ---------------------------------------------------------------- detection and planning

export interface HostDetection {
  installed: boolean;
  version: string | null;
  where: string | null;
  problem: string | null;
}

export interface HostPlan {
  host: HostId;
  label: string;
  detected: HostDetection;
  /** The host's user file; null when the host has no documented one (project-local only). */
  file: string | null;
  /** Friday's entry in that file before the plan; `none` for a host without a user file. */
  entry: EntryState | 'none';
  /** What `setup` or `remove` would write; null when nothing changes or nothing may be written. */
  change: FileChange | null;
  /** The project-local attach files of the current project, when run inside one. */
  project: { file: string; present: boolean }[] | null;
  note: string;
}

export function detectHost(host: HostId, env: NodeJS.ProcessEnv): HostDetection {
  const none = (problem: string): HostDetection => ({ installed: false, version: null, where: null, problem });
  switch (host) {
    case 'claude-code': {
      const i = detectClaudeCode(env);
      return i ? { installed: true, version: i.version, where: i.binary, problem: null } : none('not found');
    }
    case 'codex': {
      const i = findCodex(env);
      return i.binary
        ? { installed: true, version: i.version, where: i.binary, problem: null }
        : none(i.problem ?? 'not found');
    }
    case 'cursor': {
      const i = findCursorAgent(env);
      return i.binary
        ? { installed: true, version: i.version, where: i.binary, problem: null }
        : none(i.problem ?? 'not found');
    }
    case 'gemini': {
      const i = findGemini(env);
      return i.command
        ? { installed: true, version: i.version, where: i.packageDir ?? i.command, problem: null }
        : none(i.problem ?? 'not found');
    }
    case 'opencode': {
      const where = findOnPath('opencode', env);
      return where ? { installed: true, version: null, where, problem: null } : none('opencode is not on PATH');
    }
    case 'deepseek': {
      const i = findDeepSeekHarness(env);
      return i.binary
        ? { installed: true, version: null, where: i.binary, problem: null }
        : none(i.problem ?? 'not found');
    }
    case 'antigravity': {
      const where = findOnPath('agy', env) ?? findOnPath('antigravity', env);
      return where ? { installed: true, version: null, where, problem: null } : none('agy is not on PATH');
    }
  }
}

/** The host's user file under `home`; null for a host without a documented one. */
export function hostFile(host: HostId, home: string): string | null {
  switch (host) {
    case 'claude-code':
      return path.join(home, '.claude.json');
    case 'cursor':
      return path.join(home, '.cursor', 'mcp.json');
    case 'gemini':
      return path.join(home, '.gemini', 'settings.json');
    case 'opencode':
      return path.join(home, '.config', 'opencode', 'opencode.json');
    case 'codex':
      return path.join(home, '.codex', 'config.toml');
    case 'deepseek':
      return deepseekConfigPath(home);
    case 'antigravity':
      return null;
  }
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export interface PlanOptions {
  env?: NodeJS.ProcessEnv;
  /** `install`: set the entry; `remove`: take it out; `report`: plan nothing, say what is there. */
  mode: 'install' | 'remove' | 'report';
  /** The current project's root, for its attach files; omitted outside a project. */
  projectRoot?: string | null;
  /** Hosts named by the operator: a named host is planned even when it is not installed. */
  named?: readonly HostId[];
}

/** What is there for one host, and what `setup` or `remove` would write. */
export function planHost(host: HostId, opts: PlanOptions): HostPlan {
  const env = opts.env ?? process.env;
  const home = hostsHome(env);
  const launcher = machineLauncherPath(env);
  const detected = detectHost(host, env);
  const file = hostFile(host, home);
  const project = opts.projectRoot
    ? PROJECT_FILES[host].map((rel) => ({ file: rel, present: existsSync(path.join(opts.projectRoot as string, rel)) }))
    : null;
  const display = file ? `(home) ${path.relative(home, file).replaceAll('\\', '/')}` : '';
  const base = { host, label: LABELS[host], detected, file, project };
  if (!file) {
    return { ...base, entry: 'none', change: null, note: 'project-local only: friday harness config antigravity' };
  }
  const before = read(file);
  const install = opts.mode === 'install';
  const named = opts.named?.includes(host) ?? false;
  const mayWrite = opts.mode !== 'report' && (install ? detected.installed || named : true);
  let state: EntryState;
  let after: string | null = before;
  let changed = false;
  let manualHint = '';
  const keys = jsonKeys(host);
  if (keys) {
    const now = mergeJsonEntry(before, keys, hostEntry(host, launcher));
    state = now.state;
    if (mayWrite) {
      const r = mergeJsonEntry(before, keys, install ? hostEntry(host, launcher) : null);
      after = r.text;
      changed = r.changed;
    }
  } else {
    const merge = host === 'codex' ? mergeCodexConfig : mergeDeepSeekConfig;
    const current = merge(before, launcher, true);
    const rest = (before ?? '').replace(
      host === 'codex' ? CODEX_BLOCK_RE : /\n?# >>> friday:[^\n]*>>>\n[\s\S]*?# <<< friday <<<\n?/,
      '',
    );
    state =
      current === 'manual'
        ? 'manual'
        : before !== null && before.length !== rest.length
          ? before.includes(JSON.stringify(launcher))
            ? 'configured'
            : 'outdated'
          : 'missing';
    if (state === 'manual')
      manualHint = host === 'codex' ? codexBlock(launcher) : (mergeDeepSeekConfig(null, launcher, true) as string);
    if (mayWrite && state !== 'manual') {
      const r = merge(before, launcher, install);
      after = r === 'manual' ? before : r;
      changed = after !== before;
    }
  }
  const change: FileChange | null =
    changed && mayWrite
      ? {
          path: file,
          display,
          before,
          after,
          tracked: false,
          note: install ? "Friday's MCP server entry" : "removes Friday's MCP server entry",
          owned: false,
        }
      : null;
  const note =
    state === 'manual'
      ? `the file declares Friday's server itself; left alone. Friday's part would be:\n${manualHint.trimEnd()}`
      : !detected.installed
        ? install && !named
          ? `not installed (${detected.problem}): skipped`
          : `not installed (${detected.problem})`
        : host === 'deepseek'
          ? DEEPSEEK_STATUS
          : host === 'codex' || host === 'opencode'
            ? "serves your own sessions of it; Friday's spawned sessions use their private profile (ADR-0032)"
            : '';
  return { ...base, entry: state, change, note };
}

export interface HostsReport {
  written_at: string;
  launcher: string;
  launcher_present: boolean;
  hosts: Omit<HostPlan, 'change'>[];
}

/** Plans every host (or the ones named) for a mode. */
export function planHosts(opts: PlanOptions): HostPlan[] {
  const hosts = opts.named?.length ? opts.named : HOST_IDS;
  return hosts.map((h) => planHost(h, opts));
}

/** Writes the planned changes (atomic, one backup of a user file per day) and the report. */
export function applyHostPlans(plans: HostPlan[], env: NodeJS.ProcessEnv = process.env): HostsReport {
  const changes = plans.flatMap((p) => (p.change ? [p.change] : []));
  applyPlan(changes);
  return writeHostsReport(planHosts({ env, mode: 'report' }), env);
}

export function writeHostsReport(plans: HostPlan[], env: NodeJS.ProcessEnv = process.env): HostsReport {
  const launcher = machineLauncherPath(env);
  const report: HostsReport = {
    written_at: new Date().toISOString(),
    launcher,
    launcher_present: existsSync(launcher),
    hosts: plans.map(({ change: _change, ...rest }) => rest),
  };
  writePrivateFile(path.join(stateDir(env), 'hosts'), 'report.json', `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

// ---------------------------------------------------------------- the CLI

const ENTRY_WORDS: Record<HostPlan['entry'], string> = {
  configured: 'configured',
  missing: 'not written',
  outdated: 'outdated',
  manual: 'manual',
  none: '-',
};

export function renderHosts(plans: readonly HostPlan[], launcher: { path: string; present: boolean }): string {
  const rows = plans.map((p) => [
    p.host,
    p.detected.installed ? `yes${p.detected.version ? ` ${p.detected.version}` : ''}` : 'no',
    ENTRY_WORDS[p.entry],
    p.project
      ? p.project.length
        ? p.project.every((f) => f.present)
          ? 'yes'
          : p.project.some((f) => f.present)
            ? 'partly'
            : 'no'
        : '-'
      : '',
    p.change ? (p.change.after === null ? 'remove' : p.change.before === null ? 'write' : 'update') : '',
    p.note.split('\n')[0] ?? '',
  ]);
  const hasProject = plans.some((p) => p.project !== null);
  const header = ['HOST', 'INSTALLED', 'MACHINE ENTRY', ...(hasProject ? ['PROJECT FILES'] : []), 'CHANGE', 'NOTE'];
  const body = rows.map((r) => (hasProject ? r : [...r.slice(0, 3), ...r.slice(4)]));
  return [
    table(header, body, { maxWidth: 70 }),
    `Machine launcher: ${launcher.path}${launcher.present ? '' : ' (missing: run "friday setup")'}`,
  ].join('\n');
}

/** The hosts set up for this machine, as `friday init` and `friday hosts setup` do it. */
export function setupHosts(opts: {
  env?: NodeJS.ProcessEnv;
  named?: readonly HostId[];
  projectRoot?: string | null;
  dryRun?: boolean;
}): { plans: HostPlan[]; report: HostsReport | null; launcher: string } {
  const env = opts.env ?? process.env;
  if (!readInstallInfo(env)) {
    throw new UsageError(
      'this machine is not set up yet: run "friday setup" (after building Friday), then "friday hosts setup"',
    );
  }
  const launcher = opts.dryRun ? machineLauncherPath(env) : writeMachineLauncher(env);
  const plans = planHosts({
    env,
    mode: 'install',
    ...(opts.named ? { named: opts.named } : {}),
    projectRoot: opts.projectRoot ?? null,
  });
  const report = opts.dryRun ? null : applyHostPlans(plans, env);
  return { plans, report, launcher };
}

/** Readiness evidence for the current project's daemon, when one runs: installed and configured hosts, for a day. */
async function recordReadiness(
  g: () => GlobalOptions,
  plans: readonly HostPlan[],
  projectRoot: string | null,
): Promise<string | null> {
  const seen = plans.filter((p) => p.detected.installed && (p.entry === 'configured' || p.entry === 'none'));
  if (!seen.length || !projectRoot) return null;
  try {
    const { client } = operator(g());
    for (const p of seen) {
      await client.post(client.projectPath('/readiness/evidence'), {
        host: p.host,
        version: p.detected.version,
        source: 'friday hosts',
        stages: [
          { stage: 'detected', status: 'passed', detail: p.detected.where },
          ...(p.entry === 'configured' ? [{ stage: 'configured', status: 'passed', detail: p.file }] : []),
        ],
      });
    }
    return `Recorded for routing, for a day: ${seen.map((p) => p.host).join(', ')}`;
  } catch {
    // Best effort: no daemon, or no project here. The setup itself is done; the doctor records later.
    return null;
  }
}

function parseHosts(values: string[] | undefined): HostId[] | undefined {
  if (!values?.length) return undefined;
  for (const v of values) {
    if (!HOST_IDS.includes(v as HostId)) throw new UsageError(`unknown host ${v}; one of ${HOST_IDS.join(', ')}`);
  }
  return values as HostId[];
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

export function registerHostsCommands(program: Command, g: () => GlobalOptions): void {
  const projectRootOf = (): string | null => {
    try {
      return operator(g()).ref.root;
    } catch {
      return null;
    }
  };
  const hosts = program
    .command('hosts')
    .description('the coding tools on this machine: installed, wired to Friday for every project, and this project')
    .action(async () => {
      const plans = planHosts({ mode: 'report', projectRoot: projectRootOf() });
      const launcher = machineLauncherPath();
      const report = { launcher, launcher_present: existsSync(launcher), hosts: plans };
      out(g(), report, () => renderHosts(plans, { path: launcher, present: report.launcher_present }));
    });

  hosts
    .command('setup')
    .description(
      "write Friday's MCP entry into each installed tool's user configuration (merge-only, backed up, reversible)",
    )
    .option('--host <host>', `one host (repeatable): ${HOST_IDS.join(', ')}`, collect, [])
    .option('--dry-run', 'show what would change; write nothing')
    .action(async (o: { host: string[]; dryRun?: boolean }) => {
      const named = parseHosts(o.host);
      const projectRoot = projectRootOf();
      const r = setupHosts({ ...(named ? { named } : {}), projectRoot, dryRun: Boolean(o.dryRun) });
      const recorded = o.dryRun
        ? null
        : await recordReadiness(g, planHosts({ mode: 'report', projectRoot }), projectRoot);
      out(g(), { ...r, recorded }, () =>
        [
          renderHosts(r.plans, { path: r.launcher, present: !o.dryRun || existsSync(r.launcher) }),
          o.dryRun
            ? 'Dry run: nothing was written.'
            : r.plans.some((p) => p.change)
              ? 'Written. A changed user file keeps a .friday-<day>.bak beside it.'
              : 'Nothing to write: every installed host was already configured.',
          ...(recorded ? [recorded] : []),
        ].join('\n'),
      );
    });

  hosts
    .command('remove')
    .description("take Friday's MCP entry back out of each tool's user configuration (the backup stays)")
    .option('--host <host>', 'one host (repeatable)', collect, [])
    .action(async (o: { host: string[] }) => {
      const named = parseHosts(o.host);
      const plans = planHosts({ mode: 'remove', ...(named ? { named } : {}), projectRoot: projectRootOf() });
      const report = applyHostPlans(plans);
      out(g(), { plans, report }, () =>
        [
          renderHosts(plans, { path: report.launcher, present: report.launcher_present }),
          plans.some((p) => p.change) ? "Removed Friday's entries." : 'Nothing to remove.',
        ].join('\n'),
      );
    });
}
