import { type SqlDatabase, type SqlValue, toJson } from '@friday/db';
import type { Projector, StoredEvent } from '@friday/events';
import { FridayError } from '@friday/protocol';
import { DOMAIN_TABLES } from './migrations.js';

type Encoder = string | { column: string; encode: (v: unknown) => SqlValue };

/** Columns an event's `changes` may touch, per table. Anything else is a bug and fails loudly. */
const TASK_CHANGES: Record<string, Encoder> = {
  waiting_reason: 'waiting_reason',
  reserved_for_agent_key: 'reserved_for_agent_key',
  reserved_by: 'reserved_by',
  reserved_until: 'reserved_until',
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
  enforcement_status: 'enforcement_status',
  enforcement_basis: 'enforcement_basis',
  adapter_version: 'adapter_version',
  hooks_seen_at: 'hooks_seen_at',
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
      case 'task.reservation_released':
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
            `INSERT INTO escalations (escalation_id, project_id, task_id, run_id, requested_by_id, requested_by_kind, question,
               options_json, status, created_at, goal_id, kind, details_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          )
          .run(
            str(x.escalation_id),
            e.project_id,
            opt(x.task_id),
            opt(x.run_id),
            e.actor.id,
            e.actor.kind,
            str(x.question),
            x.options ? toJson(x.options) : null,
            e.occurred_at,
            opt(x.goal_id),
            opt(x.kind),
            x.details ? toJson(x.details) : null,
          );
        return;
      }
      case 'escalation.answered':
        this.db
          .prepare("UPDATE escalations SET status = 'answered', answer = ?, answered_at = ? WHERE escalation_id = ?")
          .run(str(p.answer), e.occurred_at, str(p.escalation_id));
        return;
      case 'goal.created':
        this.insertGoal(e, p.goal as Payload);
        return;
      case 'goal.updated':
      case 'goal.status_changed':
        this.updateGoal(e, str(p.goal_id), (p.changes as Payload) ?? {}, (p.transition as Payload | undefined)?.to);
        return;
      case 'plan.proposed':
        this.insertPlan(e, p.plan as Payload);
        return;
      case 'plan.approved':
      case 'plan.superseded':
      case 'plan.rejected':
      case 'plan.completed': {
        const tr = p.transition as Payload;
        const decided = e.type === 'plan.approved' || e.type === 'plan.rejected';
        const res = this.db
          .prepare(
            `UPDATE plans SET status = ?, decided_at = COALESCE(?, decided_at), decided_by_id = COALESCE(?, decided_by_id),
               decision_note = COALESCE(?, decision_note) WHERE plan_id = ? AND version = ?`,
          )
          .run(
            str(tr.to),
            decided ? e.occurred_at : null,
            decided ? e.actor.id : null,
            opt(p.note),
            str(p.plan_id),
            Number(p.version),
          );
        if (res.changes !== 1) {
          throw new FridayError(
            'internal_error',
            `event ${e.type}: plan ${str(p.plan_id)} v${str(p.version)} not found`,
          );
        }
        return;
      }
      case 'plan.task_materialized':
        this.db
          .prepare('UPDATE plan_tasks SET task_id = ? WHERE plan_id = ? AND version = ? AND key = ?')
          .run(str(p.task_id), str(p.plan_id), Number(p.version), str(p.key));
        return;
      case 'model.called':
        this.insertModelCall(e, p.call as Payload);
        return;
      case 'assignment.decided': {
        const a = p.assignment as Payload;
        this.db
          .prepare(
            `INSERT INTO agent_assignments (assignment_id, project_id, task_id, agent_key, mode, reason, scores_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            str(a.assignment_id),
            e.project_id,
            str(a.task_id),
            opt(a.agent_key),
            str(a.mode),
            str(a.reason),
            toJson(a.scores ?? []),
            e.occurred_at,
          );
        return;
      }
      // ---- agent messaging (M3, ADR-0017)
      case 'communication.sent': {
        const m = p.message as Payload;
        this.db
          .prepare(
            `INSERT INTO messages (message_id, project_id, sender_kind, sender_id, sender_key, target, mode, subject, body,
               body_artifact_ref, facts_json, priority, blocking, task_id, goal_id, correlation_id, response_to, reply_by,
               expires_at, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          )
          .run(
            str(m.message_id),
            e.project_id,
            str((m.sender as Payload).kind),
            str((m.sender as Payload).id),
            opt((m.sender as Payload).agent_key),
            str(m.target),
            str(m.mode),
            opt(m.subject),
            str(m.body),
            opt(m.body_artifact_ref),
            toJson(m.facts ?? []),
            str(m.priority),
            m.blocking ? 1 : 0,
            opt(m.task_id),
            opt(m.goal_id),
            str(m.correlation_id),
            opt(m.response_to),
            opt(m.reply_by),
            str(m.expires_at),
            e.occurred_at,
          );
        const ins = this.db.prepare(
          `INSERT INTO message_deliveries (delivery_id, project_id, message_id, recipient_kind, recipient_id, agent_id, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
        );
        for (const d of (p.deliveries as Payload[]) ?? []) {
          ins.run(
            str(d.delivery_id),
            e.project_id,
            str(m.message_id),
            str(d.recipient_kind),
            str(d.recipient_id),
            opt(d.agent_id),
            e.occurred_at,
          );
        }
        return;
      }
      case 'communication.delivered':
        this.updateDelivery(e, str(p.delivery_id), {
          state: 'delivered',
          attempts: Number(p.attempt),
          agent_id: p.agent_id,
          reserved_by_harness: p.harness_id ?? null,
          reserved_until: p.reserved_until ?? null,
          delivered_at: { keep: e.occurred_at },
          received_at: { keep: e.occurred_at },
        });
        return;
      case 'communication.acknowledged':
        for (const id of (p.delivery_ids as string[]) ?? []) {
          this.updateDelivery(e, id, {
            state: 'acknowledged',
            acknowledged_at: e.occurred_at,
            ended_at: e.occurred_at,
            end_reason: str(p.reason ?? 'acknowledged'),
            reserved_until: null,
          });
        }
        return;
      case 'communication.expired':
      case 'communication.dead_lettered':
        for (const id of (p.delivery_ids as string[]) ?? []) {
          this.updateDelivery(e, id, {
            state: e.type === 'communication.expired' ? 'expired' : 'dead',
            ended_at: e.occurred_at,
            end_reason: str(p.reason),
            reserved_until: null,
          });
        }
        if (p.message_id && e.type === 'communication.expired' && p.message_expired) {
          this.db
            .prepare("UPDATE messages SET status = 'expired', settled_reason = ?, settled_at = ? WHERE message_id = ?")
            .run(str(p.reason), e.occurred_at, str(p.message_id));
        }
        return;
      // ---- scoped memory (M4c, ADR-0021)
      case 'memory.recorded': {
        const m = p.memory as Payload;
        this.db
          .prepare(
            `INSERT INTO memories (memory_id, project_id, scope_type, scope_id, kind, subject, subject_key, content,
               content_hash, tags_json, source_events_json, source_kind, source_id, authority, verification_status,
               status, supersedes, superseded_by, needs_review, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?)`,
          )
          .run(
            str(m.memory_id),
            e.project_id,
            str(m.scope_type),
            str(m.scope_id),
            str(m.kind),
            str(m.subject),
            str(m.subject_key),
            str(m.content),
            str(m.content_hash),
            toJson(m.tags ?? []),
            toJson(m.source_events ?? []),
            str(m.source_kind),
            str(m.source_id),
            str(m.authority),
            str(m.verification_status),
            opt(m.supersedes),
            m.needs_review ? 1 : 0,
            e.occurred_at,
            e.occurred_at,
          );
        const link = this.db.prepare(
          'INSERT OR IGNORE INTO memory_links (project_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
        );
        for (const to of (p.contradicts as string[]) ?? [])
          link.run(e.project_id, str(m.memory_id), to, 'contradicts', e.occurred_at);
        return;
      }
      case 'memory.superseded': {
        const res = this.db
          .prepare(
            "UPDATE memories SET status = 'superseded', superseded_by = ?, needs_review = 0, updated_at = ? WHERE memory_id = ?",
          )
          .run(str(p.by), e.occurred_at, str(p.memory_id));
        if (res.changes !== 1)
          throw new FridayError('internal_error', `event ${e.type}: memory ${str(p.memory_id)} not found`);
        this.db
          .prepare(
            "INSERT OR IGNORE INTO memory_links (project_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, 'supersedes', ?)",
          )
          .run(e.project_id, str(p.by), str(p.memory_id), e.occurred_at);
        return;
      }
      case 'memory.approved':
        this.db
          .prepare(
            "UPDATE memories SET authority = 'human-approved', verification_status = 'verified', needs_review = 0, updated_at = ? WHERE memory_id = ?",
          )
          .run(e.occurred_at, str(p.memory_id));
        return;
      case 'memory.retracted':
        this.db
          .prepare("UPDATE memories SET status = 'retracted', needs_review = 0, updated_at = ? WHERE memory_id = ?")
          .run(e.occurred_at, str(p.memory_id));
        return;
      case 'communication.resolved':
        for (const id of (p.delivery_ids as string[]) ?? []) {
          this.updateDelivery(e, id, {
            state: 'resolved',
            ended_at: e.occurred_at,
            end_reason: `answered by ${str(p.by)}`,
            reserved_until: null,
          });
        }
        return;
      case 'communication.escalated':
        this.db
          .prepare('UPDATE messages SET escalated_at = ?, escalation_id = ? WHERE message_id = ?')
          .run(e.occurred_at, str(p.escalation_id), str(p.message_id));
        return;
      case 'communication.settled': {
        const res = this.db
          .prepare("UPDATE messages SET status = 'settled', settled_reason = ?, settled_at = ? WHERE message_id = ?")
          .run(str(p.reason), e.occurred_at, str(p.message_id));
        if (res.changes !== 1)
          throw new FridayError('internal_error', `event ${e.type}: message ${str(p.message_id)} not found`);
        return;
      }
      case 'context.compiled': {
        const packet = p.packet as Payload;
        this.db
          .prepare(
            `INSERT INTO context_packets (context_id, project_id, task_id, recipient_id, created_at, state_version, packet_json,
               explanation_json)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            str(packet.context_id),
            e.project_id,
            opt(packet.task_id),
            str((packet.recipient as Payload).id),
            str(packet.created_at),
            Number(packet.state_version),
            toJson(packet),
            p.explanation === undefined ? null : toJson(p.explanation),
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
        `INSERT INTO tasks (task_id, project_id, goal_id, plan_id, plan_version, plan_key, role, kind, summary, description,
           acceptance_criteria_json, status, priority, risk_level, scope_json, reserved_for_agent_key, reserved_by, reserved_until,
           created_by_kind, created_by_id, created_at, updated_at, last_event_sequence, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        str(t.task_id),
        e.project_id,
        opt(t.goal_id),
        opt(t.plan_id),
        opt(t.plan_version),
        opt(t.plan_key),
        opt(t.role),
        str(t.kind),
        str(t.summary),
        opt(t.description),
        toJson(t.acceptance_criteria ?? []),
        str(t.priority),
        str(t.risk_level),
        t.scope ? toJson(t.scope) : null,
        opt(t.reserved_for_agent_key),
        // M1/M2 events carry no reserved_by: a reservation made at creation came from a human's --assign.
        t.reserved_for_agent_key ? str(t.reserved_by ?? 'human') : null,
        opt(t.reserved_until),
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

  private insertGoal(e: StoredEvent, g: Payload): void {
    const by = (g.created_by as Payload | undefined) ?? { kind: e.actor.kind, id: e.actor.id };
    this.db
      .prepare(
        `INSERT INTO goals (goal_id, project_id, request, objective, constraints_json, outcomes_json, priority, status,
           created_by_kind, created_by_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      )
      .run(
        str(g.goal_id),
        e.project_id,
        str(g.request),
        opt(g.objective),
        toJson(g.constraints ?? []),
        toJson(g.outcomes ?? []),
        str(g.priority),
        str(by.kind),
        str(by.id),
        e.occurred_at,
        e.occurred_at,
      );
  }

  /** Sets delivery columns; `{ keep: v }` sets a column only while it is still empty. */
  private updateDelivery(e: StoredEvent, deliveryId: string, changes: Record<string, unknown>): void {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const [col, v] of Object.entries(changes)) {
      if (v === undefined) continue;
      if (v && typeof v === 'object' && 'keep' in (v as Payload)) {
        sets.push(`${col} = COALESCE(${col}, ?)`);
        params.push(opt((v as Payload).keep));
      } else {
        sets.push(`${col} = ?`);
        params.push(opt(v));
      }
    }
    const res = this.db
      .prepare(`UPDATE message_deliveries SET ${sets.join(', ')} WHERE delivery_id = ?`)
      .run(...params, deliveryId);
    if (res.changes !== 1) throw new FridayError('internal_error', `event ${e.type}: delivery ${deliveryId} not found`);
  }

  private updateGoal(e: StoredEvent, goalId: string, changes: Payload, status: unknown): void {
    const allowed: Record<string, Encoder> = {
      objective: 'objective',
      constraints: { column: 'constraints_json', encode: (v) => toJson(v ?? []) },
      outcomes: { column: 'outcomes_json', encode: (v) => toJson(v ?? []) },
      inferred_constraints: { column: 'inferred_constraints_json', encode: (v) => toJson(v ?? []) },
      inferred_outcomes: { column: 'inferred_outcomes_json', encode: (v) => toJson(v ?? []) },
      plan_id: 'plan_id',
      completed_at: 'completed_at',
    };
    const sets: string[] = ['updated_at = ?'];
    const params: SqlValue[] = [e.occurred_at];
    for (const [k, v] of Object.entries(changes)) {
      const enc = allowed[k];
      if (!enc) throw new FridayError('internal_error', `event ${e.type} may not change goals.${k}`);
      sets.push(`${typeof enc === 'string' ? enc : enc.column} = ?`);
      params.push(typeof enc === 'string' ? opt(v) : enc.encode(v));
    }
    if (status !== undefined) {
      sets.push('status = ?');
      params.push(str(status));
    }
    const res = this.db.prepare(`UPDATE goals SET ${sets.join(', ')} WHERE goal_id = ?`).run(...params, goalId);
    if (res.changes !== 1) throw new FridayError('internal_error', `event ${e.type}: goal ${goalId} not found`);
  }

  private insertPlan(e: StoredEvent, plan: Payload): void {
    this.db
      .prepare(
        `INSERT INTO plans (plan_id, version, project_id, goal_id, status, supersedes, summary, rationale, needs_human_json, trigger,
           proposed_by_kind, proposed_by_id, model_call_id, prompt_version, created_at)
         VALUES (?, ?, ?, ?, 'PROPOSED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        str(plan.plan_id),
        Number(plan.version),
        e.project_id,
        str(plan.goal_id),
        opt(plan.supersedes),
        str(plan.summary),
        opt(plan.rationale),
        plan.needs_human ? toJson(plan.needs_human) : null,
        str(plan.trigger),
        e.actor.kind,
        e.actor.id,
        opt(plan.model_call_id),
        opt(plan.prompt_version),
        e.occurred_at,
      );
    const insert = this.db.prepare(
      `INSERT INTO plan_tasks (plan_id, version, key, project_id, position, change, task_id, kind, summary, description,
         acceptance_criteria_json, depends_on_json, scope_json, role, priority, risk_level, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ((plan.tasks as Payload[] | undefined) ?? []).forEach((t, i) => {
      insert.run(
        str(plan.plan_id),
        Number(plan.version),
        str(t.key),
        e.project_id,
        i,
        str(t.change),
        opt(t.task_id),
        str(t.kind),
        str(t.summary),
        opt(t.description),
        toJson(t.acceptance_criteria ?? []),
        toJson(t.depends_on ?? []),
        toJson(t.scope ?? { write: [], read: [] }),
        str(t.role),
        str(t.priority),
        str(t.risk_level),
        opt(t.note),
      );
    });
  }

  private insertModelCall(e: StoredEvent, c: Payload): void {
    const u = (c.usage as Payload | undefined) ?? {};
    this.db
      .prepare(
        `INSERT INTO model_calls (call_id, project_id, goal_id, plan_id, purpose, prompt_version, provider, model, remote, status,
           error_code, error, attempt, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens,
           cache_write_1h_input_tokens, cost_usd, cost_known, cost_estimate_usd, latency_ms, request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        str(c.call_id),
        e.project_id,
        opt(c.goal_id),
        opt(c.plan_id),
        str(c.purpose),
        str(c.prompt_version),
        str(c.provider),
        str(c.model),
        c.remote ? 1 : 0,
        str(c.status),
        opt(c.error_code),
        opt(c.error),
        Number(c.attempt ?? 0),
        Number(u.input_tokens ?? 0),
        Number(u.output_tokens ?? 0),
        Number(u.cache_creation_input_tokens ?? 0),
        Number(u.cache_read_input_tokens ?? 0),
        Number(u.cache_write_1h_input_tokens ?? 0),
        // A null cost is unknown, not free (review F04); M2 events always carried a number.
        Number(c.cost_usd ?? 0),
        c.cost_usd === null ? 0 : 1,
        c.cost_estimate_usd === undefined || c.cost_estimate_usd === null ? null : Number(c.cost_estimate_usd),
        Number(c.latency_ms ?? 0),
        opt(c.request_id),
        e.occurred_at,
      );
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
           capabilities_json, status, enforcement_level, enforcement_status, enforcement_basis, adapter_version, hooks_seen_at, shadow,
           requested_agent_key, host_pid, host_session_id, host_cwd, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        opt(h.enforcement_status),
        opt(h.enforcement_basis),
        opt(h.adapter_version),
        opt(h.hooks_seen_at),
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
