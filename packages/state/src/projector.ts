import { type SqlDatabase, type SqlValue, toJson } from '@friday/db';
import type { Projector, StoredEvent } from '@friday/events';
import { FridayError } from '@friday/protocol';
import { DOMAIN_TABLES } from './migrations.js';

type Encoder = string | { column: string; encode: (v: unknown) => SqlValue };

/** Columns an event's `changes` may touch, per table. Anything else is a bug and fails loudly. */
const TASK_CHANGES: Record<string, Encoder> = {
  waiting_reason: 'waiting_reason',
  reserved_for_agent_key: 'reserved_for_agent_key',
  assigned_agent_id: 'assigned_agent_id',
  assigned_harness_id: 'assigned_harness_id',
  current_run_id: 'current_run_id',
  started_at: 'started_at',
  completed_at: 'completed_at',
  cancelled_at: 'cancelled_at',
};
const RUN_CHANGES: Record<string, Encoder> = {
  outcome: 'outcome',
  session_ref: 'session_ref',
  accepted_at: 'accepted_at',
  suspended_at: 'suspended_at',
  ended_at: 'ended_at',
  claim: { column: 'claim_json', encode: (v) => (v === null ? null : toJson(v)) },
};
const HARNESS_CHANGES: Record<string, Encoder> = {
  shadow: { column: 'shadow', encode: (v) => (v ? 1 : 0) },
  requested_agent_key: 'requested_agent_key',
  host_pid: 'host_pid',
  host_session_id: 'host_session_id',
  host_cwd: 'host_cwd',
  version: 'version',
  protocol_version: 'protocol_version',
  enforcement_level: 'enforcement_level',
  capabilities: { column: 'capabilities_json', encode: (v) => toJson(v ?? {}) },
  disconnected_at: 'disconnected_at',
  terminated_at: 'terminated_at',
};
const AGENT_CHANGES: Record<string, Encoder> = {
  harness_id: 'harness_id',
  current_task_id: 'current_task_id',
  current_run_id: 'current_run_id',
  role: 'role',
  display_name: 'display_name',
};

type Payload = Record<string, unknown>;
const str = (v: unknown): string => String(v);
const opt = (v: unknown): SqlValue => (v === undefined ? null : (v as SqlValue));

/**
 * The only writer of domain tables (plan B5). Applied inside the same transaction as the event
 * append, and again by replay, so it must depend on nothing but the event.
 */
export class StateProjector implements Projector {
  constructor(private readonly db: SqlDatabase) {}

  reset(projectId: string): void {
    for (const table of DOMAIN_TABLES) this.db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
  }

