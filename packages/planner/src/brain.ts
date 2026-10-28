import type { Actor, GoalView, PlanVersionView, TaskView } from '@friday/protocol';
import type { FridayState } from '@friday/state';
import { type DelegationCandidate, delegate } from './delegate.js';
import { buildEscalation, type EscalationReason } from './escalate.js';
import { type PlannerCall, type PlannerOutcome, type PlannerPolicy, runPlanner } from './model.js';
import { parsePlanDraft, parseReplanDraft } from './parse.js';
import type { PriceTable } from './pricing.js';
import {
  type GoalForPrompt,
  PLAN_SYSTEM,
  PROMPT_VERSIONS,
  planPrompt,
  REPLAN_SYSTEM,
  replanPrompt,
} from './prompts.js';
import { existingTasks, proposalFromDraft, proposalFromReplan } from './proposals.js';
import type { PlannerModel } from './providers/types.js';
import { draftJsonSchema, type NeedsHuman } from './schemas.js';
import { type BrainAction, type TriggerFacts, triggersFor } from './triggers.js';
import type { ExistingTask } from './validate.js';

/** The Master Brain acts under its own identity in the event log. */
export const MASTER_BRAIN: Actor = { kind: 'master_brain', id: 'master-brain' };

export interface BrainSettings {
  /** Model id sent to the provider (`master_brain.model`). */
  model: string;
  maxTokens: number;
  autoApprove: boolean;
  escalateAfterFailures: number;
  maxReplans: number;
  /** `providers.<name>.allow_remote` for the configured provider. */
  allowRemote: boolean;
  dailyBudgetUsd: number;
  prices?: PriceTable;
}

export interface BrainDeps {
  state: FridayState;
  projectId: string;
  /** The planning model; null when none is configured (`plannerUnavailable` says why). */
  model: PlannerModel | null;
  plannerUnavailable?: string;
  settings: BrainSettings;
  /** Stable project context for planning prompts: layout, docs, scopes, checks, agents. */
  projectContext: () => string;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

export interface BrainStep {
  event?: string;
  sequence?: number;
  action: BrainAction['kind'];
  result: string;
}

export interface BrainReport {
  processed: number;
  cursor: number;
  steps: BrainStep[];
}

const PRIORITY: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

const promptGoal = (g: GoalView): GoalForPrompt => ({
  goal_id: g.goal_id,
  request: g.request,
  constraints: g.constraints,
  outcomes: g.outcomes,
  priority: g.priority,
});

/**
 * The Master Brain (spec Part 03, ADR-0013): reads the event log from a persisted cursor, applies
 * the trigger table, and acts through FridayState commands only. It never runs continuously and
 * handles one batch at a time; model calls happen only for first plans and revisions.
 */
export class MasterBrain {
  readonly #deps: BrainDeps;
  #queue: Promise<unknown> = Promise.resolve();
  #unsubscribe: (() => void) | undefined;
  #scheduled = false;
  #closed = false;
  readonly #abort = new AbortController();

  constructor(deps: BrainDeps) {
    this.#deps = deps;
  }

  /** Follows the event log: every committed batch schedules one pass. Catches up immediately. */
  start(): void {
    if (this.#unsubscribe || this.#closed) return;
    this.#unsubscribe = this.#deps.state.transport.subscribe({ project_id: this.#deps.projectId }, () =>
      this.#schedule(),
    );
    this.#schedule();
  }

  async stop(): Promise<void> {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#abort.abort();
    await this.#queue.catch(() => undefined);
  }

  /**
   * A human asks for a new proposal (`friday goal replan [--note]`): revises the active plan, or
   * plans again when nothing is active. Replaces a proposal still waiting for a decision.
   */
  requestReplan(goalId: string, note?: string): Promise<string> {
    const reason = note ? `a human asked: ${note}` : 'a human asked for a new proposal';
    const run = this.#queue.then(() => this.#replan(goalId, null, reason, { force: true, note: note ?? null }));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Processes every event since the cursor (and what that causes), then returns what it did. */
  runOnce(): Promise<BrainReport> {
    const run = this.#queue.then(() => this.#process());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      this.runOnce()
        .then((r) => {
          if (r.steps.length) this.#deps.log?.('info', 'master brain', { processed: r.processed, steps: r.steps });
        })
        .catch((e: unknown) =>
          this.#deps.log?.('error', 'master brain pass failed', { message: (e as Error).message }),
        );
    }, 0).unref?.();
  }

