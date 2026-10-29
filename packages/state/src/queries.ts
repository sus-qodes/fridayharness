import type { SqlDatabase, SqlValue } from '@friday/db';
import {
  type AgentView,
  type AssignmentView,
  type ContextPacket,
  type ControlState,
  type FileReservationView,
  FridayError,
  type GoalView,
  type HarnessView,
  type IntegrationView,
  type MessageView,
  type ModelCallView,
  type ModelEvidenceView,
  type OperationRunView,
  type PlanVersionView,
  type RoutingDecisionView,
  type RoutingPinView,
  type RunView,
  type TaskStatus,
  type TaskView,
  type VerificationView,
  type WorktreeView,
} from '@friday/protocol';
import {
  type AgentRow,
  type AssignmentRow,
  type CheckRow,
  type DeliveryRow,
  type GoalRow,
  type HarnessRow,
  type MessageRow,
  type ModelCallRow,
  type PlanRow,
  type PlanTaskRow,
  type RunRow,
  type TaskRow,
  toAgentView,
  toAssignmentView,
  toGoalView,
  toHarnessView,
  toMessageView,
  toModelCallView,
  toPlanVersionView,
  toRunView,
  toTaskView,
  toVerificationView,
  type VerificationRow,
} from './rows.js';

/** Harness view plus internal fields the service needs. */
export type HarnessRecord = HarnessView & {
  shadow: boolean;
  requested_agent_key: string | null;
  /** When a Friday hook first reached the daemon from this harness (review F09). */
  hooks_seen_at: string | null;
  /** The checkout the session runs in, as the host reported it (ADR-0023 §3). */
  host_cwd: string | null;
  /** The model the host reported for the session (ADR-0031 §7). */
  observed_model: string | null;
};
const toRecord = (row: HarnessRow): HarnessRecord => ({
  ...toHarnessView(row),
  shadow: Boolean(row.shadow),
  requested_agent_key: row.requested_agent_key,
  hooks_seen_at: row.hooks_seen_at ?? null,
  host_cwd: row.host_cwd ?? null,
  observed_model: (row as { observed_model?: string | null }).observed_model ?? null,
});

/** Laya's answer to a task's routing question (ADR-0031 §10). */
export interface LayaAnswerRecord {
  answer_id: string;
  task_id: string;
  question_id: string;
  checkpoint: string;
  choice: string;
  confidence: number;
  basis: string;
  options: number;
  created_at: string;
}

/** A threshold fitted for one Laya checkpoint and question shape. */
export interface LayaCalibrationRecord {
  checkpoint: string;
  shape: string;
  threshold: number | null;
  accuracy: number | null;
  coverage: number;
  support: number;
  target: number;
  source: string;
  created_at: string;
}

const LIVE_HARNESS = "('REGISTERED','READY','BUSY','DEGRADED','RECONNECTING')";

/**
 * Whether a granted approval covers a use (ADR-0027 §4–§5): under the current policy version,
 * bound to this task, and for `once` and `run` grants to this attempt and agent.
 */
function covers(
  a: {
    task_id: string | null;
    run_id: string | null;
    requested_by_kind: string;
    requested_by_id: string;
    reuse: string;
    policy_version: string | null;
  },
  use: { task_id: string | null; run_id: string | null; agent_id: string | null; policy_version: string | null },
): boolean {
  if (a.policy_version && use.policy_version && a.policy_version !== use.policy_version) return false;
  if (a.task_id && a.task_id !== use.task_id) return false;
  if (a.reuse === 'task') return true;
  if (a.run_id && a.run_id !== use.run_id) return false;
  return a.requested_by_kind !== 'agent' || a.requested_by_id === use.agent_id;
}

/** Read-only access to domain and operational tables. */
export class Queries {
  constructor(private readonly db: SqlDatabase) {}

  project(projectId: string): { project_id: string; name: string; root_path: string; created_at: string } | undefined {
    return this.db
      .prepare('SELECT project_id, name, root_path, created_at FROM projects WHERE project_id = ?')
      .get(projectId);
  }

  private deps(taskId: string): string[] {
    return this.db
      .prepare('SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ? ORDER BY depends_on_task_id')
      .all<{ depends_on_task_id: string }>(taskId)
      .map((r) => r.depends_on_task_id);
  }

  findTask(projectId: string, taskId: string): TaskView | undefined {
    const row = this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND task_id = ?')
      .get<TaskRow>(projectId, taskId);
    return row ? toTaskView(row, this.deps(row.task_id)) : undefined;
  }

  task(projectId: string, taskId: string): TaskView {
    const t = this.findTask(projectId, taskId);
    if (!t) throw new FridayError('task_not_found', `task ${taskId} not found`);
    return t;
  }

  tasks(projectId: string, opts: { statuses?: TaskStatus[]; limit?: number; liveSince?: string } = {}): TaskView[] {
    const statuses = opts.statuses ?? [];
    const filter = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    // `liveSince`: tasks not finished, or finished after that time, selected before the limit applies.
    const live = opts.liveSince ? " AND (status NOT IN ('COMPLETED','CANCELLED','ABANDONED') OR updated_at > ?)" : '';
    return this.db
      .prepare(`SELECT * FROM tasks WHERE project_id = ?${filter}${live} ORDER BY created_at, task_id LIMIT ?`)
      .all<TaskRow>(projectId, ...statuses, ...(opts.liveSince ? [opts.liveSince] : []), opts.limit ?? 500)
      .map((r) => toTaskView(r, this.deps(r.task_id)));
  }

  /** Dependencies that are not COMPLETED yet. */
  openDependencies(taskId: string): string[] {
    return this.db
      .prepare(
        `SELECT d.depends_on_task_id AS id FROM task_dependencies d LEFT JOIN tasks t ON t.task_id = d.depends_on_task_id
         WHERE d.task_id = ? AND (t.status IS NULL OR t.status <> 'COMPLETED')`,
      )
      .all<{ id: string }>(taskId)
      .map((r) => r.id);
  }

