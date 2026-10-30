import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphSetupStep } from '@friday/daemon';
import type {
  AgentView,
  DomainEvent,
  HarnessView,
  RunView,
  TaskSplitResult,
  TaskView,
  UiSnapshot,
  VerificationView,
} from '@friday/protocol';
import { newId, TaskStatus } from '@friday/protocol';
import {
  FRIDAY_DIR,
  FRIDAY_VERSION,
  readInstallInfo,
  readToken,
  renderInitialConfig,
  stateDir,
  writePrivateFile,
} from '@friday/sdk';
import { Command, CommanderError, Option } from 'commander';
import { type GlobalOptions, operator, out, project, UsageError } from './context.js';
import { registerContextCommands } from './context-cmd.js';
import { doctor, renderDoctor } from './doctor.js';
import { registerGoalCommands, renderEscalation } from './goals.js';
import { registerGraphCommands } from './graph.js';
import { registerHostsCommands, setupHosts, writeMachineLauncher } from './hosts.js';
import { registerIntegrationCommands } from './integrations.js';
import { registerIntentCommands } from './intent.js';
import { registerLearningCommands } from './learnings.js';
import { registerMemoryCommands } from './memory.js';
import { registerMessageCommands } from './messages.js';
import { openTarget, runningDaemon, startDetached } from './open-link.js';
import { registerOperationCommands } from './operations.js';
import { clip, describeEvent, kv, shortTime, table, verificationLines } from './output.js';
import { registerPolicyCommands } from './policy.js';
import { registerReadinessCommands } from './readiness.js';
import { registerRecoveryCommands } from './recovery.js';
import { registerRegistryCommands } from './registry.js';
import { registerReservationCommands } from './reservations.js';
import { restoreProject } from './restore.js';
import { registerRoutingCommands } from './routing.js';
import { runDaemon } from './run.js';
import { buildGraphAtInit, graphSummaryLine } from './setup-project.js';
import { createShortcut } from './shortcut.js';
import { registerStartCommand } from './start.js';
import { FRIDAY_DIR_GITIGNORE } from './templates.js';
import { registerUsageCommands } from './usage.js';
import { registerWorktreeCommands } from './worktrees.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** Extra commands contributed by adapters (M1c: `harness config`, `harness doctor`, `fixture init`). */
export const commandPlugins: ((program: Command) => void)[] = [];

/**
 * One line on config.yaml for `friday status` (plan M11.2): the changed keys that still need a
 * restart, named exactly; what applied while Friday ran; or why the file could not be read.
 */
export function describeConfig(config: UiSnapshot['config']): string {
  const c = config.changes;
  if (!c) return 'read when Friday started';
  if (c.error !== null) return `could not be read; the settings in force are unchanged: ${c.error}`;
  const applied = c.applied.length ? `applied while running: ${c.applied.join(', ')}` : '';
  if (c.restart_needed.length) {
    const need = `${c.restart_needed.join(', ')} ${c.restart_needed.length === 1 ? 'needs' : 'need'} a restart to apply`;
    return applied ? `${need}; ${applied}` : need;
  }
  return applied || 'unchanged since Friday started';
}

/** `90`, `90s`, `30m`, `2h` or `1d` in seconds. */
function parseDuration(text: string): number {
  const m = text.trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) throw new Error(`not a duration: ${text} (use 90s, 30m, 2h or 1d)`);
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? '').toLowerCase() as '' | 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * unit;
}