  apply(e: StoredEvent): void {
    const p = e.payload as Payload;
    const t = e.type;
    switch (t) {
      case 'project.created':
        this.db
          .prepare('INSERT INTO projects (project_id, name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
          .run(e.project_id, str(p.name), str(p.root_path), e.occurred_at, e.occurred_at);
        return;
      case 'task.created':
        this.insertTask(e, p.task as Payload);
        return;
      case 'task.updated':
        this.update('tasks', 'task_id', str(p.task_id), p.changes as Payload, TASK_CHANGES, e, {});
        return;
      case 'run.created':
        this.insertRun(e, p.run as Payload);
        return;
      case 'run.paths_observed':
        this.mergeObservedPaths(str(p.run_id), (p.paths as string[]) ?? []);
        return;
      case 'harness.registered':
        this.insertHarness(e, p.harness as Payload);
        return;
      case 'harness.status_changed':
      case 'harness.updated':
        this.update('harnesses', 'harness_id', str(p.harness_id), (p.changes as Payload) ?? {}, HARNESS_CHANGES, e, {
          status: (p.transition as Payload | undefined)?.to,
        });
        return;
      case 'harness.session_bound':
        this.db
          .prepare(
            `INSERT INTO harness_sessions (project_id, vendor, host_session_id, harness_id, transcript_path, bound_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(project_id, vendor, host_session_id) DO UPDATE SET harness_id = excluded.harness_id,
               transcript_path = excluded.transcript_path, bound_at = excluded.bound_at`,
          )
          .run(
            e.project_id,
            str(p.vendor),
            str(p.host_session_id),
            str(p.harness_id),
            opt(p.transcript_path),
            e.occurred_at,
          );
        return;
      case 'agent.registered':
        this.insertAgent(e, p.agent as Payload);
        return;
      case 'agent.status_changed':
      case 'agent.updated':
        this.update('agents', 'agent_id', str(p.agent_id), (p.changes as Payload) ?? {}, AGENT_CHANGES, e, {
          status: (p.transition as Payload | undefined)?.to,
        });
        return;
      case 'verification.started':
        this.db
          .prepare(
            `INSERT INTO verification_runs (verification_id, project_id, task_id, run_id, status, started_at)
             VALUES (?, ?, ?, ?, 'RUNNING', ?)`,
          )
          .run(str(p.verification_id), e.project_id, str(p.task_id), opt(p.run_id), e.occurred_at);
        return;
      case 'verification.check_completed': {
        const c = p.check as Payload;
        this.db
          .prepare(
            `INSERT INTO verification_checks (check_id, verification_id, project_id, name, kind, status, exit_code, artifact_ref, summary)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            str(c.check_id),
            str(p.verification_id),
            e.project_id,
            str(c.name),
            str(c.kind),
            str(c.status),
            opt(c.exit_code),
            opt(c.artifact_ref),
            opt(c.summary),
          );
        return;
      }
      case 'verification.finished':
        this.db
          .prepare('UPDATE verification_runs SET status = ?, ended_at = ?, summary = ? WHERE verification_id = ?')
          .run(str(p.status), e.occurred_at, opt(p.summary), str(p.verification_id));
        return;
      case 'approval.requested': {
        const a = p.approval as Payload;
        this.db
          .prepare(
            `INSERT INTO approvals (approval_id, project_id, task_id, run_id, requested_by_kind, requested_by_id, capability,
               target, purpose, risk, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            str(a.approval_id),
            e.project_id,
            opt(a.task_id),
            opt(a.run_id),
            e.actor.kind,
            e.actor.id,
            str(a.capability),
            opt(a.target),
            opt(a.purpose),
            opt(a.risk),
            str(a.status),
            opt(a.expires_at),
            e.occurred_at,
          );
        return;
      }
      case 'approval.decided':
        this.db
          .prepare(
            'UPDATE approvals SET status = ?, decided_by_kind = ?, decided_by_id = ?, decided_at = ? WHERE approval_id = ?',
          )
          .run(str(p.status), e.actor.kind, e.actor.id, e.occurred_at, str(p.approval_id));
        return;
      case 'escalation.requested': {
        const x = p.escalation as Payload;
        this.db
          .prepare(
            `INSERT INTO escalations (escalation_id, project_id, task_id, run_id, requested_by_id, question, options_json, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run(
            str(x.escalation_id),
            e.project_id,
            opt(x.task_id),
            opt(x.run_id),
            e.actor.id,
            str(x.question),
            x.options ? toJson(x.options) : null,
            e.occurred_at,
          );
        return;
      }
      case 'escalation.answered':
        this.db
          .prepare("UPDATE escalations SET status = 'answered', answer = ?, answered_at = ? WHERE escalation_id = ?")
          .run(str(p.answer), e.occurred_at, str(p.escalation_id));
        return;
      case 'context.compiled': {
        const packet = p.packet as Payload;
        this.db
          .prepare(
            `INSERT INTO context_packets (context_id, project_id, task_id, recipient_id, created_at, state_version, packet_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            str(packet.context_id),
            e.project_id,
            opt(packet.task_id),
            str((packet.recipient as Payload).id),
            str(packet.created_at),
            Number(packet.state_version),
            toJson(packet),
          );
        return;
      }
      default:
        if (t.startsWith('task.') && p.transition) {
          this.update('tasks', 'task_id', str(p.task_id), (p.changes as Payload) ?? {}, TASK_CHANGES, e, {
            status: (p.transition as Payload).to,
          });
          return;
        }
        if (t.startsWith('run.') && p.transition) {
          this.update('task_runs', 'run_id', str(p.run_id), (p.changes as Payload) ?? {}, RUN_CHANGES, e, {
            status: (p.transition as Payload).to,
          });
          return;
        }
      // Observations (agent.event, policy.evaluated, communication.recorded, …) change no domain rows.
    }
  }

  private update(
    table: 'tasks' | 'task_runs' | 'harnesses' | 'agents',
    idColumn: string,
    id: string,
    changes: Payload,
    allowed: Record<string, Encoder>,
    e: StoredEvent,
    extra: { status?: unknown },
  ): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const enc = allowed[key];
      if (!enc) throw new FridayError('internal_error', `event ${e.type} may not change ${table}.${key}`);
      if (typeof enc === 'string') {
        sets.push(`${enc} = ?`);
        params.push(opt(value));
      } else {
        sets.push(`${enc.column} = ?`);
        params.push(enc.encode(value));
      }
    }
    if (extra.status !== undefined) {
      sets.push('status = ?');
      params.push(str(extra.status));
    }
    if (table === 'tasks') {
      sets.push('updated_at = ?', 'revision = revision + 1', 'last_event_sequence = ?');
      params.push(e.occurred_at, e.sequence);
    } else if (table !== 'task_runs') {
      sets.push('updated_at = ?');
      params.push(e.occurred_at);
    }
    if (sets.length === 0) return;
    const res = this.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${idColumn} = ?`).run(...params, id);
    if (res.changes !== 1) throw new FridayError('internal_error', `event ${e.type}: ${table} row ${id} not found`);
  }

  private insertTask(e: StoredEvent, t: Payload): void {
    const createdBy = (t.created_by as Payload | undefined) ?? { kind: e.actor.kind, id: e.actor.id };
    this.db
      .prepare(
        `INSERT INTO tasks (task_id, project_id, goal_id, plan_id, kind, summary, description, acceptance_criteria_json, status,
           priority, risk_level, scope_json, reserved_for_agent_key, created_by_kind, created_by_id, created_at, updated_at,
           last_event_sequence, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        str(t.task_id),
        e.project_id,
        opt(t.goal_id),
        opt(t.plan_id),
        str(t.kind),
        str(t.summary),
        opt(t.description),
        toJson(t.acceptance_criteria ?? []),
        str(t.priority),
        str(t.risk_level),
        t.scope ? toJson(t.scope) : null,
        opt(t.reserved_for_agent_key),
        str(createdBy.kind),
        str(createdBy.id),
        e.occurred_at,
        e.occurred_at,
        e.sequence,
      );
    const dep = this.db.prepare(
      'INSERT INTO task_dependencies (task_id, depends_on_task_id, project_id) VALUES (?, ?, ?)',
    );
    for (const d of (t.dependencies as string[] | undefined) ?? []) dep.run(str(t.task_id), d, e.project_id);
  }

  private insertRun(e: StoredEvent, r: Payload): void {
    this.db
      .prepare(
        `INSERT INTO task_runs (run_id, project_id, task_id, harness_id, agent_id, attempt, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'STARTING', ?)`,
      )
      .run(
        str(r.run_id),
        e.project_id,
        str(r.task_id),
        str(r.harness_id),
        str(r.agent_id),
        Number(r.attempt),
        e.occurred_at,
      );
  }

  private insertHarness(e: StoredEvent, h: Payload): void {
    this.db
      .prepare(
        `INSERT INTO harnesses (harness_id, project_id, harness_key, vendor, name, version, attach_mode, protocol_version,
           capabilities_json, status, enforcement_level, shadow, requested_agent_key, host_pid, host_session_id, host_cwd, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        str(h.harness_id),
        e.project_id,
        str(h.harness_key),
        str(h.vendor),
        str(h.name),
        opt(h.version),
        str(h.attach_mode),
        str(h.protocol_version),
        toJson(h.capabilities ?? {}),
        opt(h.enforcement_level),
        h.shadow ? 1 : 0,
        opt(h.requested_agent_key),
        opt(h.host_pid),
        opt(h.host_session_id),
        opt(h.host_cwd),
        e.occurred_at,
        e.occurred_at,
      );
  }

  private insertAgent(e: StoredEvent, a: Payload): void {
    this.db
      .prepare(
        `INSERT INTO agents (agent_id, project_id, agent_key, harness_id, role, display_name, status, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'REGISTERED', ?, ?)`,
      )
      .run(
        str(a.agent_id),
        e.project_id,
        str(a.agent_key),
        opt(a.harness_id),
        str(a.role ?? 'developer'),
        opt(a.display_name),
        e.occurred_at,
        e.occurred_at,
      );
  }

  private mergeObservedPaths(runId: string, paths: string[]): void {
    const row = this.db.prepare('SELECT observed_paths_json FROM task_runs WHERE run_id = ?').get<{
      observed_paths_json: string;
    }>(runId);
    if (!row) throw new FridayError('internal_error', `run.paths_observed: run ${runId} not found`);
    const merged = [...new Set([...(JSON.parse(row.observed_paths_json) as string[]), ...paths])].sort();
    this.db.prepare('UPDATE task_runs SET observed_paths_json = ? WHERE run_id = ?').run(toJson(merged), runId);
  }
}