  /** Runs of a task that started work (were accepted), oldest first: its attempts (ADR-0026). */
  attemptsOf(taskId: string): RunView[] {
    return this.runs(taskId).filter((r) => r.accepted_at !== null);
  }

  /** Every task this one depends on. */
  dependencies(taskId: string): string[] {
    return this.db
      .prepare('SELECT depends_on_task_id AS id FROM task_dependencies WHERE task_id = ?')
      .all<{ id: string }>(taskId)
      .map((r) => r.id);
  }

  findRun(runId: string): RunView | undefined {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE run_id = ?').get<RunRow>(runId);
    return row ? toRunView(row) : undefined;
  }

  run(runId: string): RunView {
    const r = this.findRun(runId);
    if (!r) throw new FridayError('run_not_found', `run ${runId} not found`);
    return r;
  }

  runs(taskId: string): RunView[] {
    return this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY attempt')
      .all<RunRow>(taskId)
      .map(toRunView);
  }

  maxAttempt(taskId: string): number {
    return (
      this.db.prepare('SELECT MAX(attempt) AS m FROM task_runs WHERE task_id = ?').get<{ m: number | null }>(taskId)
        ?.m ?? 0
    );
  }

  activeRunForAgent(agentId: string): RunView | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM task_runs WHERE agent_id = ? AND status IN ('STARTING','ACTIVE') ORDER BY created_at DESC",
      )
      .get<RunRow>(agentId);
    return row ? toRunView(row) : undefined;
  }

  activeRunsForHarness(harnessId: string): RunView[] {
    return this.db
      .prepare("SELECT * FROM task_runs WHERE harness_id = ? AND status IN ('STARTING','ACTIVE')")
      .all<RunRow>(harnessId)
      .map(toRunView);
  }

  suspendedRunsFor(harnessId: string): RunView[] {
    return this.db
      .prepare("SELECT * FROM task_runs WHERE harness_id = ? AND status = 'SUSPENDED'")
      .all<RunRow>(harnessId)
      .map(toRunView);
  }

  private harnessSelect = `SELECT h.*, l.lease_expires_at, l.last_heartbeat_at FROM harnesses h
                           LEFT JOIN harness_leases l ON l.harness_id = h.harness_id`;

  findHarness(harnessId: string): HarnessRecord | undefined {
    const row = this.db.prepare(`${this.harnessSelect} WHERE h.harness_id = ?`).get<HarnessRow>(harnessId);
    return row ? toRecord(row) : undefined;
  }

  harness(harnessId: string): HarnessRecord {
    const h = this.findHarness(harnessId);
    if (!h) throw new FridayError('harness_not_found', `harness ${harnessId} not found`);
    return h;
  }

  /** Latest non-terminated harness with this key (keys embed pids, which the OS reuses). */
  harnessByKey(projectId: string, key: string): HarnessRecord | undefined {
    const row = this.db
      .prepare(
        `${this.harnessSelect} WHERE h.project_id = ? AND h.harness_key = ? AND h.status <> 'TERMINATED'
         ORDER BY h.registered_at DESC LIMIT 1`,
      )
      .get<HarnessRow>(projectId, key);
    return row ? toRecord(row) : undefined;
  }

  harnessBySession(projectId: string, vendor: string, sessionId: string): HarnessRecord | undefined {
    const row = this.db
      .prepare(
        `${this.harnessSelect} JOIN harness_sessions s ON s.harness_id = h.harness_id
         WHERE s.project_id = ? AND s.vendor = ? AND s.host_session_id = ? ORDER BY s.bound_at DESC LIMIT 1`,
      )
      .get<HarnessRow>(projectId, vendor, sessionId);
    return row ? toRecord(row) : undefined;
  }

  harnesses(projectId: string, opts: { all?: boolean } = {}): HarnessView[] {
    const filter = opts.all ? '' : " AND h.status <> 'TERMINATED'";
    return this.db
      .prepare(`${this.harnessSelect} WHERE h.project_id = ?${filter} ORDER BY h.registered_at`)
      .all<HarnessRow>(projectId)
      .map(toHarnessView);
  }

  isHarnessLive(harnessId: string, nowIso: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS ok FROM harnesses h JOIN harness_leases l ON l.harness_id = h.harness_id
         WHERE h.harness_id = ? AND h.status IN ${LIVE_HARNESS} AND l.lease_expires_at > ?`,
      )
      .get(harnessId, nowIso);
    return Boolean(row);
  }

  private agentSelect =
    `SELECT a.*, h.shadow AS harness_shadow FROM agents a LEFT JOIN harnesses h ON h.harness_id = a.harness_id`;

  findAgent(agentId: string): AgentView | undefined {
    const row = this.db.prepare(`${this.agentSelect} WHERE a.agent_id = ?`).get<AgentRow>(agentId);
    return row ? toAgentView(row) : undefined;
  }

  agent(agentId: string): AgentView {
    const a = this.findAgent(agentId);
    if (!a) throw new FridayError('agent_not_found', `agent ${agentId} not found`);
    return a;
  }

  agentByKey(projectId: string, key: string): AgentView | undefined {
    const row = this.db
      .prepare(`${this.agentSelect} WHERE a.project_id = ? AND a.agent_key = ?`)
      .get<AgentRow>(projectId, key);
    return row ? toAgentView(row) : undefined;
  }

  agents(projectId: string): AgentView[] {
    return this.db
      .prepare(`${this.agentSelect} WHERE a.project_id = ? ORDER BY a.agent_key`)
      .all<AgentRow>(projectId)
      .map(toAgentView);
  }

  latestVerification(taskId: string): VerificationView | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM verification_runs WHERE task_id = ? ORDER BY started_at DESC, verification_id DESC LIMIT 1',
      )
      .get<VerificationRow>(taskId);
    return row ? this.verificationView(row) : undefined;
  }

  verification(verificationId: string): VerificationView {
    const row = this.db
      .prepare('SELECT * FROM verification_runs WHERE verification_id = ?')
      .get<VerificationRow>(verificationId);
    if (!row) throw new FridayError('invalid_request', `verification ${verificationId} not found`);
    return this.verificationView(row);
  }

  /** Verifications with a status, oldest first (the daemon ends RUNNING ones it does not run, ADR-0024 §6). */
  verificationsWithStatus(projectId: string, status: string): VerificationView[] {
    return this.db
      .prepare(
        'SELECT * FROM verification_runs WHERE project_id = ? AND status = ? ORDER BY started_at, verification_id',
      )
      .all<VerificationRow>(projectId, status)
      .map((row) => this.verificationView(row));
  }

  private verificationView(row: VerificationRow): VerificationView {
    const checks = this.db
      .prepare(
        'SELECT name, kind, status, exit_code, artifact_ref, summary, required, origin, duration_ms, details_json FROM verification_checks WHERE verification_id = ? ORDER BY rowid',
      )
      .all<CheckRow>(row.verification_id);
    return toVerificationView(row, checks);
  }

  /** The newest packet compiled for an agent about a task: what that agent was given (LESSONS D-49). */
  deliveredPacketId(projectId: string, taskId: string, agentId: string): string | undefined {
    return this.db
      .prepare(
        'SELECT context_id FROM context_packets WHERE project_id = ? AND task_id = ? AND recipient_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get<{ context_id: string }>(projectId, taskId, agentId)?.context_id;
  }

  contextPacket(contextId: string): ContextPacket | undefined {
    const row = this.db
      .prepare('SELECT packet_json FROM context_packets WHERE context_id = ?')
      .get<{ packet_json: string }>(contextId);
    return row ? (JSON.parse(row.packet_json) as ContextPacket) : undefined;
  }

  runsWithStatus(projectId: string, statuses: string[]): RunView[] {
    return this.db
      .prepare(
        `SELECT * FROM task_runs WHERE project_id = ? AND status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at, run_id`,
      )
      .all<RunRow>(projectId, ...statuses)
      .map(toRunView);
  }

  /** Task worktrees of the project, newest first (ADR-0023). */
  worktrees(projectId: string, statuses?: WorktreeView['status'][]): WorktreeView[] {
    const rows = this.db
      .prepare('SELECT * FROM worktrees WHERE project_id = ? ORDER BY created_at DESC, worktree_id DESC')
      .all<WorktreeView>(projectId);
    return statuses ? rows.filter((w) => statuses.includes(w.status)) : rows;
  }

  /** Integration attempts, oldest first; for one goal or one task (ADR-0025). */
  integrations(projectId: string, filter: { goal_id?: string; task_id?: string } = {}): IntegrationView[] {
    return this.db
      .prepare('SELECT * FROM integrations WHERE project_id = ? ORDER BY created_at, rowid')
      .all<Record<string, unknown>>(projectId)
      .filter(
        (r) => (!filter.goal_id || r.goal_id === filter.goal_id) && (!filter.task_id || r.task_id === filter.task_id),
      )
      .map((r) => ({
        integration_id: String(r.integration_id),
        goal_id: String(r.goal_id),
        task_id: String(r.task_id),
        status: r.status as IntegrationView['status'],
        branch: (r.branch as string | null) ?? null,
        task_commit: (r.task_commit as string | null) ?? null,
        base_commit: (r.base_commit as string | null) ?? null,
        merged_commit: (r.merged_commit as string | null) ?? null,
        conflicts: JSON.parse(String(r.conflicts_json ?? '[]')) as string[],
        checks: JSON.parse(String(r.checks_json ?? '[]')) as IntegrationView['checks'],
        summary: (r.summary as string | null) ?? null,
        created_at: String(r.created_at),
      }));
  }

  /** The latest integration attempt of a task, if any. */
  latestIntegration(projectId: string, taskId: string): IntegrationView | undefined {
    return this.integrations(projectId, { task_id: taskId }).at(-1);
  }

  /** A human's routing pins (ADR-0031 §4); `now` keeps only those still in force. */
  routingPins(projectId: string, now?: string): RoutingPinView[] {
    return this.db
      .prepare('SELECT * FROM routing_pins WHERE project_id = ? ORDER BY created_at, rowid')
      .all<Record<string, unknown>>(projectId)
      .map(toPinView)
      .filter((p) => !now || (p.revoked_at === null && (p.until === null || p.until > now)));
  }

  routingPin(pinId: string): RoutingPinView | undefined {
    const row = this.db.prepare('SELECT * FROM routing_pins WHERE pin_id = ?').get<Record<string, unknown>>(pinId);
    return row ? toPinView(row) : undefined;
  }

  /** Routing decisions, newest first; for one task when given. */
  routingDecisions(projectId: string, filter: { task_id?: string; limit?: number } = {}): RoutingDecisionView[] {
    const rows = filter.task_id
      ? this.db
          .prepare(
            'SELECT * FROM routing_decisions WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
          )
          .all<Record<string, unknown>>(projectId, filter.task_id, filter.limit ?? 50)
      : this.db
          .prepare('SELECT * FROM routing_decisions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
          .all<Record<string, unknown>>(projectId, filter.limit ?? 50);
    return rows.map((r) => ({
      ...(JSON.parse(String(r.decision_json)) as Omit<
        RoutingDecisionView,
        'decision_id' | 'task_id' | 'run_id' | 'harness_id' | 'created_at'
      >),
      decision_id: String(r.decision_id),
      task_id: String(r.task_id),
      run_id: (r.run_id as string | null) ?? null,
      harness_id: (r.harness_id as string | null) ?? null,
      created_at: String(r.created_at),
    }));
  }

  routingDecision(decisionId: string): RoutingDecisionView | undefined {
    const row = this.db
      .prepare('SELECT project_id, task_id FROM routing_decisions WHERE decision_id = ?')
      .get<{ project_id: string; task_id: string }>(decisionId);
    if (!row) return undefined;
    return this.routingDecisions(row.project_id, { task_id: row.task_id, limit: 1000 }).find(
      (d) => d.decision_id === decisionId,
    );
  }

  /** Laya's latest answer for a task (ADR-0031 §10). */
  layaAnswer(projectId: string, taskId: string): LayaAnswerRecord | undefined {
    const r = this.db
      .prepare(
        'SELECT * FROM laya_answers WHERE project_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      )
      .get<Record<string, unknown>>(projectId, taskId);
    return r
      ? {
          answer_id: String(r.answer_id),
          task_id: String(r.task_id),
          question_id: String(r.question_id),
          checkpoint: String(r.checkpoint),
          choice: String(r.choice),
          confidence: Number(r.confidence),
          basis: String(r.basis),
          options: Number(r.options),
          created_at: String(r.created_at),
        }
      : undefined;
  }

  /** The thresholds in force: the latest fit per checkpoint and question shape. */
  layaCalibrations(projectId: string): LayaCalibrationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM laya_calibrations WHERE project_id = ? ORDER BY created_at, rowid')
      .all<Record<string, unknown>>(projectId);
    const latest = new Map<string, LayaCalibrationRecord>();
    for (const r of rows) {
      latest.set(`${r.checkpoint} ${r.shape}`, {
        checkpoint: String(r.checkpoint),
        shape: String(r.shape),
        threshold: r.threshold === null ? null : Number(r.threshold),
        accuracy: r.accuracy === null ? null : Number(r.accuracy),
        coverage: Number(r.coverage),
        support: Number(r.support),
        target: Number(r.target),
        source: String(r.source),
        created_at: String(r.created_at),
      });
    }
    return [...latest.values()];
  }

  /** Measured outcomes per model and task class (ADR-0031 §8). */
  /**
   * Verified outcomes per model and task class (ADR-0031 §8, review F15). Only outcomes of a model
   * observed running are measured (`samples`); one only requested is `assumed`. Measured outcomes
   * count in one cohort: judged by the current checks for their kind (`checksVersion`; a human's
   * own result counts in any) and, when
   * given, on the same host version (`hostCohort`), at most the latest `window` of them; the rest
   * are `other_cohorts`.
   */
  modelEvidence(
    projectId: string,
    cohort: { checksVersion?: (kind: string) => string | null; hostCohort?: string | null; window?: number } = {},
  ): ModelEvidenceView[] {
    const rows = this.db
      .prepare(
        `SELECT model, task_class, task_kind, basis, outcome, duration_ms, harness_version, checks_version
           FROM model_outcomes WHERE project_id = ? ORDER BY rowid DESC`,
      )
      .all<{
        model: string;
        task_class: string;
        task_kind: string | null;
        basis: string;
        outcome: string;
        duration_ms: number | null;
        harness_version: string | null;
        checks_version: string | null;
      }>(projectId);
    const window = cohort.window ?? 50;
    const groups = new Map<
      string,
      {
        model: string;
        task_class: string;
        passed: number;
        failed: number;
        assumed: number;
        other: number;
        durations: number[];
      }
    >();
    for (const r of rows) {
      const key = `${r.model} ${r.task_class}`;
      const g = groups.get(key) ?? {
        model: r.model,
        task_class: r.task_class,
        passed: 0,
        failed: 0,
        assumed: 0,
        other: 0,
        durations: [],
      };
      groups.set(key, g);
      if (r.basis !== 'observed') {
        g.assumed += 1;
        continue;
      }
      const checks = cohort.checksVersion ? cohort.checksVersion(r.task_kind ?? r.task_class) : undefined;
      // A human's own verdict (`manual`) judged the work itself, not through checks: it counts in any.
      const sameChecks =
        checks === undefined ||
        r.checks_version === 'manual' ||
        (r.checks_version !== null && r.checks_version === checks);
      const sameHost = !cohort.hostCohort || r.harness_version === cohort.hostCohort;
      if (!sameChecks || !sameHost || g.passed + g.failed >= window) {
        g.other += 1;
        continue;
      }
      if (r.outcome === 'passed') g.passed += 1;
      else g.failed += 1;
      if (r.duration_ms !== null) g.durations.push(r.duration_ms);
    }
    return [...groups.values()]
      .map((g) => {
        const d = [...g.durations].sort((a, b) => a - b);
        return {
          model: g.model,
          task_class: g.task_class,
          samples: g.passed + g.failed,
          passed: g.passed,
          failed: g.failed,
          reworked: 0,
          assumed: g.assumed,
          other_cohorts: g.other,
          median_duration_ms: d.length ? (d[Math.floor((d.length - 1) / 2)] ?? null) : null,
        };
      })
      .sort((a, b) => a.model.localeCompare(b.model) || a.task_class.localeCompare(b.task_class));
  }

  /** Runs of operations by the gateway (ADR-0029), newest first. */
  operationRuns(
    projectId: string,
    filter: { task_id?: string; status?: OperationRunView['status']; limit?: number } = {},
  ): OperationRunView[] {
    const where = ['project_id = ?'];
    const args: SqlValue[] = [projectId];
    if (filter.task_id) {
      where.push('task_id = ?');
      args.push(filter.task_id);
    }
    if (filter.status) {
      where.push('status = ?');
      args.push(filter.status);
    }
    return this.db
      .prepare(`SELECT * FROM operation_runs WHERE ${where.join(' AND ')} ORDER BY started_at DESC, rowid DESC LIMIT ?`)
      .all<Record<string, unknown>>(...args, filter.limit ?? 100)
      .map(toOperationRunView);
  }

  operationRun(operationRunId: string): OperationRunView | undefined {
    const row = this.db
      .prepare('SELECT * FROM operation_runs WHERE operation_run_id = ?')
      .get<Record<string, unknown>>(operationRunId);
    return row ? toOperationRunView(row) : undefined;
  }

  /** A request still waiting for a human for exactly this use (so asking again opens no second one). */
  pendingApproval(
    projectId: string,
    use: { capability: string; target: string; task_id: string | null; run_id: string | null; agent_id: string },
    nowIso: string,
  ): { approval_id: string; expires_at: string | null } | undefined {
    return this.db
      .prepare(
        `SELECT approval_id, expires_at FROM approvals WHERE project_id = ? AND capability = ? AND target = ?
           AND status = 'pending' AND requested_by_kind = 'agent' AND requested_by_id = ?
           AND task_id IS ? AND run_id IS ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get<{ approval_id: string; expires_at: string | null }>(
        projectId,
        use.capability,
        use.target,
        use.agent_id,
        use.task_id,
        use.run_id,
        nowIso,
      );
  }

  /** File reservations of the project, oldest first (ADR-0025). */
  fileReservations(projectId: string, statuses?: FileReservationView['status'][]): FileReservationView[] {
    const rows = this.db
      .prepare('SELECT * FROM file_reservations WHERE project_id = ? ORDER BY acquired_at, reservation_id')
      .all<FileReservationView & { project_id?: string }>(projectId)
      .map(({ project_id: _p, ...r }) => r as FileReservationView);
    return statuses ? rows.filter((r) => statuses.includes(r.status)) : rows;
  }

  fileReservation(reservationId: string): FileReservationView | undefined {
    const row = this.db
      .prepare('SELECT * FROM file_reservations WHERE reservation_id = ?')
      .get<FileReservationView & { project_id?: string }>(reservationId);
    if (!row) return undefined;
    const { project_id: _p, ...r } = row;
    return r as FileReservationView;
  }

  /** The task's worktree that still holds its work (active or preserved), if any. */
  worktreeForTask(taskId: string): WorktreeView | undefined {
    return this.db
      .prepare(
        "SELECT * FROM worktrees WHERE task_id = ? AND status IN ('active', 'preserved') ORDER BY created_at DESC LIMIT 1",
      )
      .get<WorktreeView>(taskId);
  }

  /** The active or preserved worktree at a path (case-insensitive on Windows). */
  worktreeAt(projectId: string, dir: string): WorktreeView | undefined {
    const norm = (p: string) => {
      const forward = p.replace(/[\\/]+/g, '/').replace(/\/$/, '');
      return process.platform === 'win32' ? forward.toLowerCase() : forward;
    };
    const want = norm(dir);
    return this.worktrees(projectId, ['active', 'preserved']).find((w) => norm(w.path) === want);
  }

  /** The explanation stored with a packet (ADR-0022 §8). */
  contextExplanation(contextId: string): unknown | undefined {
    const row = this.db
      .prepare('SELECT explanation_json FROM context_packets WHERE context_id = ?')
      .get<{ explanation_json: string | null }>(contextId);
    return row?.explanation_json ? JSON.parse(row.explanation_json) : undefined;
  }

  approvals(projectId: string, status?: string): Record<string, unknown>[] {
    return status
      ? this.db
          .prepare('SELECT * FROM approvals WHERE project_id = ? AND status = ? ORDER BY created_at')
          .all(projectId, status)
      : this.db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at').all(projectId);
  }

  /** Valid, unexpired grants for a capability and target. */
  /**
   * The approval that covers a use right now (ADR-0027 §4–§5): granted, not expired, under the
   * current policy version, for this capability and exact target, and bound to this task — and for
   * `once` and `run` grants to this attempt and agent. The oldest usable one, or undefined.
   */
  usableApproval(
    projectId: string,
    use: {
      capability: string;
      target: string;
      task_id: string | null;
      run_id: string | null;
      agent_id: string | null;
      policy_version: string | null;
      now: string;
    },
  ): string | undefined {
    const rows = this.db
      .prepare(
        `SELECT approval_id, task_id, run_id, requested_by_kind, requested_by_id, reuse, policy_version FROM approvals
         WHERE project_id = ? AND capability = ? AND target = ? AND status = 'granted'
           AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at, approval_id`,
      )
      .all<{
        approval_id: string;
        task_id: string | null;
        run_id: string | null;
        requested_by_kind: string;
        requested_by_id: string;
        reuse: string;
        policy_version: string | null;
      }>(projectId, use.capability, use.target, use.now);
    // When several grants cover a use, the narrowest is spent first and broader ones are kept.
    const reach: Record<string, number> = { once: 0, run: 1, task: 2 };
    rows.sort((x, y) => (reach[x.reuse] ?? 0) - (reach[y.reuse] ?? 0));
    return rows.find((a) => covers(a, use))?.approval_id;
  }

  /**
   * Every grant of a capability that covers this task's uses right now, whatever its target (the
   * rule of `usableApproval`), oldest first: what the context compiler may show anyway (review F02).
   */
  usableGrants(
    projectId: string,
    use: {
      capability: string;
      task_id: string | null;
      run_id: string | null;
      agent_id: string | null;
      policy_version: string | null;
      now: string;
      /**
       * Also grants already spent on the use they allowed (`used`): what verification needs to know
       * the write it judges was approved (review F03). Default: only grants still usable.
       */
      spent?: boolean;
    },
  ): { approval_id: string; target: string }[] {
    const statuses = use.spent ? "('granted', 'used')" : "('granted')";
    return this.db
      .prepare(
        `SELECT approval_id, target, task_id, run_id, requested_by_kind, requested_by_id, reuse, policy_version FROM approvals
         WHERE project_id = ? AND capability = ? AND status IN ${statuses} AND target IS NOT NULL
           AND (status = 'used' OR expires_at IS NULL OR expires_at > ?) ORDER BY created_at, approval_id`,
      )
      .all<{
        approval_id: string;
        target: string;
        task_id: string | null;
        run_id: string | null;
        requested_by_kind: string;
        requested_by_id: string;
        reuse: string;
        policy_version: string | null;
      }>(projectId, use.capability, use.now)
      .filter((a) => covers(a, use))
      .map((a) => ({ approval_id: a.approval_id, target: a.target }));
  }

  grantedApproval(projectId: string, capability: string, target: string, nowIso: string): boolean {
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM approvals WHERE project_id = ? AND capability = ? AND target = ? AND status = 'granted'
           AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(projectId, capability, target, nowIso),
    );
  }

  /** Answered `unanswered_request` escalations whose request is still open: the reply was never sent. */
  unrepliedAnswers(projectId: string): { escalation_id: string; answer: string }[] {
    return this.db
      .prepare(
        `SELECT e.escalation_id, e.answer FROM escalations e
           JOIN messages m ON m.message_id = json_extract(e.details_json, '$.message_id')
          WHERE e.project_id = ? AND e.kind = 'unanswered_request' AND e.status = 'answered' AND m.status = 'open'
          ORDER BY e.created_at`,
      )
      .all<{ escalation_id: string; answer: string }>(projectId);
  }

  escalations(projectId: string, status?: string): Record<string, unknown>[] {
    return status
      ? this.db
          .prepare('SELECT * FROM escalations WHERE project_id = ? AND status = ? ORDER BY created_at')
          .all(projectId, status)
      : this.db.prepare('SELECT * FROM escalations WHERE project_id = ? ORDER BY created_at').all(projectId);
  }

  /** Pause, resume and halt (M9, docs/frontend/PLAN.md §5.4). */
  control(projectId: string): ControlState {
    const r = this.db
      .prepare('SELECT paused, reason, changed_at, changed_by, halted_at FROM project_controls WHERE project_id = ?')
      .get<{
        paused: number;
        reason: string | null;
        changed_at: string | null;
        changed_by: string | null;
        halted_at: string | null;
      }>(projectId);
    return {
      paused: r?.paused === 1,
      reason: r?.reason ?? null,
      changed_at: r?.changed_at ?? null,
      changed_by: r?.changed_by ?? null,
      halted_at: r?.halted_at ?? null,
    };
  }

  statusCounts(projectId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db
      .prepare('SELECT status, count(*) AS n FROM tasks WHERE project_id = ? GROUP BY status')
      .all<{ status: string; n: number }>(projectId)) {
      out[r.status] = r.n;
    }
    return out;
  }

  /**
   * Per goal, in one grouped read: its tasks except cancelled and abandoned ones, and how many of
   * those completed. A goal without such tasks is absent.
   */
  goalProgress(projectId: string, goalIds: readonly string[]): Record<string, { total: number; completed: number }> {
    const out: Record<string, { total: number; completed: number }> = {};
    if (!goalIds.length) return out;
    for (const r of this.db
      .prepare(
        `SELECT goal_id, count(*) AS total, sum(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed
           FROM tasks
          WHERE project_id = ? AND goal_id IN (${goalIds.map(() => '?').join(',')})
            AND status NOT IN ('CANCELLED','ABANDONED')
          GROUP BY goal_id`,
      )
      .all<{ goal_id: string; total: number; completed: number }>(projectId, ...goalIds)) {
      out[r.goal_id] = { total: Number(r.total), completed: Number(r.completed) };
    }
    return out;
  }

  /**
   * Per task, in one grouped read: the tool calls its agents' hosts reported finished, completed or
   * failed (`agent.event` `tool.completed` and `tool.failed`), in the events after sequence `after`
   * up to `upTo`, over every attempt. The task is the one the payload names (every producer of
   * `agent.event` names it there and in the event's task reference). The read goes through the
   * index on (project, type, sequence), so a caller that keeps the totals reads only the events
   * since its last read, not the whole history. A task without any is absent.
   */
  toolCallCounts(projectId: string, after: number, upTo: number): Record<string, number> {
    const out: Record<string, number> = {};
    if (upTo <= after) return out;
    for (const r of this.db
      .prepare(
        `SELECT json_extract(payload_json, '$.task_id') AS task_id, count(*) AS n
           FROM events
          WHERE project_id = ? AND type = 'agent.event' AND sequence > ? AND sequence <= ?
            AND json_extract(payload_json, '$.event_type') IN ('tool.completed','tool.failed')
            AND json_extract(payload_json, '$.task_id') IS NOT NULL
          GROUP BY 1`,
      )
      .all<{ task_id: string; n: number }>(projectId, after, upTo)) {
      out[r.task_id] = Number(r.n);
    }
    return out;
  }

  pendingOutboxCount(harnessId: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM outbox_messages WHERE harness_id = ? AND status IN ('queued','delivered')")
        .get<{ n: number }>(harnessId)?.n ?? 0
    );
  }
  // ---- Master Brain (M2) ---------------------------------------------------------------------

  findGoal(projectId: string, goalId: string): GoalView | undefined {
    const row = this.db
      .prepare('SELECT * FROM goals WHERE project_id = ? AND goal_id = ?')
      .get<GoalRow>(projectId, goalId);
    return row ? toGoalView(row) : undefined;
  }

  goal(projectId: string, goalId: string): GoalView {
    const g = this.findGoal(projectId, goalId);
    if (!g) throw new FridayError('goal_not_found', `goal ${goalId} not found`);
    return g;
  }

  goals(projectId: string, opts: { statuses?: string[]; limit?: number; liveSince?: string } = {}): GoalView[] {
    const statuses = opts.statuses ?? [];
    const filter = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    // `liveSince`: goals open or active, or changed after that time, selected before the limit applies.
    const live = opts.liveSince ? " AND (status IN ('OPEN','ACTIVE') OR updated_at > ?)" : '';
    return this.db
      .prepare(`SELECT * FROM goals WHERE project_id = ?${filter}${live} ORDER BY created_at, goal_id LIMIT ?`)
      .all<GoalRow>(projectId, ...statuses, ...(opts.liveSince ? [opts.liveSince] : []), opts.limit ?? 200)
      .map(toGoalView);
  }

  private planTaskRows(planId: string, version: number): PlanTaskRow[] {
    return this.db
      .prepare('SELECT * FROM plan_tasks WHERE plan_id = ? AND version = ? ORDER BY position')
      .all<PlanTaskRow>(planId, version);
  }

  planVersion(planId: string, version: number): PlanVersionView | undefined {
    const row = this.db.prepare('SELECT * FROM plans WHERE plan_id = ? AND version = ?').get<PlanRow>(planId, version);
    return row ? toPlanVersionView(row, this.planTaskRows(planId, version)) : undefined;
  }

  /** Every version of a plan, oldest first. */
  planVersions(planId: string): PlanVersionView[] {
    return this.db
      .prepare('SELECT * FROM plans WHERE plan_id = ? ORDER BY version')
      .all<PlanRow>(planId)
      .map((row) => toPlanVersionView(row, this.planTaskRows(row.plan_id, row.version)));
  }

  /** The newest version with one of these statuses (any status when omitted). */
  latestPlanVersion(planId: string, statuses: string[] = []): PlanVersionView | undefined {
    const filter = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    const row = this.db
      .prepare(`SELECT * FROM plans WHERE plan_id = ?${filter} ORDER BY version DESC LIMIT 1`)
      .get<PlanRow>(planId, ...statuses);
    return row ? toPlanVersionView(row, this.planTaskRows(row.plan_id, row.version)) : undefined;
  }

  planIdOfGoal(goalId: string): string | undefined {
    return (
      this.db
        .prepare('SELECT plan_id FROM plans WHERE goal_id = ? ORDER BY version LIMIT 1')
        .get<{ plan_id: string }>(goalId)?.plan_id ?? undefined
    );
  }

  goalTasks(projectId: string, goalId: string): TaskView[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE project_id = ? AND goal_id = ? ORDER BY created_at, task_id')
      .all<TaskRow>(projectId, goalId)
      .map((r) => toTaskView(r, this.deps(r.task_id)));
  }

  modelCalls(projectId: string, opts: { goalId?: string; limit?: number } = {}): ModelCallView[] {
    const filter = opts.goalId ? ' AND goal_id = ?' : '';
    const args: unknown[] = opts.goalId ? [projectId, opts.goalId] : [projectId];
    return this.db
      .prepare(`SELECT * FROM model_calls WHERE project_id = ?${filter} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all<ModelCallRow>(...(args as string[]), opts.limit ?? 50)
      .map(toModelCallView);
  }

  /**
   * USD spent on a provider since an ISO time (the daily budget, ADR-0013). A call whose cost is
   * unknown counts at its worst-case estimate (review F04). Per project: projects that share a key
   * each have their own budget.
   */
  modelSpend(projectId: string, provider: string, sinceIso: string): number {
    return (
      this.db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN cost_known = 1 THEN cost_usd ELSE COALESCE(cost_estimate_usd, 0) END), 0) AS usd
           FROM model_calls WHERE project_id = ? AND provider = ? AND created_at >= ?`,
        )
        .get<{ usd: number }>(projectId, provider, sinceIso)?.usd ?? 0
    );
  }

  assignments(taskId: string): AssignmentView[] {
    return this.db
      .prepare('SELECT * FROM agent_assignments WHERE task_id = ? ORDER BY created_at')
      .all<AssignmentRow>(taskId)
      .map(toAssignmentView);
  }

  /** Verification runs of a task that ended FAILED. */
  verificationFailures(taskId: string): number {
    return (
      this.db
        .prepare("SELECT count(*) AS n FROM verification_runs WHERE task_id = ? AND status = 'FAILED'")
        .get<{ n: number }>(taskId)?.n ?? 0
    );
  }

  /** Track record used by delegation: verified passes and failures, recent paths, goals contributed to. */
  agentStats(agentId: string): { completed: number; failed: number; recent_paths: string[]; goals_done: string[] } {
    const outcomes = this.db
      .prepare(
        `SELECT v.status AS status, count(*) AS n FROM verification_runs v
         JOIN task_runs r ON r.run_id = COALESCE(v.run_id,
           (SELECT r2.run_id FROM task_runs r2 WHERE r2.task_id = v.task_id ORDER BY r2.attempt DESC LIMIT 1))
         WHERE r.agent_id = ? AND v.status IN ('PASSED','FAILED') GROUP BY v.status`,
      )
      .all<{ status: string; n: number }>(agentId);
    const paths = this.db
      .prepare('SELECT observed_paths_json FROM task_runs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 10')
      .all<{ observed_paths_json: string }>(agentId)
      .flatMap((r) => JSON.parse(r.observed_paths_json) as string[]);
    const goals = this.db
      .prepare(
        `SELECT DISTINCT t.goal_id AS goal_id FROM tasks t JOIN task_runs r ON r.task_id = t.task_id
         WHERE r.agent_id = ? AND t.status = 'COMPLETED' AND t.goal_id IS NOT NULL`,
      )
      .all<{ goal_id: string }>(agentId)
      .map((r) => r.goal_id);
    return {
      completed: outcomes.find((o) => o.status === 'PASSED')?.n ?? 0,
      failed: outcomes.find((o) => o.status === 'FAILED')?.n ?? 0,
      recent_paths: [...new Set(paths)].slice(0, 200),
      goals_done: goals,
    };
  }

  escalation(escalationId: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM escalations WHERE escalation_id = ?').get(escalationId);
  }

  /** How far the Master Brain has read the event log (operational, not replayed). */
  brainCursor(projectId: string): number {
    return this.consumerCursor(projectId, 'master-brain');
  }

  /** How far a durable consumer has read the event log (M3b). */
  consumerCursor(projectId: string, consumerId: string): number {
    return (
      this.db
        .prepare('SELECT last_sequence FROM event_consumers WHERE consumer_id = ? AND project_id = ?')
        .get<{ last_sequence: number }>(consumerId, projectId)?.last_sequence ?? 0
    );
  }

  // ---- agent messaging (M3, ADR-0017)

  findMessageRow(messageId: string): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get<MessageRow>(messageId);
  }

  deliveriesOf(messageId: string): DeliveryRow[] {
    return this.db
      .prepare(
        `SELECT d.*, a.agent_key FROM message_deliveries d LEFT JOIN agents a ON a.agent_id = d.agent_id
         WHERE d.message_id = ? ORDER BY d.created_at, d.rowid`,
      )
      .all<DeliveryRow>(messageId);
  }

  findDelivery(deliveryId: string): DeliveryRow | undefined {
    return this.db.prepare('SELECT * FROM message_deliveries WHERE delivery_id = ?').get<DeliveryRow>(deliveryId);
  }

  message(messageId: string): MessageView {
    const row = this.findMessageRow(messageId);
    if (!row) throw new FridayError('message_not_found', `message ${messageId} not found`);
    return toMessageView(row, this.deliveriesOf(messageId));
  }

  /** Messages, newest first; `agentId` matches what the agent sent or received. */
  messages(
    projectId: string,
    opts: { taskId?: string; agentId?: string; status?: string; to?: string; limit?: number } = {},
  ): MessageView[] {
    const where = ['m.project_id = ?'];
    const args: (string | number)[] = [projectId];
    if (opts.taskId) {
      where.push('m.task_id = ?');
      args.push(opts.taskId);
    }
    if (opts.status) {
      where.push('m.status = ?');
      args.push(opts.status);
    }
    if (opts.agentId) {
      where.push(
        `(m.sender_id = ? OR EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.message_id
           AND (d.agent_id = ? OR (d.recipient_kind = 'agent' AND d.recipient_id = ?))))`,
      );
      args.push(opts.agentId, opts.agentId, opts.agentId);
    }
    if (opts.to) {
      where.push(
        'EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.message_id AND d.recipient_kind = ?)',
      );
      args.push(opts.to);
    }
    return this.db
      .prepare(
        `SELECT m.* FROM messages m WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`,
      )
      .all<MessageRow>(...args, opts.limit ?? 100)
      .map((row) => toMessageView(row, this.deliveriesOf(row.message_id)));
  }

  /**
   * Open deliveries an agent may receive: addressed to it, taken by it, or waiting for its role
   * or for a task it holds. Urgent first, then oldest first.
   */
  inboxRows(projectId: string, agent: { agent_id: string; role: string }, heldTaskIds: string[]): DeliveryRow[] {
    const tasks = heldTaskIds.length ? heldTaskIds : [''];
    const marks = tasks.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT d.* FROM message_deliveries d JOIN messages m ON m.message_id = d.message_id
         WHERE d.project_id = ? AND d.state IN ('queued', 'delivered') AND (
           d.agent_id = ?
           OR (d.agent_id IS NULL AND d.recipient_kind = 'agent' AND d.recipient_id = ?)
           OR (d.agent_id IS NULL AND d.recipient_kind = 'role' AND d.recipient_id = ?)
           OR (d.agent_id IS NULL AND d.recipient_kind = 'task' AND d.recipient_id IN (${marks})))
         ORDER BY CASE m.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
           d.created_at, d.rowid`,
      )
      .all<DeliveryRow>(projectId, agent.agent_id, agent.agent_id, agent.role, ...tasks);
  }

  /** Open deliveries for the Master Brain or humans. */
  openDeliveriesFor(projectId: string, kind: 'master_brain' | 'human'): DeliveryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM message_deliveries WHERE project_id = ? AND recipient_kind = ? AND state IN ('queued', 'delivered')
         ORDER BY created_at, rowid`,
      )
      .all<DeliveryRow>(projectId, kind);
  }

  /** Facts agents reported about a goal's work (unverified), oldest first. */
  goalFacts(
    projectId: string,
    goalId: string,
    limit = 20,
  ): { fact: string; area?: string; impact?: string; source: string }[] {
    const rows = this.db
      .prepare(
        `SELECT facts_json, COALESCE(sender_key, sender_id) AS source FROM messages
         WHERE project_id = ? AND goal_id = ? AND facts_json <> '[]' ORDER BY created_at, rowid`,
      )
      .all<{ facts_json: string; source: string }>(projectId, goalId);
    const out: { fact: string; area?: string; impact?: string; source: string }[] = [];
    for (const r of rows)
      for (const fct of JSON.parse(r.facts_json) as { fact: string }[]) out.push({ ...fct, source: r.source });
    return out.slice(-limit);
  }
}