  async #process(): Promise<BrainReport> {
    const { state, projectId } = this.#deps;
    const report: BrainReport = { processed: 0, cursor: state.q.brainCursor(projectId), steps: [] };
    // Each round reads what the previous one caused (a proposal, its approval, new tasks…); bounded.
    for (let round = 0; round < 25 && !this.#closed; round += 1) {
      const events = state.store.readSince(projectId, report.cursor, { limit: 500 });
      if (events.length === 0) break;
      let delegateNow = false;
      const goals = new Set<string>();
      for (const e of events) {
        if (this.#closed) break;
        for (const a of triggersFor(e, this.#facts())) {
          if (a.kind === 'delegate') delegateNow = true;
          else if (a.kind === 'check_goal') goals.add(a.goal_id);
          else report.steps.push({ event: e.type, sequence: e.sequence, action: a.kind, result: await this.#act(a) });
        }
        report.cursor = e.sequence;
        report.processed += 1;
        state.setBrainCursor(projectId, e.sequence);
      }
      for (const g of goals) {
        const done = state.completeGoalIfDone(projectId, MASTER_BRAIN, g);
        if (done) report.steps.push({ action: 'check_goal', result: `${g} completed` });
      }
      if (delegateNow) for (const r of this.#delegate()) report.steps.push({ action: 'delegate', result: r });
    }
    return report;
  }

  #facts(): TriggerFacts {
    const { state, projectId, settings } = this.#deps;
    return {
      goalOf: (taskId) => state.q.findTask(projectId, taskId)?.goal_id ?? null,
      failuresOf: (taskId) => state.q.verificationFailures(taskId),
      replansOf: (goalId) => {
        const g = state.q.findGoal(projectId, goalId);
        return (g?.plan_id ? state.q.planVersions(g.plan_id) : []).filter(
          (v) => v.version > 1 && v.proposed_by.kind === 'master_brain',
        ).length;
      },
      brainEscalation: (id) => {
        const row = state.q.escalation(id);
        if (row?.requested_by_kind !== 'master_brain' || !row.goal_id) return null;
        if (row.kind !== 'ambiguous_intent') return { goal_id: String(row.goal_id), replan: true };
        // A question asked by a proposal: re-propose only if that proposal is still undecided.
        const d = JSON.parse(String(row.details_json ?? '{}')) as { plan_id?: string; plan_version?: number };
        const v = d.plan_id && d.plan_version ? state.q.planVersion(d.plan_id, d.plan_version) : undefined;
        return { goal_id: String(row.goal_id), replan: v?.status === 'PROPOSED' };
      },
      planner: this.#deps.model
        ? { available: true, reason: '' }
        : { available: false, reason: this.#deps.plannerUnavailable ?? 'no planner is configured' },
      limits: {
        escalateAfterFailures: settings.escalateAfterFailures,
        maxReplans: settings.maxReplans,
        autoApprove: settings.autoApprove,
      },
    };
  }

  async #act(a: BrainAction): Promise<string> {
    try {
      switch (a.kind) {
        case 'plan':
          return await this.#plan(a.goal_id, null);
        case 'replan':
          return await this.#replan(a.goal_id, a.task_id, a.reason);
        case 'auto_approve':
          return this.#autoApprove(a.plan_id, a.version);
        case 'ready_dependents': {
          const goalId = this.#deps.state.q.findTask(this.#deps.projectId, a.task_id)?.goal_id;
          if (!goalId) return 'skipped: not a plan task';
          const readied = this.#deps.state.readyDependents(this.#deps.projectId, MASTER_BRAIN, goalId);
          return readied.length ? `readied ${readied.map((t) => t.task_id).join(', ')}` : 'nothing to ready';
        }
        case 'release_lost': {
          const released = this.#deps.state.releaseLostTasks(this.#deps.projectId, MASTER_BRAIN, a.harness_id);
          return released.length ? `released ${released.map((t) => t.task_id).join(', ')}` : 'nothing to release';
        }
        case 'escalate':
          return this.#escalate(a.reason, a.goal_id, a.task_id, a.detail);
        default:
          return 'ignored';
      }
    } catch (e) {
      this.#deps.log?.('error', 'master brain action failed', { action: a.kind, message: (e as Error).message });
      return `failed: ${(e as Error).message}`;
    }
  }

  // ---------------------------------------------------------------- planning

  #policy(model: PlannerModel): PlannerPolicy {
    const { state, projectId, settings } = this.#deps;
    const dayStart = `${state.clock.now().slice(0, 10)}T00:00:00.000Z`;
    return {
      allowRemote: settings.allowRemote,
      spentTodayUsd: model.remote ? state.q.modelSpend(projectId, model.provider, dayStart) : 0,
      dailyBudgetUsd: settings.dailyBudgetUsd,
      ...(settings.prices ? { prices: settings.prices } : {}),
    };
  }

  /** Records every call as a `model.called` event; returns the id of the last one. */
  #record(calls: PlannerCall[], goalId: string, planId: string | null): string | null {
    let last: string | null = null;
    for (const c of calls) {
      last = this.#deps.state.recordModelCall(this.#deps.projectId, MASTER_BRAIN, {
        goal_id: goalId,
        plan_id: planId,
        purpose: c.purpose,
        prompt_version: c.prompt_version,
        provider: c.provider,
        model: c.model,
        remote: c.remote,
        status: c.status,
        error_code: c.error_code,
        error: c.error,
        attempt: c.attempt,
        usage: {
          input_tokens: c.usage.input_tokens,
          output_tokens: c.usage.output_tokens,
          cache_creation_input_tokens: c.usage.cache_creation_input_tokens,
          cache_read_input_tokens: c.usage.cache_read_input_tokens,
        },
        cost_usd: c.cost_usd,
        latency_ms: c.latency_ms,
        request_id: c.request_id,
      });
    }
    return last;
  }

  #plannerFailed(
    outcome: Extract<PlannerOutcome<unknown>, { ok: false }>,
    goalId: string,
    taskId: string | null,
  ): string {
    const reason: EscalationReason =
      outcome.reason === 'budget'
        ? 'budget_exceeded'
        : outcome.reason === 'invalid'
          ? 'invalid_plan'
          : 'planner_unavailable';
    return this.#escalate(reason, goalId, taskId, outcome.message, outcome.errors);
  }

  async #plan(goalId: string, feedback: string | null, force = false): Promise<string> {
    const { state, projectId, settings } = this.#deps;
    const goal = state.q.goal(projectId, goalId);
    if (goal.status !== 'OPEN') return `skipped: goal is ${goal.status}`;
    const versions = goal.plan_id ? state.q.planVersions(goal.plan_id) : [];
    if (versions.some((v) => v.status === 'ACTIVE' || (!force && v.status === 'PROPOSED')))
      return 'skipped: a plan already exists';
    const model = this.#deps.model;
    if (!model)
      return this.#escalate(
        'planner_unavailable',
        goalId,
        null,
        this.#deps.plannerUnavailable ?? 'no planner is configured',
      );
    const outcome = await runPlanner(
      model,
      {
        purpose: 'plan',
        model: settings.model,
        system: PLAN_SYSTEM,
        context: this.#deps.projectContext(),
        prompt: planPrompt(promptGoal(goal), { feedback }),
        schema: draftJsonSchema('plan'),
        schemaName: 'plan',
        maxTokens: settings.maxTokens,
      },
      parsePlanDraft,
      this.#policy(model),
      { promptVersion: PROMPT_VERSIONS.plan, signal: this.#abort.signal },
    );
    const callId = this.#record(outcome.calls, goalId, goal.plan_id);
    if (!outcome.ok) return this.#plannerFailed(outcome, goalId, null);
    const d = outcome.draft;
    const v = state.proposePlan(
      projectId,
      MASTER_BRAIN,
      goalId,
      proposalFromDraft(d, {
        trigger: feedback ? `new plan: ${feedback}` : 'first plan',
        model_call_id: callId,
        prompt_version: PROMPT_VERSIONS.plan,
      }),
    );
    if (d.needs_human) this.#askHuman(goalId, null, d.needs_human, v);
    return `proposed ${v.plan_id} v${v.version} with ${v.tasks.length} task(s)`;
  }

  async #replan(
    goalId: string,
    taskId: string | null,
    reason: string,
    opts: { force?: boolean; note?: string | null } = {},
  ): Promise<string> {
    const { state, projectId, settings } = this.#deps;
    const goal = state.q.goal(projectId, goalId);
    if (goal.status === 'COMPLETED' || goal.status === 'CANCELLED') return `skipped: goal is ${goal.status}`;
    const versions = goal.plan_id ? state.q.planVersions(goal.plan_id) : [];
    if (!opts.force && versions.some((v) => v.status === 'PROPOSED'))
      return 'skipped: a proposal is waiting for a decision';
    const answer = opts.note ? `The human asked: ${opts.note}` : this.#humanAnswer(goalId);
    const active = versions.find((v) => v.status === 'ACTIVE');
    if (!active) return this.#plan(goalId, answer ?? reason, opts.force);
    if (taskId && reason === 'verification failed' && state.q.findTask(projectId, taskId)?.status !== 'FAILED') {
      return 'skipped: the task is no longer FAILED';
    }
    const model = this.#deps.model;
    if (!model)
      return this.#escalate(
        'planner_unavailable',
        goalId,
        taskId,
        this.#deps.plannerUnavailable ?? 'no planner is configured',
      );
    const existing = existingTasks(active, (id) => state.q.findTask(projectId, id));
    const outcome = await runPlanner(
      model,
      {
        purpose: 'replan',
        model: settings.model,
        system: REPLAN_SYSTEM,
        context: this.#deps.projectContext(),
        prompt: replanPrompt({
          goal: promptGoal(goal),
          planText: this.#planText(active, existing),
          trigger: taskId ? `${reason} (${taskId})` : reason,
          evidence: this.#evidence(taskId, answer),
        }),
        schema: draftJsonSchema('replan'),
        schemaName: 'replan',
        maxTokens: settings.maxTokens,
      },
      parseReplanDraft(existing),
      this.#policy(model),
      { promptVersion: PROMPT_VERSIONS.replan, signal: this.#abort.signal },
    );
    const callId = this.#record(outcome.calls, goalId, goal.plan_id);
    if (!outcome.ok) return this.#plannerFailed(outcome, goalId, taskId);
    const d = outcome.draft;
    const v = state.proposePlan(
      projectId,
      MASTER_BRAIN,
      goalId,
      proposalFromReplan(active, d, (id) => state.q.findTask(projectId, id), {
        trigger: taskId ? `${reason}: ${taskId}` : reason,
        model_call_id: callId,
        prompt_version: PROMPT_VERSIONS.replan,
      }),
    );
    if (d.needs_human) this.#askHuman(goalId, taskId, d.needs_human, v);
    return `proposed ${v.plan_id} v${v.version} (rework ${d.rework.length}, drop ${d.drop.length}, new ${d.new_tasks.length})`;
  }

  #planText(active: PlanVersionView, existing: ExistingTask[]): string {
    const byId = new Map(existing.map((e) => [e.task_id, e]));
    return active.tasks
      .filter((t) => t.task_id && byId.has(t.task_id))
      .map((t) => {
        const e = byId.get(t.task_id as string) as ExistingTask;
        const deps = e.depends_on.length ? `; after ${e.depends_on.join(', ')}` : '';
        return `- ${e.task_id} [${e.status}] "${t.key}" (${t.kind}, role ${t.role}): ${t.summary}; writes ${e.write.join(', ') || '(nothing)'}${deps}`;
      })
      .join('\n');
  }

  /** What went wrong, from Friday's own records: verification checks and the agent's claim. */
  #evidence(taskId: string | null, answer: string | null): string[] {
    const { state } = this.#deps;
    const out: string[] = [];
    if (answer) out.push(answer);
    if (!taskId) return out;
    const v = state.q.latestVerification(taskId);
    if (v) {
      out.push(`verification ${v.status}${v.summary ? `: ${v.summary}` : ''}`);
      for (const c of v.checks)
        out.push(
          `check ${c.name}: ${c.status}${c.exit_code !== null ? ` (exit ${c.exit_code})` : ''}${c.summary ? ` ${c.summary}` : ''}`,
        );
    }
    const run = state.q.runs(taskId).at(-1);
    const claim = run?.claim as { summary?: string; changed_paths?: string[] } | null | undefined;
    if (claim?.summary) out.push(`the agent's claim: ${claim.summary}`);
    if (claim?.changed_paths?.length) out.push(`changed: ${claim.changed_paths.join(', ')}`);
    out.push(`verification failures so far: ${state.q.verificationFailures(taskId)}`);
    return out.slice(0, 10);
  }

  /** The latest answer a human gave to one of this goal's Master Brain escalations. */
  #humanAnswer(goalId: string): string | null {
    const rows = this.#deps.state.q
      .escalations(this.#deps.projectId, 'answered')
      .filter((r) => r.goal_id === goalId && r.requested_by_kind === 'master_brain');
    const last = rows.at(-1);
    return last ? `The human answered "${String(last.question)}": ${String(last.answer)}` : null;
  }

  #autoApprove(planId: string, version: number): string {
    const v = this.#deps.state.q.planVersion(planId, version);
    if (v?.status !== 'PROPOSED' || v.needs_human) return 'skipped';
    const r = this.#deps.state.approvePlan(
      this.#deps.projectId,
      MASTER_BRAIN,
      planId,
      version,
      'auto-approved (master_brain.auto_approve)',
    );
    return `approved ${planId} v${version}: ${r.created.length} task(s) created`;
  }

  // ---------------------------------------------------------------- escalation

  #pendingEscalation(goalId: string | null, kind: string, taskId: string | null): boolean {
    return this.#deps.state.q
      .escalations(this.#deps.projectId, 'pending')
      .some((r) => r.goal_id === goalId && r.kind === kind && (r.task_id ?? null) === taskId);
  }

  #escalate(
    reason: EscalationReason,
    goalId: string | null,
    taskId: string | null,
    detail: string,
    errors: string[] = [],
  ): string {
    const { state, projectId } = this.#deps;
    if (this.#pendingEscalation(goalId, reason, taskId)) return `escalation already pending (${reason})`;
    const goal = goalId ? state.q.findGoal(projectId, goalId) : undefined;
    const task: TaskView | undefined = taskId ? state.q.findTask(projectId, taskId) : undefined;
    const what = task
      ? `task ${task.task_id} (${task.summary})`
      : goal
        ? `goal ${goal.goal_id} (${goal.request.slice(0, 80)})`
        : 'the Master Brain';
    const spec: Record<EscalationReason, { question: string; options: string[]; action: string }> = {
      planner_unavailable: {
        question: `Friday cannot plan ${what}: ${detail}. How should it continue?`,
        options: ['enable the provider, then run "friday goal replan"', 'write the plan with "friday plan propose"'],
        action: 'wait for a planner or a human-written plan',
      },
      budget_exceeded: {
        question: `Today's model budget is used up, so ${what} cannot be planned. Raise the budget or wait until tomorrow?`,
        options: ['raise providers.anthropic.daily_budget_usd', 'wait', 'write the plan by hand'],
        action: 'pause planning until the budget allows it',
      },
      invalid_plan: {
        question: `The planner could not produce a valid plan for ${what}. Write it by hand, or ask again with more guidance?`,
        options: ['"friday plan propose" with a plan file', '"friday goal replan --note …" with guidance'],
        action: 'wait for a human-written plan or guidance',
      },
      repeated_verification_failures: {
        question: `${what} failed verification again. How should Friday continue?`,
        options: [
          'rework it again with guidance ("friday goal replan --note …")',
          'reassign it ("friday task release")',
          'cancel it',
        ],
        action: 'stop automatic rework until a human decides',
      },
      replan_limit: {
        question: `The plan for ${what} was already revised the maximum number of times. Continue, simplify the goal, or stop?`,
        options: ['revise again ("friday goal replan --note …")', 'cancel the goal'],
        action: 'stop automatic revisions until a human decides',
      },
      ambiguous_intent: { question: detail, options: [], action: 'wait for the answer' },
    };
    const s = spec[reason];
    const esc = buildEscalation({
      reason,
      goal_id: goalId,
      task_id: taskId,
      blocked: what,
      why: detail,
      question: s.question,
      options: s.options,
      proposed_action: s.action,
      evidence: [...(taskId ? this.#evidence(taskId, null) : []), ...errors],
    });
    const id = state.raiseEscalation(projectId, MASTER_BRAIN, {
      kind: esc.reason,
      goal_id: esc.goal_id,
      task_id: esc.task_id,
      question: esc.question,
      options: esc.options,
      details: { ...esc.details },
    });
    return `escalated ${id} (${reason})`;
  }

  #askHuman(goalId: string, taskId: string | null, nh: NeedsHuman, v: PlanVersionView): void {
    if (this.#pendingEscalation(goalId, 'ambiguous_intent', taskId)) return;
    const esc = buildEscalation({
      reason: 'ambiguous_intent',
      goal_id: goalId,
      task_id: taskId,
      blocked: `plan ${v.plan_id} v${v.version}`,
      why: nh.why,
      question: nh.question,
      options: nh.options,
      proposed_action: `answer, then approve or reject plan v${v.version} ("friday plan approve" / "friday plan reject")`,
      evidence: [v.summary],
    });
    this.#deps.state.raiseEscalation(this.#deps.projectId, MASTER_BRAIN, {
      kind: esc.reason,
      goal_id: goalId,
      task_id: taskId,
      question: esc.question,
      options: esc.options,
      details: { ...esc.details, plan_id: v.plan_id, plan_version: v.version },
    });
  }

  // ---------------------------------------------------------------- delegation

  #candidates(nowIso: string): { c: DelegationCandidate; spawn: boolean; free: boolean }[] {
    const { state, projectId } = this.#deps;
    const reserved = new Map<string, string>();
    for (const t of state.q.tasks(projectId, { statuses: ['READY'] })) {
      if (t.reserved_for_agent_key) reserved.set(t.reserved_for_agent_key, t.task_id);
    }
    return state.q.agents(projectId).map((a) => {
      const h = a.harness_id ? state.q.findHarness(a.harness_id) : undefined;
      const live = Boolean(h && state.q.isHarnessLive(h.harness_id, nowIso));
      const stats = state.q.agentStats(a.agent_id);
      return {
        c: {
          agent_id: a.agent_id,
          agent_key: a.agent_key,
          role: a.role,
          status: a.status,
          shadow: a.shadow,
          harness_live: live,
          // A reservation waiting to be claimed counts as work in hand.
          current_task_id: a.current_task_id ?? reserved.get(a.agent_key) ?? null,
          completed: stats.completed,
          failed: stats.failed,
          recent_paths: stats.recent_paths,
          goals_done: stats.goals_done,
          cost: 0,
        },
        spawn: h?.attach_mode === 'spawn',
        free: live && !a.shadow && a.status === 'AVAILABLE' && !a.current_task_id,
      };
    });
  }

  /** Assigns READY plan tasks of active goals, best first (ADR-0013 §9). */
  #delegate(): string[] {
    const { state, projectId } = this.#deps;
    const now = state.clock.now();
    const active = new Set(state.q.goals(projectId, { statuses: ['ACTIVE'] }).map((g) => g.goal_id));
    const ready = state.q
      .tasks(projectId, { statuses: ['READY'] })
      .filter((t) => t.goal_id && active.has(t.goal_id))
      .sort(
        (a, b) => (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9) || a.created_at.localeCompare(b.created_at),
      );
    const out: string[] = [];
    for (const task of ready) {
      const candidates = this.#candidates(now);
      if (task.reserved_for_agent_key) {
        // Reserved (for example after rework): push it to that agent if it runs in spawn mode and is free.
        const mine = candidates.find((x) => x.c.agent_key === task.reserved_for_agent_key);
        if (mine?.spawn && mine.free) {
          const r = state.delegateTask(projectId, MASTER_BRAIN, task.task_id, {
            agent_key: mine.c.agent_key,
            reason: 'reserved for this agent',
            scores: [],
          });
          out.push(`${task.task_id}: ${r.mode} to ${mine.c.agent_key}`);
        }
        continue;
      }
      const running = state.q
        .tasks(projectId, { statuses: ['ASSIGNED', 'RUNNING', 'WAITING'] })
        .map((t) => t.scope?.write ?? []);
      const decision = delegate(
        {
          task_id: task.task_id,
          goal_id: task.goal_id,
          role: task.role ?? 'developer',
          write: task.scope?.write ?? [],
        },
        candidates.map((x) => x.c),
        running,
      );
      const r = state.delegateTask(projectId, MASTER_BRAIN, task.task_id, {
        agent_key: decision.agent_key,
        reason: decision.reason,
        scores: decision.scores.slice(0, 5),
      });
      out.push(`${task.task_id}: ${r.mode}${decision.agent_key ? ` to ${decision.agent_key}` : ''}`);
    }
    return out;
  }
}