export function buildProgram(): Command {
  const program = new Command('friday')
    .description('Friday: local orchestration and context control plane for AI coding harnesses')
    .version(FRIDAY_VERSION, '-v, --version')
    .option('--project <dir>', 'project directory (default: the current directory)')
    .option('--json', 'machine-readable JSON output')
    .showHelpAfterError()
    .exitOverride();
  const g = (): GlobalOptions => program.opts<GlobalOptions>();

  // ---- setup and project -------------------------------------------------------------------

  program
    .command('setup')
    .description('one-time machine setup: records where Friday is installed for hooks and MCP launchers')
    .action(() => {
      const here = path.dirname(fileURLToPath(import.meta.url));
      const cliEntry = path.resolve(here, '..', 'bin', 'friday.mjs');
      const mcpEntry = path.resolve(here, '..', '..', '..', 'packages', 'mcp-server', 'bin', 'friday-mcp.mjs');
      const info = {
        friday_version: FRIDAY_VERSION,
        node_path: process.execPath,
        cli_entry: existsSync(cliEntry) ? cliEntry : null,
        daemon_entry: null,
        mcp_server_entry: existsSync(mcpEntry) ? mcpEntry : null,
        written_at: new Date().toISOString(),
      };
      const file = writePrivateFile(stateDir(), 'install.json', `${JSON.stringify(info, null, 2)}\n`);
      // The machine launcher every host's user entry points at (ADR-0036 §1).
      const launcher = writeMachineLauncher();
      out(g(), { ...info, file, launcher }, () =>
        kv([
          ['install.json', file],
          ['node', info.node_path],
          ['cli', info.cli_entry ?? '(not built)'],
          ['mcp server', info.mcp_server_entry ?? '(not built yet)'],
          ['launcher', launcher],
          ['next', 'friday hosts setup (wires every installed coding tool to Friday)'],
        ]),
      );
    });

  program
    .command('init')
    .description('create .friday/config.yaml and .friday/.gitignore in the current repository')
    .option('--name <name>', 'project name (default: directory name)')
    .option('--force', 'rewrite .friday/.gitignore and keep the existing project id')
    .option('--shortcut', 'also create a desktop shortcut that opens Friday for this project')
    .option(
      '--no-hosts',
      'do not wire the installed coding tools to Friday (otherwise done once the machine is set up)',
    )
    .option('--no-graph', 'do not build the code graph now (it is then built the first time something needs it)')
    .action(async (opts: { name?: string; force?: boolean; shortcut?: boolean; hosts?: boolean; graph?: boolean }) => {
      const root = path.resolve(g().project ?? process.cwd());
      const dir = path.join(root, FRIDAY_DIR);
      const configPath = path.join(dir, 'config.yaml');
      mkdirSync(dir, { recursive: true });
      if (existsSync(configPath) && !opts.force) {
        const existing = project({ project: root });
        throw new UsageError(
          `already initialized: ${existing.name} (${existing.project_id}); use --force to rewrite .friday/.gitignore`,
        );
      }
      if (!existsSync(configPath)) {
        writeFileSync(
          configPath,
          renderInitialConfig(newId('proj'), opts.name ?? path.basename(root), { graph: opts.graph !== false }),
        );
      }
      writeFileSync(path.join(dir, '.gitignore'), FRIDAY_DIR_GITIGNORE);
      const ref = project({ project: root });
      const shortcuts = opts.shortcut ? createShortcut(ref) : [];
      // The installed coding tools, wired to Friday for every project (ADR-0036 §3): once the
      // machine is set up; a host that is not installed is never written.
      let hostLines: string[] = [];
      let hosts: { host: string; installed: boolean; entry: string; change: string | null }[] | null = null;
      if (opts.hosts !== false) {
        if (readInstallInfo()) {
          const r = setupHosts({ projectRoot: ref.root });
          hosts = r.plans.map((p) => ({
            host: p.host,
            installed: p.detected.installed,
            entry: p.entry,
            change: p.change ? (p.change.before === null ? 'written' : 'updated') : null,
          }));
          const written = r.plans.filter((p) => p.change).map((p) => p.host);
          const already = r.plans
            .filter((p) => !p.change && p.detected.installed && p.entry === 'configured')
            .map((p) => p.host);
          hostLines = [
            `Hosts: ${written.length ? `wired ${written.join(', ')}` : 'nothing new to wire'}${already.length ? `; already wired: ${already.join(', ')}` : ''} (details: friday hosts)`,
          ];
        } else {
          hostLines = [
            'Hosts: run "friday setup" (after building Friday), then "friday hosts setup" to wire your coding tools',
          ];
        }
      }
      // The code graph, once, now: the project's setting decides, and --no-graph turns it off for
      // this project; a project set up before keeps its record.
      let graph: GraphSetupStep | null = null;
      if (opts.graph !== false && ref.config.setup.graph) {
        const { readSetupRecord } = await import('@friday/daemon');
        graph = readSetupRecord(ref.root)?.graph ?? null;
        if (graph?.status !== 'done') graph = await buildGraphAtInit(ref.root, !g().json);
      }
      out(g(), { project_id: ref.project_id, name: ref.name, root: ref.root, shortcuts, hosts, graph }, () =>
        [
          `Initialized Friday project "${ref.name}" (${ref.project_id})`,
          `  ${path.relative(process.cwd(), configPath) || configPath}  (commit this)`,
          '  .friday/.gitignore  (commit this; it keeps runtime files out of git)',
          graphSummaryLine(graph),
          ...shortcuts.map((f) => `  shortcut: ${f}`),
          ...hostLines,
          shortcuts.length ? 'Next: double-click the shortcut' : 'Next: friday start (or friday shortcut)',
          'Then tell Friday what the project is for: friday intent draft (or friday intent ask)',
        ].join('\n'),
      );
    });

  program
    .command('run')
    .description('start the Friday daemon for this project in the foreground')
    .addOption(new Option('--port <port>', 'port on 127.0.0.1 (default: config or random)').argParser(Number))
    .addOption(new Option('--log-level <level>').choices(['debug', 'info', 'warn', 'error']))
    .action(async (opts: { port?: number; logLevel?: 'debug' | 'info' | 'warn' | 'error' }) => {
      await runDaemon({ ...(g().project ? { project: g().project as string } : {}), ...opts });
    });

  program
    .command('status')
    .description('daemon, task counts, harnesses, agents and pending approvals')
    .action(async () => {
      const { client, ref } = operator(g());
      const s = await client.get<{
        head: number;
        counts: Record<string, number>;
        harnesses: HarnessView[];
        agents: AgentView[];
        approvals: Record<string, unknown>[];
        escalations: Record<string, unknown>[];
        /** What the daemon did with a changed config.yaml (plan M11.2); null from a daemon without the board. */
        config: UiSnapshot['config'] | null;
      }>(client.projectPath('/status'));
      out(g(), s, () =>
        [
          kv([
            ['project', `${ref.name} (${ref.project_id})`],
            ['daemon', client.baseUrl],
            ['config', s.config ? describeConfig(s.config) : 'not reported by this daemon'],
            ['events', s.head],
            [
              'tasks',
              Object.entries(s.counts)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ') || '(none)',
            ],
            ['approvals', `${s.approvals.length} pending`],
            ['escalations', `${s.escalations.length} pending`],
          ]),
          '',
          s.harnesses.length
            ? table(
                ['HARNESS', 'VENDOR', 'MODE', 'STATUS', 'LEVEL', 'LAST HEARTBEAT'],
                s.harnesses.map((h) => [
                  h.harness_id,
                  h.vendor,
                  h.attach_mode,
                  h.status,
                  h.enforcement_level,
                  shortTime(h.last_heartbeat_at),
                ]),
              )
            : 'No harness attached.',
          '',
          s.agents.length
            ? table(
                ['AGENT', 'STATUS', 'TASK'],
                s.agents.map((a) => [`${a.agent_key}${a.shadow ? ' (shadow)' : ''}`, a.status, a.current_task_id]),
              )
            : 'No agents yet.',
        ].join('\n'),
      );
    });

  program
    .command('doctor')
    .description('check this machine and project (read-only)')
    .action(async () => {
      const results = await doctor(g().project);
      out(g(), results, () => renderDoctor(results));
      if (results.some((r) => r.status === 'fail')) process.exitCode = 1;
    });

  // ---- tasks ---------------------------------------------------------------------------------

  program
    .command('tasks')
    .description('list tasks')
    .option('--status <status...>', `filter: ${TaskStatus.options.join(', ')}`)
    .option('--all', 'include COMPLETED and CANCELLED')
    .action(async (opts: { status?: string[]; all?: boolean }) => {
      const { client } = operator(g());
      const res = await client.get<{ tasks: TaskView[] }>(client.projectPath('/tasks'), {
        query: { status: opts.status },
      });
      const tasks =
        opts.all || opts.status
          ? res.tasks
          : res.tasks.filter((t) => !['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(t.status));
      out(g(), tasks, () =>
        tasks.length
          ? table(
              ['TASK', 'STATUS', 'PRIORITY', 'FOR', 'SUMMARY'],
              tasks.map((t) => [
                t.task_id,
                t.waiting_reason ? `${t.status}(${t.waiting_reason})` : t.status,
                t.priority,
                t.reserved_for_agent_key ?? '',
                t.summary,
              ]),
            )
          : 'No open tasks. Create one with: friday task create "<summary>" --ready',
      );
    });

  const task = program.command('task').description('create, inspect and move tasks');
  task
    .command('create <summary>')
    .description('create a task')
    .addOption(
      new Option('--kind <kind>').choices(['implementation', 'verification', 'review', 'research', 'docs', 'chore']),
    )
    .option('--role <role>', 'the task contract role (backend, frontend, documentation, …)')
    .option('--description <text>')
    .option('--criteria <text>', 'acceptance criterion (repeatable)', collect)
    .addOption(new Option('--priority <p>').choices(['low', 'normal', 'high', 'urgent']))
    .addOption(new Option('--risk <r>').choices(['low', 'medium', 'high']))
    .option('--depends-on <task>', 'dependency (repeatable)', collect)
    .option('--scope-write <glob>', 'path the agent may edit (repeatable)', collect)
    .option('--scope-read <glob>', 'path the agent may read (repeatable)', collect)
    .option('--assign <agent>', 'reserve for this agent key (implies --ready)')
    .option('--ready', 'make it claimable now')
    .action(async (summary: string, o: Record<string, unknown>) => {
      const { client } = operator(g());
      const body: Record<string, unknown> = { summary, ready: Boolean(o.ready) };
      if (o.kind) body.kind = o.kind;
      if (o.role) body.role = o.role;
      if (o.description) body.description = o.description;
      if (o.criteria) body.acceptance_criteria = o.criteria;
      if (o.priority) body.priority = o.priority;
      if (o.risk) body.risk_level = o.risk;
      if (o.dependsOn) body.depends_on = o.dependsOn;
      if (o.scopeWrite || o.scopeRead) body.scope = { write: o.scopeWrite ?? [], read: o.scopeRead ?? [] };
      if (o.assign) body.assign_agent_key = o.assign;
      const t = await client.post<TaskView>(client.projectPath('/tasks'), body, { idempotencyKey: newId('msg') });
      // A loose task without a reservation is nobody's to start: Friday delegates the plan tasks of
      // a goal and tasks reserved for an agent; say so, or the task sits READY in silence.
      const loose = !t.goal_id && !t.reserved_for_agent_key;
      const line = `${t.task_id}  ${t.status}${t.reserved_for_agent_key ? `  reserved for ${t.reserved_for_agent_key}` : ''}  ${t.summary}`;
      const note = `  not delegated: Friday hands out the tasks of a goal's plan and tasks reserved with --assign; start this one with "friday task assign ${t.task_id} --agent <key>", or put it in a goal`;
      out(g(), t, () => (loose ? `${line}\n${note}` : line));
    });

  task
    .command('inspect <task>')
    .description('show a task, its runs, verification and recent events')
    .option('--events <n>', 'number of events to show', Number, 30)
    .action(async (id: string, o: { events: number }) => {
      const { client } = operator(g());
      const d = await client.get<{
        task: TaskView;
        runs: RunView[];
        verification: VerificationView | null;
        open_dependencies: string[];
      }>(client.projectPath(`/tasks/${id}`));
      const ev = await client.get<{ events: DomainEvent[] }>(client.projectPath(`/tasks/${id}/events`));
      out(g(), { ...d, events: ev.events }, () => {
        const t = d.task;
        const run = d.runs.at(-1);
        const claim = run?.claim as
          | {
              summary?: string;
              changed_paths?: string[];
              discrepancies?: { path: string; note: string }[];
              intent_version?: string;
            }
          | null
          | undefined;
        const lines = [
          kv([
            ['task', t.task_id],
            ['status', t.waiting_reason ? `${t.status} (${t.waiting_reason})` : t.status],
            ['summary', t.summary],
            [
              'role',
              `${t.role ?? '(unresolved)'}${t.role_source ? ` (${t.role_source})` : ''}${
                t.role_confidence !== null ? `, confidence ${t.role_confidence}` : ''
              }${t.role_registry_version ? `, registry ${t.role_registry_version}` : ''}`,
            ],
            ['priority', `${t.priority}  risk ${t.risk_level}`],
            ['reserved for', t.reserved_for_agent_key ?? ''],
            [
              'scope',
              t.scope
                ? `write: ${t.scope.write.join(', ') || '-'} | read: ${t.scope.read.join(', ') || '-'}`
                : '(none)',
            ],
            ['criteria', t.acceptance_criteria.join(' | ')],
            ['waiting on', d.open_dependencies.join(', ')],
          ]),
        ];
        if (d.runs.length) {
          lines.push(
            '',
            table(
              ['RUN', 'ATTEMPT', 'STATUS', 'OUTCOME', 'HARNESS', 'OBSERVED PATHS'],
              d.runs.map((r) => [r.run_id, r.attempt, r.status, r.outcome, r.harness_id, r.observed_paths.join(', ')]),
            ),
          );
        }
        if (claim) {
          lines.push(
            '',
            `claim: ${claim.summary ?? ''}`,
            `  claimed paths: ${(claim.changed_paths ?? []).join(', ') || '(none)'}`,
          );
          for (const x of claim.discrepancies ?? []) lines.push(`  discrepancy: ${x.path} - ${x.note}`);
          // Deterministic checks cannot judge prose intent: a change during the run is shown for review (ADR-0034 §8).
          if (run?.intent_version && claim.intent_version && claim.intent_version !== run.intent_version) {
            lines.push(
              `  intent changed during this attempt: started under ${run.intent_version}, claimed under ${claim.intent_version}; check the work against "friday intent" and the goal`,
            );
          }
        }
        if (d.verification) {
          lines.push(
            '',
            `verification ${d.verification.verification_id}: ${d.verification.status} ${d.verification.summary ?? ''}`,
          );
          lines.push(...verificationLines(d.verification));
        }
        const shown = ev.events.slice(-o.events);
        lines.push(
          '',
          table(
            ['#', 'TIME', 'EVENT', 'ACTOR', 'DETAIL'],
            shown.map((e) => [
              e.sequence,
              shortTime(e.occurred_at),
              e.type,
              `${e.actor.kind}:${clip(e.actor.id, 20)}`,
              describeEvent(e),
            ]),
          ),
        );
        return lines.join('\n');
      });
    });

  const ACTION_HELP = {
    ready: 'make a PROPOSED task READY',
    release: 'give an assigned or running task back (it becomes READY)',
    cancel: 'cancel a task',
    rework:
      'send a FAILED task back for rework (READY, offered first to a stronger agent of its role, else to the agent that did it)',
    unreserve: 'let any agent take a READY task that is reserved for one agent',
  } as const;
  for (const action of ['ready', 'release', 'cancel', 'rework', 'unreserve'] as const) {
    task
      .command(`${action} <task>`)
      .description(ACTION_HELP[action])
      .option('--reason <text>')
      .action(async (id: string, o: { reason?: string }) => {
        const { client } = operator(g());
        const res = await client.post<{ task: TaskView }>(
          client.projectPath(`/tasks/${id}/${action}`),
          o.reason ? { reason: o.reason } : {},
        );
        out(g(), res.task, () => `${res.task.task_id}  ${res.task.status}`);
      });
  }
  task
    .command('role <task> <role>')
    .description('set the task contract role explicitly (a human role assignment)')
    .action(async (id: string, role: string) => {
      const { client } = operator(g());
      const res = await client.post<{ task: TaskView }>(client.projectPath(`/tasks/${id}/role`), { role });
      out(g(), res.task, () => `${res.task.task_id}  role ${res.task.role} (${res.task.role_source})`);
    });
  task
    .command('split <task>')
    .description(
      'approve a multi-role proposal: one linked task per role, in dependency order; the original is cancelled as split',
    )
    .option('--note <text>', 'why')
    .action(async (id: string, o: { note?: string }) => {
      const { client } = operator(g());
      const r = await client.post<TaskSplitResult>(
        client.projectPath(`/tasks/${id}/split`),
        o.note ? { note: o.note } : {},
      );
      out(g(), r, () =>
        [
          `${r.original.task_id}  ${r.original.status} (split into ${r.subtasks.length} tasks)`,
          ...(r.plan ? [`plan ${r.plan.plan_id} v${r.plan.version} approved: the goal's tasks changed`] : []),
          table(
            ['TASK', 'ROLE', 'STATUS', 'AFTER', 'SUMMARY'],
            r.subtasks.map((t) => [t.task_id, t.role ?? '-', t.status, t.dependencies.join(' ') || '-', t.summary]),
            { maxWidth: 60 },
          ),
        ].join('\n'),
      );
    });
  task
    .command('assign <task>')
    .description('assign to an agent: pushed to a live spawn-mode session, otherwise reserved for the agent to claim')
    .requiredOption('--agent <key>', 'agent key, e.g. dev-1')
    .action(async (id: string, o: { agent: string }) => {
      const { client } = operator(g());
      const res = await client.post<{ mode: string; task: TaskView }>(client.projectPath(`/tasks/${id}/assign`), {
        agent_key: o.agent,
      });
      out(
        g(),
        res,
        () =>
          `${res.task.task_id}  ${res.task.status}  ${res.mode === 'assigned' ? `sent to ${o.agent}` : `reserved for ${o.agent}`}`,
      );
    });

  program
    .command('verify <task>')
    .description('verify a completion claim: runs the configured checks, or records --result')
    .addOption(new Option('--result <result>', 'record the outcome by hand').choices(['passed', 'failed']))
    .option('--note <text>')
    .action(async (id: string, o: { result?: string; note?: string }) => {
      const { client } = operator(g());
      const res = await client.post<{ task: TaskView; verification: VerificationView }>(
        client.projectPath(`/tasks/${id}/verify`),
        o,
        { timeoutMs: 3_700_000 },
      );
      out(g(), res, () =>
        [
          `${res.task.task_id}  ${res.task.status}  ${res.verification.summary ?? ''}`.trimEnd(),
          ...verificationLines(res.verification),
        ].join('\n'),
      );
    });

  // ---- harnesses, agents, events -------------------------------------------------------------

  program
    .command('harnesses')
    .description('list attached harnesses')
    .option('--all', 'include terminated ones')
    .action(async (o: { all?: boolean }) => {
      const { client } = operator(g());
      const res = await client.get<{ harnesses: HarnessView[] }>(client.projectPath('/harnesses'), {
        query: { all: o.all ? 'true' : undefined },
      });
      out(g(), res.harnesses, () =>
        res.harnesses.length
          ? table(
              ['HARNESS', 'VENDOR', 'MODE', 'STATUS', 'LEVEL', 'SESSION', 'LEASE UNTIL'],
              res.harnesses.map((h) => [
                h.harness_id,
                h.vendor,
                h.attach_mode,
                h.status,
                h.enforcement_level,
                h.host_session_id,
                shortTime(h.lease_expires_at),
              ]),
            )
          : 'No harness attached.',
      );
    });

  program
    .command('agents')
    .description('list agents')
    .action(async () => {
      const { client } = operator(g());
      const res = await client.get<{ agents: AgentView[] }>(client.projectPath('/agents'));
      out(g(), res.agents, () =>
        table(
          ['AGENT', 'ID', 'STATUS', 'HARNESS', 'TASK'],
          res.agents.map((a) => [
            `${a.agent_key}${a.shadow ? ' (shadow)' : ''}`,
            a.agent_id,
            a.status,
            a.harness_id,
            a.current_task_id,
          ]),
        ),
      );
    });

  const events = program.command('events').description('the project event log');
  // Snapshots, isolated replay and backup (M3c, ADR-0018).
  events
    .command('snapshot')
    .description('snapshot the domain tables at the current event head')
    .action(async () => {
      const { client } = operator(g());
      const s = await client.post<{
        snapshot_id: string;
        up_to_sequence: number;
        sha256: string;
        file: string;
        tables: Record<string, number>;
      }>('/admin/snapshot', {});
      const rows = Object.values(s.tables).reduce((a, b) => a + b, 0);
      out(
        g(),
        s,
        () =>
          `Snapshot ${s.snapshot_id} at event ${s.up_to_sequence}: ${rows} rows, sha256 ${s.sha256.slice(0, 12)}…\n${s.file}`,
      );
    });
  events
    .command('snapshots')
    .description('snapshots taken for this project')
    .action(async () => {
      const { client } = operator(g());
      const r = await client.get<{
        snapshots: { snapshot_id: string; up_to_sequence: number; created_at: string; present: boolean }[];
      }>('/admin/snapshots');
      out(g(), r.snapshots, () =>
        r.snapshots.length
          ? table(
              ['SNAPSHOT', 'EVENT', 'TAKEN', 'FILE'],
              r.snapshots.map((s) => [
                s.snapshot_id,
                s.up_to_sequence,
                shortTime(s.created_at),
                s.present ? 'present' : 'missing',
              ]),
            )
          : 'No snapshots.',
      );
    });
  events
    .command('replay')
    .description('rebuild the state in an isolated copy and compare it with the live state; nothing is sent or started')
    .requiredOption('--into <dir>', 'a new or empty directory for the copy')
    .option('--snapshot <id>', 'start from this snapshot instead of the first event')
    .action(async (o: { into: string; snapshot?: string }) => {
      const { client } = operator(g());
      const r = await client.post<{
        events_applied: number;
        up_to_sequence: number;
        from_snapshot: string | null;
        equal: boolean;
        tables: { table: string; rows: number; equal: boolean }[];
      }>(
        '/admin/replay',
        { into: path.resolve(o.into), ...(o.snapshot ? { snapshot: o.snapshot } : {}) },
        { timeoutMs: 600_000 },
      );
      const diff = r.tables.filter((t) => !t.equal).map((t) => t.table);
      out(g(), r, () =>
        [
          `Replayed ${r.events_applied} event(s)${r.from_snapshot ? ` after snapshot ${r.from_snapshot}` : ' from the first event'} up to ${r.up_to_sequence} into ${path.resolve(o.into)}.`,
          r.equal ? 'Every table equals the live state.' : `Different from the live state: ${diff.join(', ')}`,
        ].join('\n'),
      );
      if (!r.equal) process.exitCode = 1;
    });
  events
    .command('tail')
    .description('print events; --follow keeps streaming')
    .option('--since <seq>', 'start after this sequence number', Number, 0)
    .option('--type <type>', 'event type or prefix like task.* (repeatable)', collect)
    .option('--task <task>', 'only events about this task')
    .option('--limit <n>', 'events to fetch without --follow', Number, 50)
    .option('-f, --follow', 'keep streaming new events')
    .action(async (o: { since: number; type?: string[]; task?: string; limit: number; follow?: boolean }) => {
      const { client } = operator(g());
      const print = (e: DomainEvent) =>
        process.stdout.write(
          g().json
            ? `${JSON.stringify(e)}\n`
            : `${String(e.sequence).padStart(5)}  ${shortTime(e.occurred_at)}  ${e.type.padEnd(26)} ${`${e.actor.kind}:${clip(e.actor.id, 18)}`.padEnd(26)} ${describeEvent(e)}\n`,
        );
      if (!o.follow) {
        const res = await client.get<{ events: DomainEvent[]; head: number }>(client.projectPath('/events'), {
          query: { since: o.since, type: o.type, task: o.task, limit: o.limit },
        });
        for (const e of res.events) print(e);
        return;
      }
      const ctrl = new AbortController();
      process.once('SIGINT', () => ctrl.abort());
      let last = o.since;
      while (!ctrl.signal.aborted) {
        try {
          for await (const msg of client.sse(client.projectPath('/events/stream'), {
            signal: ctrl.signal,
            lastEventId: String(last),
            query: { type: o.type },
          })) {
            if (msg.event === 'shutdown') ctrl.abort();
            if (!msg.data || msg.event === 'shutdown') continue;
            const e = JSON.parse(msg.data) as DomainEvent;
            last = e.sequence;
            if (o.task && !JSON.stringify(e.payload).includes(o.task)) continue;
            print(e);
          }
        } catch (e) {
          if (ctrl.signal.aborted) break;
          process.stderr.write(`friday: stream interrupted (${(e as Error).message}); retrying...\n`);
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    });

  // ---- approvals and escalations ---------------------------------------------------------------

  const approvals = program
    .command('approvals')
    .description('approval requests: what an agent asked for, the risk, and how far a grant reaches')
    .option('--all', 'include decided ones')
    .action(async (o: { all?: boolean }) => {
      const { client } = operator(g());
      const res = await client.get<{ approvals: Record<string, string | null>[] }>(client.projectPath('/approvals'), {
        query: { status: o.all ? undefined : 'pending' },
      });
      out(g(), res.approvals, () =>
        res.approvals.length
          ? table(
              ['APPROVAL', 'STATUS', 'CAPABILITY', 'RISK', 'TARGET', 'TASK', 'REACH', 'USES', 'EXPIRES', 'PURPOSE'],
              res.approvals.map((a) => [
                a.approval_id,
                a.status,
                a.capability,
                a.risk ?? '',
                a.target,
                a.task_id ?? '',
                a.reuse ?? 'once',
                String(a.uses ?? 0),
                shortTime(a.expires_at),
                a.purpose,
              ]),
              { maxWidth: 48 },
            )
          : 'No pending approvals.',
      );
    });
  approvals
    .command('revoke <approval>')
    .description('withdraw an approval: no later use counts')
    .option('--note <text>', 'why')
    .action(async (id: string, o: { note?: string }) => {
      const { client } = operator(g());
      const res = await client.post(client.projectPath(`/approvals/${id}/revoke`), o.note ? { note: o.note } : {});
      out(g(), res, () => `${id}  revoked`);
    });
  for (const [verb, word] of [
    ['approve', 'granted'],
    ['reject', 'denied'],
  ] as const) {
    const cmd = program
      .command(`${verb} <approval>`)
      .description(
        verb === 'approve'
          ? 'grant a pending approval; it covers that exact target, for its task, under the current policy'
          : 'refuse a pending approval request',
      )
      .option('--note <text>', 'why (recorded with the decision)');
    if (verb === 'approve') {
      cmd
        .addOption(
          new Option(
            '--for <reach>',
            'how far it reaches: one use, this attempt, or the task (default: as requested)',
          ).choices(['once', 'run', 'task']),
        )
        .option('--ttl <duration>', 'how long it lasts, such as 30m or 2h (default: as requested)');
    }
    cmd.action(async (id: string, o: { note?: string; for?: 'once' | 'run' | 'task'; ttl?: string }) => {
      const { client } = operator(g());
      const ttl = o.ttl ? parseDuration(o.ttl) : undefined;
      const res = await client.post(client.projectPath(`/approvals/${id}/${verb}`), {
        ...(o.note ? { note: o.note } : {}),
        ...(o.for ? { reuse: o.for } : {}),
        ...(ttl ? { ttl_s: ttl } : {}),
      });
      out(g(), res, () => `${id}  ${word}${o.for ? ` (${o.for})` : ''}`);
    });
  }
  program
    .command('escalations')
    .description('questions waiting for a human, from agents and the Master Brain')
    .action(async () => {
      const { client } = operator(g());
      const res = await client.get<{ escalations: Parameters<typeof renderEscalation>[0][] }>(
        client.projectPath('/escalations'),
        { query: { status: 'pending' } },
      );
      out(g(), res.escalations, () =>
        res.escalations.length ? res.escalations.map(renderEscalation).join('\n\n') : 'No open questions.',
      );
    });
  program
    .command('answer <escalation> <text...>')
    .description('answer an agent question')
    .action(async (id: string, text: string[]) => {
      const { client } = operator(g());
      await client.post(client.projectPath(`/escalations/${id}/answer`), { answer: text.join(' ') });
      out(g(), { ok: true }, () => `${id}  answered`);
    });

  // ---- daemon and tokens -----------------------------------------------------------------------

  program
    .command('backup')
    .description('a consistent copy of the project database and artifacts, with a manifest (ADR-0018)')
    .requiredOption('--into <dir>', 'a new or empty directory')
    .action(async (o: { into: string }) => {
      const { client } = operator(g());
      const r = await client.post<{
        files: string[];
        event_head: number;
        into: string;
        artifacts: { files: number; bytes: number };
        skipped: { path: string; reason: string }[];
        problems: { artifact_id: string; path: string; problem: string }[];
        code: {
          included: boolean;
          reason?: string;
          bytes?: number;
          refs?: { kind: string }[];
          worktrees?: { task_id: string; files: number }[];
          skipped?: { task_id: string; path: string; reason: string }[];
        };
      }>('/admin/backup', { into: path.resolve(o.into) }, { timeoutMs: 600_000 });
      const count = (kind: string) => r.code.refs?.filter((x) => x.kind === kind).length ?? 0;
      out(g(), r, () =>
        [
          `Backed up ${r.files.join(', ')} at event ${r.event_head} to ${r.into} (${r.artifacts.files} artifact file(s)).`,
          ...r.skipped.map((x) => `  skipped ${x.path}: ${x.reason}`),
          ...r.problems.map(
            (x) => `  warning: ${x.path} (${x.artifact_id}) is ${x.problem} in the project's artifacts`,
          ),
          r.code.included
            ? `Code: ${count('task_branch')} task branch(es), ${count('goal_branch')} goal branch(es), ${count('preserved')} preserved state(s), the uncommitted work of ${count('uncommitted')} task worktree(s)${count('restored') ? ` and ${count('restored')} restored state(s) not used yet` : ''} (${Math.ceil((r.code.bytes ?? 0) / 1024)} KB with their history). Ignored files and your main checkout are not included.`
            : `Code: none (${r.code.reason}).`,
          ...(r.code.skipped ?? []).map(
            (x) => `  warning: the worktree of ${x.task_id} (${x.path}) was not read: ${x.reason}`,
          ),
          'No credential is included: after a restore every session registers again. Provider keys stay per user.',
        ].join('\n'),
      );
    });

  program
    .command('restore')
    .description('put a backup back (Friday must be stopped); the current state is set aside, not deleted')
    .requiredOption('--from <dir>', 'a folder made by "friday backup"')
    .action(async (o: { from: string }) => {
      const r = await restoreProject(project(g()), o.from);
      const by = (outcome: string) => r.code.refs.filter((x) => x.outcome === outcome).length;
      out(g(), r, () =>
        [
          `Restored the backup of ${r.backup_created_at ?? 'unknown date'} (event ${r.event_head}, ${r.artifacts} artifact file(s)).`,
          r.code.included
            ? `Code: ${r.code.refs.length} ref(s) from the backup: ${by('created')} added, ${by('advanced')} moved forward, ${by('unchanged')} already here, ${by('kept')} kept as they are in this clone.`
            : `Code: none in this backup (${r.code.reason}). Friday asks a human before it starts a task whose earlier work is not in this clone.`,
          ...r.code.refs
            .filter((x) => x.stored_at)
            .map((x) => `  ${x.ref} differs here; the backup's commit is kept as ${x.stored_at}`),
          ...r.code.uncommitted.map(
            (x) =>
              `  the uncommitted work of ${x.task_id} is at ${x.ref}: "friday recover ${x.task_id} --action reassign" brings it into a worktree of this clone`,
          ),
          r.set_aside ? `The state it replaced is in ${r.set_aside}.` : 'There was no state to replace.',
          'Start Friday with "friday run"; sessions register again, and work whose session does not come back is recovered as after a crash.',
        ].join('\n'),
      );
    });

  program
    .command('ui')
    .description('open the interface in your browser, already signed in (plan M9)')
    .option('--start', 'start Friday first (hidden, in the background) when it is not running')
    .option('--print-link', 'print the one-time sign-in link instead of opening it (it works once, for 60 s)')
    .option('--token', 'print the operator token for the legacy status page instead (it grants full control)')
    .action(async (o: { start?: boolean; printLink?: boolean; token?: boolean }) => {
      const ref = project(g());
      if (o.start && !(await runningDaemon(ref))) {
        process.stderr.write('Starting Friday...\n');
        await startDetached(ref);
      }
      const { client } = operator(g());
      if (o.token) {
        const token = readToken(ref, 'operator');
        out(
          g(),
          { url: `${client.baseUrl}/ui`, ...(token ? { token } : {}) },
          () => `${client.baseUrl}/ui${token ? `\noperator token: ${token}` : ''}`,
        );
        return;
      }
      const login = await client.post<{ url: string; redirect_file: string | null; expires_at: string }>(
        client.projectPath('/ui/login-codes'),
        {},
      );
      const address = login.url.split('#')[0] ?? `${client.baseUrl}/ui/`;
      if (o.printLink) {
        out(g(), { url: login.url, expires_at: login.expires_at }, () => login.url);
        return;
      }
      // The redirect file, so the one-time code is on no command line (LESSONS UI-22).
      openTarget(login.redirect_file ?? login.url);
      out(g(), { opened: true, address }, () => `Opened Friday for "${ref.name}" in your browser (${address}).`);
    });

  program
    .command('shortcut')
    .description('create a shortcut that opens Friday for this project, starting it when needed')
    .option('--no-desktop', 'not on the desktop')
    .option('--start-menu', 'also in the start menu (applications menu on Linux)')
    .action((o: { desktop: boolean; startMenu?: boolean }) => {
      const ref = project(g());
      const files = createShortcut(ref, { desktop: o.desktop, ...(o.startMenu ? { startMenu: true } : {}) });
      out(g(), { files }, () =>
        files.length
          ? [`Created:`, ...files.map((f) => `  ${f}`), 'Double-click it to open Friday, signed in.'].join('\n')
          : 'Nothing created: choose --start-menu or leave out --no-desktop.',
      );
    });

  program
    .command('token')
    .description('manage daemon tokens')
    .command('rotate')
    .description('issue new operator and bootstrap tokens; old ones stop working')
    .action(async () => {
      const { client } = operator(g());
      await client.post('/admin/rotate-tokens');
      out(g(), { ok: true }, () => 'Tokens rotated. Attached harnesses keep their own session tokens.');
    });

  program
    .command('daemon')
    .description('control the running daemon')
    .command('stop')
    .description('stop the daemon for this project')
    .action(async () => {
      const { client } = operator(g());
      await client.post('/admin/shutdown');
      out(g(), { ok: true }, () => 'Daemon is stopping.');
    });

  registerGoalCommands(program, g);
  registerIntentCommands(program, g);
  registerMessageCommands(program, g);
  registerGraphCommands(program, g);
  registerContextCommands(program, g);
  registerWorktreeCommands(program, g);
  registerReservationCommands(program, g);
  registerIntegrationCommands(program, g);
  registerRecoveryCommands(program, g);
  registerPolicyCommands(program, g);
  registerOperationCommands(program, g);
  registerRoutingCommands(program, g);
  registerReadinessCommands(program, g);
  registerHostsCommands(program, g);
  registerRegistryCommands(program, g);
  registerUsageCommands(program, g);
  registerMemoryCommands(program, g);
  registerLearningCommands(program, g);
  registerStartCommand(program, g);
  for (const plugin of commandPlugins) plugin(program);
  return program;
}

/** Parses argv and runs; returns the process exit code. */
export async function runCli(argv: string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(argv);
    return Number(process.exitCode ?? 0);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version' || err.code === 'commander.help')
        return 0;
      return 2;
    }
    const { exitCodeFor } = await import('./context.js');
    return exitCodeFor(err);
  }
}
