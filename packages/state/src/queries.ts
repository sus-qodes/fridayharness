import type { SqlDatabase } from '@friday/db';
import {
  type AgentView,
  type AssignmentView,
  type ContextPacket,
  FridayError,
  type GoalView,
  type HarnessView,
  type ModelCallView,
  type PlanVersionView,
  type RunView,
  type TaskStatus,
  type TaskView,
  type VerificationView,
} from '@friday/protocol';
import {
  type AgentRow,
  type AssignmentRow,
  type CheckRow,
  type GoalRow,
  type HarnessRow,
  type ModelCallRow,
  type PlanRow,
  type PlanTaskRow,
  type RunRow,
  type TaskRow,
  toAgentView,
  toAssignmentView,
  toGoalView,
  toHarnessView,
  toModelCallView,
  toPlanVersionView,
  toRunView,
  toTaskView,
  toVerificationView,
  type VerificationRow,
} from './rows.js';

/** Harness view plus internal fields the service needs. */
export type HarnessRecord = HarnessView & { shadow: boolean; requested_agent_key: string | null };
const toRecord = (row: HarnessRow): HarnessRecord => ({
  ...toHarnessView(row),
  shadow: Boolean(row.shadow),
  requested_agent_key: row.requested_agent_key,
});

const LIVE_HARNESS = "('REGISTERED','READY','BUSY','DEGRADED','RECONNECTING')";

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

  tasks(projectId: string, opts: { statuses?: TaskStatus[]; limit?: number } = {}): TaskView[] {
    const statuses = opts.statuses ?? [];
    const filter = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM tasks WHERE project_id = ?${filter} ORDER BY created_at, task_id LIMIT ?`)
      .all<TaskRow>(projectId, ...statuses, opts.limit ?? 500)
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

  private verificationView(row: VerificationRow): VerificationView {
    const checks = this.db
      .prepare(
        'SELECT name, kind, status, exit_code, artifact_ref, summary FROM verification_checks WHERE verification_id = ? ORDER BY rowid',
      )
      .all<CheckRow>(row.verification_id);
    return toVerificationView(row, checks);
  }

  contextPacket(contextId: string): ContextPacket | undefined {
    const row = this.db
      .prepare('SELECT packet_json FROM context_packets WHERE context_id = ?')
      .get<{ packet_json: string }>(contextId);
    return row ? (JSON.parse(row.packet_json) as ContextPacket) : undefined;
  }

  approvals(projectId: string, status?: string): Record<string, unknown>[] {
    return status
      ? this.db
          .prepare('SELECT * FROM approvals WHERE project_id = ? AND status = ? ORDER BY created_at')
          .all(projectId, status)
      : this.db.prepare('SELECT * FROM approvals WHERE project_id = ? ORDER BY created_at').all(projectId);
  }

  /** Valid, unexpired grants for a capability and target. */
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

  escalations(projectId: string, status?: string): Record<string, unknown>[] {
    return status
      ? this.db
          .prepare('SELECT * FROM escalations WHERE project_id = ? AND status = ? ORDER BY created_at')
          .all(projectId, status)
      : this.db.prepare('SELECT * FROM escalations WHERE project_id = ? ORDER BY created_at').all(projectId);
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

  goals(projectId: string, opts: { statuses?: string[]; limit?: number } = {}): GoalView[] {
    const statuses = opts.statuses ?? [];
    const filter = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
    return this.db
      .prepare(`SELECT * FROM goals WHERE project_id = ?${filter} ORDER BY created_at, goal_id LIMIT ?`)
      .all<GoalRow>(projectId, ...statuses, opts.limit ?? 200)
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

  /** USD spent on a provider since an ISO time (the daily budget, ADR-0013). */
  modelSpend(projectId: string, provider: string, sinceIso: string): number {
    return (
      this.db
        .prepare(
          'SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls WHERE project_id = ? AND provider = ? AND created_at >= ?',
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
    return (
      this.db
        .prepare('SELECT last_sequence FROM brain_cursor WHERE project_id = ?')
        .get<{ last_sequence: number }>(projectId)?.last_sequence ?? 0
    );
  }
}