function toOperationRunView(r: Record<string, unknown>): OperationRunView {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    operation_run_id: String(r.operation_run_id),
    operation: String(r.operation),
    task_id: String(r.task_id),
    run_id: (r.run_id as string | null) ?? null,
    agent_id: (r.agent_id as string | null) ?? null,
    status: r.status as OperationRunView['status'],
    binary: String(r.binary),
    cwd: String(r.cwd),
    credentials: JSON.parse(String(r.credentials_json ?? '[]')) as string[],
    approval_id: (r.approval_id as string | null) ?? null,
    risk: r.risk as OperationRunView['risk'],
    reason: String(r.reason),
    exit_code: num(r.exit_code),
    timed_out: Number(r.timed_out ?? 0) === 1,
    duration_ms: num(r.duration_ms),
    redactions: Number(r.redactions ?? 0),
    artifact_ref: (r.artifact_ref as string | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    started_at: String(r.started_at),
    ended_at: (r.ended_at as string | null) ?? null,
  };
}

function toPinView(r: Record<string, unknown>): RoutingPinView {
  return {
    pin_id: String(r.pin_id),
    scope: r.scope as RoutingPinView['scope'],
    target: (r.target as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    mode: (r.mode as RoutingPinView['mode']) ?? null,
    sensitive: Number(r.sensitive ?? 0) === 1,
    needs_vision: Number(r.needs_vision ?? 0) === 1,
    until: (r.until as string | null) ?? null,
    source: String(r.source),
    note: (r.note as string | null) ?? null,
    created_at: String(r.created_at),
    revoked_at: (r.revoked_at as string | null) ?? null,
  };
}
