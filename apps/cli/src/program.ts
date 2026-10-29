import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentView, DomainEvent, HarnessView, RunView, TaskView, VerificationView } from '@friday/protocol';
import { newId, TaskStatus } from '@friday/protocol';
import { FRIDAY_DIR, FRIDAY_VERSION, readToken, renderInitialConfig, stateDir, writePrivateFile } from '@friday/sdk';
import { Command, CommanderError, Option } from 'commander';
import { type GlobalOptions, operator, out, project, UsageError } from './context.js';
import { registerContextCommands } from './context-cmd.js';
import { doctor, renderDoctor } from './doctor.js';
import { registerGoalCommands, renderEscalation } from './goals.js';
import { registerGraphCommands } from './graph.js';
import { registerMemoryCommands } from './memory.js';
import { registerMessageCommands } from './messages.js';
import { clip, describeEvent, kv, shortTime, table } from './output.js';
import { restoreProject } from './restore.js';
import { runDaemon } from './run.js';
import { FRIDAY_DIR_GITIGNORE } from './templates.js';

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** Extra commands contributed by adapters (M1c: `harness config`, `harness doctor`, `fixture init`). */
export const commandPlugins: ((program: Command) => void)[] = [];

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
      out(g(), { ...info, file }, () =>
        kv([
          ['install.json', file],
          ['node', info.node_path],
          ['cli', info.cli_entry ?? '(not built)'],
          ['mcp server', info.mcp_server_entry ?? '(not built yet)'],
        ]),
      );
    });

  program
    .command('init')
    .description('create .friday/config.yaml and .friday/.gitignore in the current repository')
    .option('--name <name>', 'project name (default: directory name)')
    .option('--force', 'rewrite .friday/.gitignore and keep the existing project id')
    .action((opts: { name?: string; force?: boolean }) => {
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
        writeFileSync(configPath, renderInitialConfig(newId('proj'), opts.name ?? path.basename(root)));
      }
      writeFileSync(path.join(dir, '.gitignore'), FRIDAY_DIR_GITIGNORE);
      const ref = project({ project: root });
      out(g(), { project_id: ref.project_id, name: ref.name, root: ref.root }, () =>
        [
          `Initialized Friday project "${ref.name}" (${ref.project_id})`,
          `  ${path.relative(process.cwd(), configPath) || configPath}  (commit this)`,
          '  .friday/.gitignore  (commit this; it keeps runtime files out of git)',
          'Next: friday run',
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
      }>(client.projectPath('/status'));
      out(g(), s, () =>
        [
          kv([
            ['project', `${ref.name} (${ref.project_id})`],
            ['daemon', client.baseUrl],
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
      if (o.description) body.description = o.description;
      if (o.criteria) body.acceptance_criteria = o.criteria;
      if (o.priority) body.priority = o.priority;
      if (o.risk) body.risk_level = o.risk;
      if (o.dependsOn) body.depends_on = o.dependsOn;
      if (o.scopeWrite || o.scopeRead) body.scope = { write: o.scopeWrite ?? [], read: o.scopeRead ?? [] };
      if (o.assign) body.assign_agent_key = o.assign;
      const t = await client.post<TaskView>(client.projectPath('/tasks'), body, { idempotencyKey: newId('msg') });
      out(
        g(),
        t,
        () =>
          `${t.task_id}  ${t.status}${t.reserved_for_agent_key ? `  reserved for ${t.reserved_for_agent_key}` : ''}  ${t.summary}`,
      );
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
          | { summary?: string; changed_paths?: string[]; discrepancies?: { path: string; note: string }[] }
          | null
          | undefined;
        const lines = [
          kv([
            ['task', t.task_id],
            ['status', t.waiting_reason ? `${t.status} (${t.waiting_reason})` : t.status],
            ['summary', t.summary],
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
        }
        if (d.verification) {
          lines.push(
            '',
            `verification ${d.verification.verification_id}: ${d.verification.status} ${d.verification.summary ?? ''}`,
          );
          for (const c of d.verification.checks) lines.push(`  ${c.name}: ${c.status} ${c.summary ?? ''}`);
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
    rework: 'send a FAILED task back for rework (READY, offered first to the agent that did it)',
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
          `${res.task.task_id}  ${res.task.status}`,
          ...res.verification.checks.map(
            (c) => `  ${c.name}: ${c.status}${c.exit_code !== null ? ` (exit ${c.exit_code})` : ''} ${c.summary ?? ''}`,
          ),
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

  program
    .command('approvals')
    .description('list approval requests')
    .option('--all', 'include decided ones')
    .action(async (o: { all?: boolean }) => {
      const { client } = operator(g());
      const res = await client.get<{ approvals: Record<string, string | null>[] }>(client.projectPath('/approvals'), {
        query: { status: o.all ? undefined : 'pending' },
      });
      out(g(), res.approvals, () =>
        res.approvals.length
          ? table(
              ['APPROVAL', 'STATUS', 'CAPABILITY', 'TARGET', 'PURPOSE', 'EXPIRES'],
              res.approvals.map((a) => [
                a.approval_id,
                a.status,
                a.capability,
                a.target,
                a.purpose,
                shortTime(a.expires_at),
              ]),
            )
          : 'No pending approvals.',
      );
    });
  for (const [verb, word] of [
    ['approve', 'granted'],
    ['reject', 'denied'],
  ] as const) {
    program
      .command(`${verb} <approval>`)
      .description(`${verb} a pending approval request`)
      .action(async (id: string) => {
        const { client } = operator(g());
        const res = await client.post(client.projectPath(`/approvals/${id}/${verb}`));
        out(g(), res, () => `${id}  ${word}`);
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
      }>('/admin/backup', { into: path.resolve(o.into) }, { timeoutMs: 600_000 });
      out(g(), r, () =>
        [
          `Backed up ${r.files.join(', ')} at event ${r.event_head} to ${r.into} (${r.artifacts.files} artifact file(s)).`,
          ...r.skipped.map((x) => `  skipped ${x.path}: ${x.reason}`),
          ...r.problems.map(
            (x) => `  warning: ${x.path} (${x.artifact_id}) is ${x.problem} in the project's artifacts`,
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
      out(g(), r, () =>
        [
          `Restored the backup of ${r.backup_created_at ?? 'unknown date'} (event ${r.event_head}, ${r.artifacts} artifact file(s)).`,
          r.set_aside ? `The state it replaced is in ${r.set_aside}.` : 'There was no state to replace.',
          'Start Friday with "friday run"; sessions register again, and work whose session does not come back is recovered as after a crash.',
        ].join('\n'),
      );
    });

  program
    .command('ui')
    .description('print the status page URL (and, with --token, the operator token to paste into it)')
    .option('--token', 'also print the operator token (it grants full control of this project)')
    .action((o: { token?: boolean }) => {
      const { client, ref } = operator(g());
      const token = o.token ? readToken(ref, 'operator') : undefined;
      out(
        g(),
        { url: `${client.baseUrl}/ui`, ...(token ? { token } : {}) },
        () => `${client.baseUrl}/ui${token ? `\noperator token: ${token}` : ''}`,
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
  registerMessageCommands(program, g);
  registerGraphCommands(program, g);
  registerContextCommands(program, g);
  registerMemoryCommands(program, g);
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
