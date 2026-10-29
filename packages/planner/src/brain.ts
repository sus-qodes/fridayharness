import {
  type Actor,
  FridayError,
  type GoalView,
  isFridayError,
  type PlanVersionView,
  type TaskView,
} from '@friday/protocol';
import type { BrainJob, BrainJobInput, FridayState } from '@friday/state';
import { type DelegationCandidate, delegate } from './delegate.js';
import { buildEscalation, type EscalationReason } from './escalate.js';
import {
  type ParseResult,
  type PlannerCall,
  type PlannerOutcome,
  type PlannerPolicy,
  requestEstimate,
  runPlanner,
} from './model.js';
import { parsePlanDraft, parseReplanDraft } from './parse.js';
import type { PriceTable } from './pricing.js';
import {
  type GoalForPrompt,
  PLAN_INSTRUCTIONS,
  PLANNER_SYSTEM,
  PROMPT_VERSIONS,
  planPrompt,
  REPLAN_INSTRUCTIONS,
  replanPrompt,
} from './prompts.js';
import { existingTasks, proposalFromDraft, proposalFromReplan } from './proposals.js';
import type { ModelRequest, PlannerModel } from './providers/types.js';
import { draftJsonSchema, type NeedsHuman } from './schemas.js';
import { type BrainAction, failureAction, type TriggerFacts, triggersFor } from './triggers.js';
import { type ExistingTask, validateReplanDraft } from './validate.js';

/** The Master Brain acts under its own identity in the event log. */
export const MASTER_BRAIN: Actor = { kind: 'master_brain', id: 'master-brain' };

export interface BrainSettings {
  /** Model id sent to the provider (`master_brain.model`). */
  model: string;
  maxTokens: number;
  autoApprove: boolean;
  escalateAfterFailures: number;
  maxReplans: number;
  /** `providers.<name>.allow_remote` for the configured provider (see also `BrainDeps.remotePolicy`). */
  allowRemote: boolean;
  dailyBudgetUsd: number;
  prices?: PriceTable;
}

/** Consent and budget as they are right now (a local approval can change while the daemon runs). */
export interface RemotePolicy {
  allowRemote: boolean;
  dailyBudgetUsd: number;
  /** Why remote calls are off, for the human. */
  refusal?: string;
}

export interface BrainDeps {
  state: FridayState;
  projectId: string;
  /** The planning model; null when none is configured (`plannerUnavailable` says why). */
  model: PlannerModel | null;
  plannerUnavailable?: string;
  settings: BrainSettings;
  /** Read before every model call; defaults to `settings`. */
  remotePolicy?: () => RemotePolicy;
  /** Stable project context for planning prompts: layout, docs, scopes, checks, agents. */
  projectContext: () => string;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
  /** Waits before retrying a job whose action failed; the last failure escalates (tests shorten them). */
  retryDelaysMs?: number[];
  /**
   * Who recovers the work of harnesses that will not come back: `release` (default) gives their
   * tasks back to READY here; `external` leaves them to the daemon's recovery, which preserves and
   * fences the attempt first (ADR-0026).
   */
  lostWork?: 'release' | 'external';
  /**
   * How well the model routing would run on an agent's harness fits a task, and its relative cost
   * (ADR-0031 §9); without it, delegation ignores models. `blocked`: routing does not let the task
   * start on that agent's harness, and why (review F01).
   */
  modelFit?: (task: TaskView, agentId: string) => { fit: number; cost: number; blocked?: string } | null;
  /**
   * Whether routing has what it waits for to route a task (Laya's answer, or that Laya did not
   * answer within its deadline; review F11). A task that is not ready waits; other tasks go on.
   */
  routingReady?: (task: TaskView) => boolean;
}

export interface BrainStep {
  event?: string;
  sequence?: number;
  action: string;
  result: string;
}

export interface BrainReport {
  processed: number;
  cursor: number;
  steps: BrainStep[];
}

const PRIORITY: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const MODEL_JOBS = new Set(['plan', 'replan']);
const COORDINATION = new Set(['ready_dependents', 'check_goal', 'delegate', 'release_lost']);
const DEFAULT_RETRY_MS = [1000, 5000, 30_000];

type JobOutcome = { status: 'done' | 'waiting'; result: string } | { status: 'retry'; result: string };

/**
 * Masks credentials in everything a model request carries (review F03): the project context,
 * the per-call prompt (goal text, evidence, notes) and a repair turn. The redactor also knows the
 * daemon's tokens and the provider key, so neither can be echoed back out.
 */
export function redactRequest(r: ModelRequest, redactor: { redactString(s: string): { value: string } }): ModelRequest {
  const clean = (t: string) => redactor.redactString(t).value;
  return {
    ...r,
    context: clean(r.context),
    prompt: clean(r.prompt),
    ...(r.repair ? { repair: { previous: clean(r.repair.previous), errors: r.repair.errors.map(clean) } } : {}),
  };
}

const promptGoal = (g: GoalView): GoalForPrompt => ({
  goal_id: g.goal_id,
  request: g.request,
  objective: g.objective,
  constraints: g.constraints,
  outcomes: g.outcomes,
  inferred_constraints: g.inferred_constraints,
  inferred_outcomes: g.inferred_outcomes,
  priority: g.priority,
});

/**
 * The Master Brain (spec Part 03, ADR-0013 and its 2026-10-14 amendment): reads the event log from
 * a persisted cursor, applies the trigger table, and acts through FridayState commands only.
 *
 * Reliability (review F05):
 * - a trigger becomes a durable job in the same transaction that moves the cursor past its event;
 * - coordination (readying dependents, completing goals, releasing lost work, delegation) is
 *   derived from the current state on every pass, so it cannot be skipped by a crash;
 * - model calls run in their own lane, one at a time, so a slow provider never holds up
 *   coordination; a call in flight is marked, and a restart records it as interrupted (its cost
 *   unknown, counted at its estimate) before trying again;
 * - a revision that must wait for a pending proposal waits durably, and runs (or turns out to be
 *   unnecessary) once that proposal is decided;
 * - a job whose action fails is retried a few times, then escalated to a human.
 */
export class MasterBrain {
  readonly #deps: BrainDeps;
  #queue: Promise<unknown> = Promise.resolve();
  #planning: Promise<void> | null = null;
  #laneSteps: BrainStep[] = [];
  #unsubscribe: (() => void) | undefined;
  #scheduled = false;
  #closed = false;
  #recovered = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #waiters = new Map<string, (result: string) => void>();
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
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#abort.abort();
    await this.#queue.catch(() => undefined);
    await this.#planning?.catch(() => undefined);
  }

  /**
   * A human asks for a new proposal (`friday goal replan [--note]`): revises the active plan, or
   * plans again when nothing is active. Replaces a proposal still waiting for a decision.
   */
  requestReplan(goalId: string, note?: string): Promise<string> {
    const { state, projectId } = this.#deps;
    const [id] = state.enqueueBrainJobs(
      projectId,
      [
        {
          kind: 'replan',
          goal_id: goalId,
          task_id: null,
          reason: note ? `a human asked: ${note}` : 'a human asked for a new proposal',
          payload: { force: true, note: note ?? null },
          dedupe_key: `replan:${goalId}:human:${state.ids.next('job')}`,
          source_sequence: state.store.head(projectId),
        },
      ],
      state.q.brainCursor(projectId),
    );
    const done = new Promise<string>((resolve) => this.#waiters.set(id as string, resolve));
    this.#kickPlanning();
    return done;
  }

  /**
   * Processes every event since the cursor, the jobs they create and what those cause, until
   * nothing is left to do now (jobs waiting for a human or a retry time stay). For tests and
   * `friday brain run-once`.
   */
  async runOnce(): Promise<BrainReport> {
    const { state, projectId } = this.#deps;
    const report: BrainReport = { processed: 0, cursor: state.q.brainCursor(projectId), steps: [] };
    for (let i = 0; i < 50 && !this.#closed; i += 1) {
      const pass = this.#queue.then(() => this.#pass());
      this.#queue = pass.catch(() => undefined);
      const r = await pass;
      report.processed += r.processed;
      report.cursor = r.cursor;
      report.steps.push(...r.steps);
      this.#kickPlanning();
      if (this.#planning) {
        await this.#planning;
        report.steps.push(...this.#laneSteps.splice(0));
        continue;
      }
      if (state.store.head(projectId) <= state.q.brainCursor(projectId)) break;
    }
    report.steps.push(...this.#laneSteps.splice(0));
    return report;
  }

  #schedule(): void {
    if (this.#scheduled || this.#closed) return;
    this.#scheduled = true;
    setTimeout(() => {
      this.#scheduled = false;
      if (this.#closed) return;
      const pass = this.#queue.then(() => this.#pass());
      this.#queue = pass.catch(() => undefined);
      pass
        .then((r) => {
          const steps = [...r.steps, ...this.#laneSteps.splice(0)];
          if (steps.length) this.#deps.log?.('info', 'master brain', { processed: r.processed, steps });
          this.#kickPlanning();
        })
        .catch((e: unknown) =>
          this.#deps.log?.('error', 'master brain pass failed', { message: (e as Error).message }),
        );
    }, 0).unref?.();
  }

  // ---------------------------------------------------------------- the coordination pass

  /** One pass: events → durable jobs (with the cursor), local jobs, then coordination from state. */
  async #pass(): Promise<BrainReport> {
    const { state, projectId } = this.#deps;
    if (!this.#recovered) this.#recover();
    const report: BrainReport = { processed: 0, cursor: state.q.brainCursor(projectId), steps: [] };
    // Each round reads what the previous one caused (a proposal, its approval, new tasks…); bounded.
    for (let round = 0; round < 25 && !this.#closed; round += 1) {
      const events = state.store.readSince(projectId, report.cursor, { limit: 500 });
      const jobs: (BrainJobInput & { source_sequence: number })[] = [];
      for (const e of events) {
        for (const a of triggersFor(e, this.#facts())) {
          if (COORDINATION.has(a.kind)) continue;
          jobs.push({ ...this.#jobFor(a), source_sequence: e.sequence });
        }
      }
      const last = events.at(-1);
      if (last) {
        state.enqueueBrainJobs(projectId, jobs, last.sequence);
        report.cursor = last.sequence;
        report.processed += events.length;
      }
      const before = state.store.head(projectId);
      report.steps.push(...this.#runLocalJobs(), ...this.#coordinate());
      // Stop once neither the events nor this round's own actions left anything new.
      if (events.length === 0 && state.store.head(projectId) === before) break;
    }
    this.#armRetryTimer();
    return report;
  }

  #jobFor(a: BrainAction): BrainJobInput {
    switch (a.kind) {
      case 'plan':
        return {
          kind: 'plan',
          goal_id: a.goal_id,
          task_id: null,
          reason: 'first plan',
          dedupe_key: `plan:${a.goal_id}`,
        };
      case 'replan': {
        const key = a.escalation_id
          ? `replan:${a.goal_id}:answer:${a.escalation_id}`
          : `replan:${a.goal_id}:${a.task_id ?? '-'}:${a.reason}`;
        return {
          kind: 'replan',
          goal_id: a.goal_id,
          task_id: a.task_id,
          reason: a.reason,
          payload: { force: a.force ?? false, escalation_id: a.escalation_id ?? null },
          dedupe_key: key,
        };
      }
      case 'auto_approve':
        return {
          kind: 'auto_approve',
          goal_id: null,
          task_id: null,
          reason: 'auto_approve',
          payload: { plan_id: a.plan_id, version: a.version },
          dedupe_key: `approve:${a.plan_id}:${a.version}`,
        };
      case 'after_rejection':
        return {
          kind: 'after_rejection',
          goal_id: a.goal_id,
          task_id: null,
          reason: 'a proposal was rejected',
          payload: { plan_id: a.plan_id, version: a.version, note: a.note },
          dedupe_key: `rejected:${a.plan_id}:${a.version}`,
        };
      case 'escalate':
        return {
          kind: 'escalate',
          goal_id: a.goal_id,
          task_id: a.task_id,
          reason: a.reason,
          payload: { detail: a.detail },
          dedupe_key: `escalate:${a.reason}:${a.goal_id ?? '-'}:${a.task_id ?? '-'}`,
        };
      default:
        throw new Error(`no job for ${a.kind}`);
    }
  }

  /** Deterministic jobs run inside the pass, in order; model jobs are left to the planning lane. */
  #runLocalJobs(): BrainStep[] {
    const { state, projectId } = this.#deps;
    const steps: BrainStep[] = [];
    const now = Date.parse(state.clock.now());
    for (const job of state.brainJobs(projectId, ['pending'])) {
      if (MODEL_JOBS.has(job.kind) || this.#closed) continue;
      if (job.not_before && Date.parse(job.not_before) > now) continue;
      let outcome: JobOutcome;
      try {
        outcome = this.#runLocal(job);
      } catch (e) {
        outcome = { status: 'retry', result: (e as Error).message };
      }
      steps.push(this.#finish(job, outcome));
    }
    return steps;
  }

  #runLocal(job: BrainJob): JobOutcome {
    const p = job.payload;
    switch (job.kind) {
      case 'escalate':
        return {
          status: 'done',
          result: this.#escalate(job.reason as EscalationReason, job.goal_id, job.task_id, String(p.detail ?? '')),
        };
      case 'auto_approve':
        return { status: 'done', result: this.#autoApprove(String(p.plan_id), Number(p.version)) };
      case 'after_rejection':
        return {
          status: 'done',
          result: this.#afterRejection(job.goal_id as string, Number(p.version), (p.note as string | null) ?? null),
        };
      default:
        return { status: 'done', result: `ignored: unknown job ${job.kind}` };
    }
  }

  /** Records a job's outcome; a failure is retried after a delay, and escalated once retries run out. */
  #finish(job: BrainJob, outcome: JobOutcome): BrainStep {
    const { state } = this.#deps;
    const step: BrainStep = {
      action: job.kind,
      result: outcome.result,
      ...(job.source_sequence ? { sequence: job.source_sequence } : {}),
    };
    if (outcome.status !== 'retry') {
      state.updateBrainJob(job.job_id, { status: outcome.status, result: outcome.result });
      if (outcome.status === 'done') this.#waiters.get(job.job_id)?.(outcome.result);
      if (outcome.status === 'done') this.#waiters.delete(job.job_id);
      return step;
    }
    const delays = this.#deps.retryDelaysMs ?? DEFAULT_RETRY_MS;
    const attempts = job.attempts + 1;
    this.#deps.log?.('warn', 'master brain action failed', { job: job.kind, attempts, message: outcome.result });
    if (attempts > delays.length) {
      state.updateBrainJob(job.job_id, { status: 'failed', attempts, result: outcome.result });
      const escalated = this.#escalate(
        'action_failed',
        job.goal_id,
        job.task_id,
        `${job.kind} kept failing (${attempts} attempts): ${outcome.result}`,
      );
      this.#waiters.get(job.job_id)?.(`failed: ${outcome.result}`);
      this.#waiters.delete(job.job_id);
      return { ...step, result: `failed: ${outcome.result}; ${escalated}` };
    }
    const wait = delays[attempts - 1] ?? 30_000;
    const notBefore = new Date(Date.parse(state.clock.now()) + wait).toISOString();
    state.updateBrainJob(job.job_id, { status: 'pending', attempts, result: outcome.result, not_before: notBefore });
    return { ...step, result: `retry ${attempts}/${delays.length} after ${wait} ms: ${outcome.result}` };
  }

  /** Wakes the brain when the earliest delayed job becomes due (no events may arrive meanwhile). */
  #armRetryTimer(): void {
    if (this.#closed || !this.#unsubscribe) return;
    const due = this.#deps.state
      .brainJobs(this.#deps.projectId, ['pending'])
      .map((j) => (j.not_before ? Date.parse(j.not_before) : 0))
      .filter((t) => t > 0);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (!due.length) return;
    const ms = Math.max(0, Math.min(...due) - Date.parse(this.#deps.state.clock.now()));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#schedule();
    }, ms);
    this.#retryTimer.unref?.();
  }

  /**
   * After a restart: a model call that was in flight has an unknown outcome. It is recorded as
   * interrupted (counted at its estimate) and its job tried again: at least once, never "exactly".
   */
  #recover(): void {
    this.#recovered = true;
    const { state, projectId } = this.#deps;
    for (const job of state.brainJobs(projectId, ['calling'])) {
      this.#recordCalls(
        [
          {
            purpose: job.kind === 'plan' ? 'plan' : 'replan',
            prompt_version: job.kind === 'plan' ? PROMPT_VERSIONS.plan : PROMPT_VERSIONS.replan,
            provider: this.#deps.model?.provider ?? 'unknown',
            model: this.#deps.settings.model,
            remote: this.#deps.model?.remote ?? false,
            status: 'interrupted',
            error_code: 'interrupted',
            error: 'the daemon stopped while this request was in flight; its outcome is unknown',
            attempt: job.attempts + 1,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            cost_usd: null,
            cost_estimate_usd: job.call_estimate_usd,
            latency_ms: 0,
            request_id: null,
          },
        ],
        job.goal_id as string,
        job.goal_id ? (state.q.findGoal(projectId, job.goal_id)?.plan_id ?? null) : null,
      );
      state.updateBrainJob(job.job_id, { status: 'pending', attempts: job.attempts + 1, result: 'interrupted' });
    }
  }

  /**
   * Coordination from the current state (ADR-0013 §6): lost work of harnesses that will not come
   * back goes back to READY, dependents of completed tasks become READY, finished goals complete,
   * and READY plan tasks are delegated. Every step is idempotent and changes nothing when there is
   * nothing to do, so running it on every pass is safe.
   */
  #coordinate(): BrainStep[] {
    const { state, projectId } = this.#deps;
    const steps: BrainStep[] = [];
    try {
      const lost = new Set(
        this.#deps.lostWork === 'external'
          ? []
          : state.q
              .tasks(projectId, { statuses: ['HARNESS_LOST'] })
              .map((t) => t.assigned_harness_id)
              .filter((h): h is string => Boolean(h && state.q.findHarness(h)?.status === 'TERMINATED')),
      );
      for (const h of lost) {
        const released = state.releaseLostTasks(projectId, MASTER_BRAIN, h);
        if (released.length)
          steps.push({ action: 'release_lost', result: `released ${released.map((t) => t.task_id).join(', ')}` });
      }
      for (const g of state.q.goals(projectId, { statuses: ['ACTIVE'] })) {
        const readied = state.readyDependents(projectId, MASTER_BRAIN, g.goal_id);
        if (readied.length)
          steps.push({ action: 'ready_dependents', result: `readied ${readied.map((t) => t.task_id).join(', ')}` });
        if (state.completeGoalIfDone(projectId, MASTER_BRAIN, g.goal_id))
          steps.push({ action: 'check_goal', result: `${g.goal_id} completed` });
      }
      for (const r of this.#delegate()) steps.push({ action: 'delegate', result: r });
      // Messages addressed to the Master Brain: their facts reach later planning calls (ADR-0017 §9).
      const read = state.acknowledgeAs(projectId, MASTER_BRAIN, 'master_brain', 'all');
      if (read.length) steps.push({ action: 'messages', result: `read ${read.length} message(s)` });
    } catch (e) {
      // State changed under a step (a human acted meanwhile); the next pass sees the new state.
      this.#deps.log?.('warn', 'master brain coordination', { message: (e as Error).message });
    }
    return steps;
  }

  #facts(): TriggerFacts {
    const { state, projectId, settings } = this.#deps;
    return {
      goalOf: (taskId) => state.q.findTask(projectId, taskId)?.goal_id ?? null,
      goalOfPlan: (planId) => state.q.planVersions(planId)[0]?.goal_id ?? null,
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
        if (row.kind !== 'ambiguous_intent') return { goal_id: String(row.goal_id), replan: true, force: false };
        // A question asked by a proposal: re-propose (replacing it) only if it is still undecided.
        const d = JSON.parse(String(row.details_json ?? '{}')) as { plan_id?: string; plan_version?: number };
        const v = d.plan_id && d.plan_version ? state.q.planVersion(d.plan_id, d.plan_version) : undefined;
        const pending = v?.status === 'PROPOSED';
        return { goal_id: String(row.goal_id), replan: pending, force: pending };
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

  // ---------------------------------------------------------------- the planning lane

  /** The next model job that can run now: pending and due, or waiting with nothing left to wait for. */
  #nextModelJob(): BrainJob | undefined {
    const { state, projectId } = this.#deps;
    // While a human has paused Friday nothing spends the user's key; the jobs wait (plan M9 §5.5).
    if (state.q.control(projectId).paused) return undefined;
    const now = Date.parse(state.clock.now());
    return state
      .brainJobs(projectId, ['pending', 'waiting'])
      .filter((j) => MODEL_JOBS.has(j.kind))
      .find((j) => {
        if (j.status === 'pending') return !j.not_before || Date.parse(j.not_before) <= now;
        return !this.#blocker(j);
      });
  }

  /** Starts the planning lane if a model job can run; one call at a time, never holding up coordination. */
  #kickPlanning(): void {
    if (this.#planning || this.#closed) return;
    const job = this.#nextModelJob();
    if (!job) return;
    this.#planning = (async () => {
      try {
        let next: BrainJob | undefined = job;
        while (next && !this.#closed) {
          let outcome: JobOutcome;
          try {
            outcome = await this.#runModelJob(next);
          } catch (e) {
            outcome = { status: 'retry', result: (e as Error).message };
          }
          if (this.#closed && outcome.status === 'retry') break;
          this.#laneSteps.push(this.#finish(next, outcome));
          next = this.#nextModelJob();
        }
      } finally {
        this.#planning = null;
        if (!this.#closed) {
          this.#armRetryTimer();
          this.#schedule();
        }
      }
    })();
  }

  /** What a revision is waiting for, or null when it can run. */
  #blocker(job: BrainJob): string | null {
    if (job.kind !== 'replan' || job.payload.force) return null;
    const { state, projectId } = this.#deps;
    const goal = job.goal_id ? state.q.findGoal(projectId, job.goal_id) : undefined;
    if (!goal?.plan_id) return null;
    if (state.q.planVersions(goal.plan_id).some((v) => v.status === 'PROPOSED'))
      return 'a proposal is waiting for a decision';
    if (this.#pendingEscalation(goal.goal_id, 'plan_rejected', null))
      return 'a human is deciding after a rejected proposal';
    return null;
  }

  async #runModelJob(job: BrainJob): Promise<JobOutcome> {
    const goalId = job.goal_id as string;
    if (job.kind === 'plan') return this.#plan(job, goalId, null, false);
    const blocker = this.#blocker(job);
    if (blocker) return { status: 'waiting', result: `waiting: ${blocker}` };
    return this.#replan(job, goalId);
  }

  #policy(model: PlannerModel): PlannerPolicy {
    const { state, projectId, settings } = this.#deps;
    const live = this.#deps.remotePolicy?.() ?? {
      allowRemote: settings.allowRemote,
      dailyBudgetUsd: settings.dailyBudgetUsd,
    };
    const dayStart = `${state.clock.now().slice(0, 10)}T00:00:00.000Z`;
    return {
      allowRemote: live.allowRemote,
      ...(live.refusal ? { remoteRefusal: live.refusal } : {}),
      spentTodayUsd: model.remote ? state.q.modelSpend(projectId, model.provider, dayStart) : 0,
      dailyBudgetUsd: live.dailyBudgetUsd,
      ...(settings.prices ? { prices: settings.prices } : {}),
    };
  }

  /** Records every call as a `model.called` event; returns the id of the last one. */
  #recordCalls(calls: PlannerCall[], goalId: string, planId: string | null): string | null {
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
          cache_write_1h_input_tokens: c.usage.cache_write_1h_input_tokens ?? 0,
        },
        cost_usd: c.cost_usd,
        cost_estimate_usd: c.cost_estimate_usd,
        latency_ms: c.latency_ms,
        request_id: c.request_id,
      });
    }
    return last;
  }

  /** Marks the job as calling (with the worst-case cost) right before a request goes out, so a restart knows. */
  #call<T>(
    job: BrainJob,
    model: PlannerModel,
    request: ModelRequest,
    parse: (o: unknown) => ParseResult<T>,
    promptVersion: string,
  ): Promise<PlannerOutcome<T>> {
    const policy = this.#policy(model);
    return runPlanner(model, request, parse, policy, {
      promptVersion,
      signal: this.#abort.signal,
      outbound: (req) => redactRequest(req, this.#deps.state.redactor),
      onCall: (req) => {
        this.#deps.state.updateBrainJob(job.job_id, {
          status: 'calling',
          call_estimate_usd: requestEstimate(model, req, policy.prices),
        });
        // An observation, so an interface knows to look again while the call runs (plan M9 §5.11).
        this.#deps.state.recordObservation(
          this.#deps.projectId,
          MASTER_BRAIN,
          'brain.call_started',
          { job_id: job.job_id, kind: job.kind, goal_id: job.goal_id ?? null },
          [],
        );
      },
    });
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

  async #plan(job: BrainJob, goalId: string, feedback: string | null, force: boolean): Promise<JobOutcome> {
    const { state, projectId, settings } = this.#deps;
    const goal = state.q.goal(projectId, goalId);
    if (goal.status !== 'OPEN') return { status: 'done', result: `skipped: goal is ${goal.status}` };
    const versions = goal.plan_id ? state.q.planVersions(goal.plan_id) : [];
    if (versions.some((v) => v.status === 'ACTIVE' || (!force && v.status === 'PROPOSED')))
      return { status: 'done', result: 'skipped: a plan already exists' };
    const model = this.#deps.model;
    if (!model) {
      return {
        status: 'done',
        result: this.#escalate(
          'planner_unavailable',
          goalId,
          null,
          this.#deps.plannerUnavailable ?? 'no planner is configured',
        ),
      };
    }
    const decisions = this.#decisions(goalId);
    const outcome = await this.#call(
      job,
      model,
      {
        purpose: 'plan',
        model: settings.model,
        system: PLANNER_SYSTEM,
        context: this.#deps.projectContext(),
        instructions: PLAN_INSTRUCTIONS,
        prompt: planPrompt(promptGoal(goal), {
          feedback: [feedback, ...decisions].filter(Boolean).join('\n') || null,
        }),
        schema: draftJsonSchema('plan'),
        schemaName: 'plan',
        maxTokens: settings.maxTokens,
      },
      parsePlanDraft,
      PROMPT_VERSIONS.plan,
    );
    const callId = this.#recordCalls(outcome.calls, goalId, goal.plan_id);
    if (this.#closed && !outcome.ok && outcome.reason === 'provider') {
      return { status: 'retry', result: 'interrupted by shutdown' };
    }
    if (!outcome.ok) return { status: 'done', result: this.#plannerFailed(outcome, goalId, null) };
    // The goal may have moved on while the model was thinking (review F06).
    const now = state.q.goal(projectId, goalId);
    const nowVersions = now.plan_id ? state.q.planVersions(now.plan_id) : [];
    if (
      now.status !== 'OPEN' ||
      nowVersions.some((v) => v.status === 'ACTIVE' || (!force && v.status === 'PROPOSED'))
    ) {
      return { status: 'done', result: `discarded: the goal changed while planning (${now.status})` };
    }
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
    return { status: 'done', result: `proposed ${v.plan_id} v${v.version} with ${v.tasks.length} task(s)` };
  }

  async #replan(job: BrainJob, goalId: string): Promise<JobOutcome> {
    const { state, projectId, settings } = this.#deps;
    const force = Boolean(job.payload.force);
    const note = (job.payload.note as string | null | undefined) ?? null;
    const taskId = job.task_id;
    const goal = state.q.goal(projectId, goalId);
    if (goal.status === 'COMPLETED' || goal.status === 'CANCELLED') {
      return { status: 'done', result: `skipped: goal is ${goal.status}` };
    }
    const versions = goal.plan_id ? state.q.planVersions(goal.plan_id) : [];
    const answer = note ? `The human asked: ${note}` : null;
    const active = versions.find((v) => v.status === 'ACTIVE');
    if (!active) return this.#plan(job, goalId, answer ?? job.reason, force);
    if (taskId && job.reason === 'verification failed') {
      // The facts may have changed while the job waited: check the failure rules again.
      if (state.q.findTask(projectId, taskId)?.status !== 'FAILED') {
        return { status: 'done', result: 'skipped: the task is no longer FAILED' };
      }
      const action = failureAction(taskId, goalId, this.#facts());
      if (action.kind === 'escalate') {
        return { status: 'done', result: this.#escalate(action.reason, goalId, taskId, action.detail) };
      }
    }
    const model = this.#deps.model;
    if (!model) {
      return {
        status: 'done',
        result: this.#escalate(
          'planner_unavailable',
          goalId,
          taskId,
          this.#deps.plannerUnavailable ?? 'no planner is configured',
        ),
      };
    }
    const existing = existingTasks(active, (id) => state.q.findTask(projectId, id));
    const outcome = await this.#call(
      job,
      model,
      {
        purpose: 'replan',
        model: settings.model,
        system: PLANNER_SYSTEM,
        context: this.#deps.projectContext(),
        instructions: REPLAN_INSTRUCTIONS,
        prompt: replanPrompt({
          goal: promptGoal(goal),
          decisions: this.#decisions(goalId),
          facts: state.q
            .goalFacts(projectId, goalId)
            .map(
              (x) =>
                `${x.fact}${x.area ? ` [${x.area}]` : ''}${x.impact ? ` (impact: ${x.impact})` : ''}, reported by ${x.source}`,
            ),
          planText: this.#planText(active, existing),
          trigger: taskId ? `${job.reason} (${taskId})` : job.reason,
          evidence: this.#evidence(taskId, answer),
        }),
        schema: draftJsonSchema('replan'),
        schemaName: 'replan',
        maxTokens: settings.maxTokens,
      },
      parseReplanDraft(existing),
      PROMPT_VERSIONS.replan,
    );
    const callId = this.#recordCalls(outcome.calls, goalId, goal.plan_id);
    if (this.#closed && !outcome.ok && outcome.reason === 'provider') {
      return { status: 'retry', result: 'interrupted by shutdown' };
    }
    if (!outcome.ok) return { status: 'done', result: this.#plannerFailed(outcome, goalId, taskId) };
    const d = outcome.draft;
    // Freshness (review F06): the revision must still fit the plan and the tasks as they are now.
    const nowGoal = state.q.goal(projectId, goalId);
    const nowActive = nowGoal.plan_id ? state.q.latestPlanVersion(nowGoal.plan_id, ['ACTIVE']) : undefined;
    if (nowGoal.status === 'COMPLETED' || nowGoal.status === 'CANCELLED') {
      return { status: 'done', result: `discarded: goal is ${nowGoal.status}` };
    }
    if (nowActive?.version !== active.version) {
      return { status: 'retry', result: 'stale: the active plan changed while planning' };
    }
    const check = validateReplanDraft(
      d,
      existingTasks(nowActive, (id) => state.q.findTask(projectId, id)),
    );
    if (!check.ok) return { status: 'retry', result: `stale: ${check.errors.slice(0, 3).join('; ')}` };
    if (!force && state.q.planVersions(nowGoal.plan_id as string).some((v) => v.status === 'PROPOSED')) {
      return { status: 'waiting', result: 'waiting: another proposal arrived while planning' };
    }
    let v: PlanVersionView;
    try {
      v = state.proposePlan(
        projectId,
        MASTER_BRAIN,
        goalId,
        proposalFromReplan(active, d, (id) => state.q.findTask(projectId, id), {
          trigger: taskId ? `${job.reason}: ${taskId}` : job.reason,
          model_call_id: callId,
          prompt_version: PROMPT_VERSIONS.replan,
        }),
      );
    } catch (e) {
      if (e instanceof FridayError && e.errorName === 'plan_outdated')
        return { status: 'retry', result: `stale: ${e.message}` };
      throw e;
    }
    if (d.needs_human) this.#askHuman(goalId, taskId, d.needs_human, v);
    return {
      status: 'done',
      result: `proposed ${v.plan_id} v${v.version} (rework ${d.rework.length}, drop ${d.drop.length}, new ${d.new_tasks.length})`,
    };
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

  /**
   * Everything humans decided about this goal, with provenance (review F07): answers to the
   * Master Brain's questions and the notes of rejected proposals. Sent with every planning call.
   */
  #decisions(goalId: string): string[] {
    const { state, projectId } = this.#deps;
    const out: string[] = [];
    for (const r of state.q.escalations(projectId, 'answered')) {
      if (r.goal_id !== goalId || r.requested_by_kind !== 'master_brain') continue;
      out.push(`Asked "${String(r.question)}"; the human answered: ${String(r.answer)}`);
    }
    const goal = state.q.findGoal(projectId, goalId);
    for (const v of goal?.plan_id ? state.q.planVersions(goal.plan_id) : []) {
      if (v.status === 'REJECTED' && v.decided_by_id !== MASTER_BRAIN.id) {
        out.push(
          `The human rejected plan v${v.version}${v.decision_note ? `: ${v.decision_note}` : ' (no reason given)'}`,
        );
      }
    }
    return out.slice(-10);
  }

  #autoApprove(planId: string, version: number): string {
    const { state, projectId } = this.#deps;
    const v = state.q.planVersion(planId, version);
    if (v?.status !== 'PROPOSED' || v.needs_human) return 'skipped';
    try {
      const r = state.approvePlan(
        projectId,
        MASTER_BRAIN,
        planId,
        version,
        'auto-approved (master_brain.auto_approve)',
      );
      return `approved ${planId} v${version}: ${r.created.length} task(s) created`;
    } catch (e) {
      if (!(e instanceof FridayError) || e.errorName !== 'plan_outdated') throw e;
      // A stale proposal cannot apply; reject it so the goal does not wait on it forever (review F06).
      state.rejectPlan(projectId, MASTER_BRAIN, planId, version, `out of date: ${e.message}`.slice(0, 2000));
      return `rejected ${planId} v${version}: out of date`;
    }
  }

  /**
   * A proposal was rejected (review F05). When a human rejected a revision while tasks of the
   * goal are still FAILED, nothing would happen to them, so the Master Brain asks how to go on.
   */
  #afterRejection(goalId: string, version: number, note: string | null): string {
    const { state, projectId } = this.#deps;
    const goal = state.q.findGoal(projectId, goalId);
    if (goal?.status !== 'ACTIVE' || !goal.plan_id) return 'nothing to do';
    const versions = state.q.planVersions(goal.plan_id);
    const rejected = versions.find((v) => v.version === version);
    if (rejected?.proposed_by.kind !== 'master_brain') return 'nothing to do: not a Master Brain proposal';
    if (versions.some((v) => v.status === 'PROPOSED')) return 'nothing to do: a newer proposal is waiting';
    const failed = state.q.goalTasks(projectId, goalId).filter((t) => t.status === 'FAILED');
    if (failed.length === 0) return 'nothing to do: no task is waiting for a revision';
    const by = rejected.decided_by_id === MASTER_BRAIN.id ? 'Friday (it was out of date)' : 'a human';
    return this.#escalate(
      'plan_rejected',
      goalId,
      null,
      `plan v${version} was rejected by ${by}${note ? `: ${note}` : ''}; ${failed.map((t) => t.task_id).join(', ')} still failed verification`,
    );
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
        question: `Today's model budget does not cover planning ${what} (${detail}). Raise the budget or wait until tomorrow?`,
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
          'send it back yourself and pick the agent ("friday task rework <task>", then "friday task assign <task> --agent <key>")',
          'cancel it ("friday task cancel <task>")',
        ],
        action: 'stop automatic rework until a human decides',
      },
      replan_limit: {
        question: `The plan for ${what} was already revised the maximum number of times. Continue, simplify the goal, or stop?`,
        options: ['revise again ("friday goal replan --note …")', 'cancel the goal'],
        action: 'stop automatic revisions until a human decides',
      },
      ambiguous_intent: { question: detail, options: [], action: 'wait for the answer' },
      plan_rejected: {
        question: `A revision for ${what} was rejected (${detail}). How should Friday continue?`,
        options: [
          'answer with guidance; Friday proposes a new revision',
          'rework a task yourself ("friday task rework <task>")',
          'cancel the failed tasks or the goal',
        ],
        action: 'wait for a human decision before revising again',
      },
      action_failed: {
        question: `The Master Brain could not finish its work on ${what}: ${detail}. How should it continue?`,
        options: [
          'fix the cause, then "friday goal replan"',
          'continue by hand ("friday plan propose", "friday task …")',
        ],
        action: 'stop retrying until a human decides',
      },
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
    return state.q.agents(projectId).flatMap((a) => {
      const h = a.harness_id ? state.q.findHarness(a.harness_id) : undefined;
      // A session below the project's enforcement requirement cannot take work (review F09).
      if (h && state.enforcementGap(h) !== null) return [];
      const live = Boolean(h && state.q.isHarnessLive(h.harness_id, nowIso));
      const stats = state.q.agentStats(a.agent_id);
      return [
        {
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
        },
      ];
    });
  }

  /** Assigns READY plan tasks of active goals, best first (ADR-0013 §9). */
  #delegate(): string[] {
    const { state, projectId } = this.#deps;
    // A human paused Friday: nothing new starts until they resume it (docs/frontend/PLAN.md §5.4).
    if (state.q.control(projectId).paused) return [];
    const now = state.clock.now();
    const active = new Set(state.q.goals(projectId, { statuses: ['ACTIVE'] }).map((g) => g.goal_id));
    // A human was asked how the task goes on (its work is in another clone, review F08; its host ran
    // a model its constraints forbid, review F01): it waits for the answer.
    const asked = new Set(
      state.q
        .escalations(projectId, 'pending')
        .filter((e) => e.kind === 'recovery_needed' || e.kind === 'routing_violated')
        .map((e) => String(e.task_id)),
    );
    const routingReady = this.#deps.routingReady ?? (() => true);
    // Plan tasks of active goals, and loose tasks a human reserved for an agent: a spawned agent
    // cannot claim a reservation, so it is pushed (below); other loose tasks stay a human's.
    const ready = state.q
      .tasks(projectId, { statuses: ['READY'] })
      .filter(
        (t) =>
          ((t.goal_id && active.has(t.goal_id)) || (!t.goal_id && t.reserved_for_agent_key)) &&
          !asked.has(t.task_id) &&
          routingReady(t),
      )
      .sort(
        (a, b) => (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9) || a.created_at.localeCompare(b.created_at),
      );
    const out: string[] = [];
    for (const task of ready) {
      const candidates = this.#candidates(now);
      if (task.reserved_for_agent_key) {
        // Reserved (for example after rework): push it to that agent if it runs in spawn mode and is free.
        // Otherwise it waits for that agent; automatic reservations expire (review F08).
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
      // The model each agent's harness would run for this task, and its cost (ADR-0031 §9). An
      // agent whose route blocks the task is no candidate (review F01).
      const fitted = candidates.map((x) => ({ x, fit: this.#deps.modelFit?.(task, x.c.agent_id) ?? null }));
      const open = fitted.filter((f) => !f.fit?.blocked);
      const blockedFit = fitted.find((f) => f.fit?.blocked)?.fit;
      if (!open.length && blockedFit?.blocked) {
        state.noteRoutingBlocked(projectId, task.task_id, blockedFit.blocked);
        continue;
      }
      const decision = delegate(
        {
          task_id: task.task_id,
          goal_id: task.goal_id,
          role: task.role ?? 'developer',
          write: task.scope?.write ?? [],
        },
        open.map(({ x, fit }) => (fit ? { ...x.c, model_fit: fit.fit, cost: fit.cost } : x.c)),
        running,
      );
      let r: ReturnType<typeof state.delegateTask>;
      try {
        r = state.delegateTask(projectId, MASTER_BRAIN, task.task_id, {
          agent_key: decision.agent_key,
          reason: decision.reason,
          scores: decision.scores.slice(0, 5),
        });
      } catch (e) {
        // Routing changed between the fit and the assignment; the state recorded the block.
        if (isFridayError(e, 'routing_blocked')) continue;
        throw e;
      }
      if (r.mode !== 'none' && r.mode !== 'waiting')
        out.push(`${task.task_id}: ${r.mode}${decision.agent_key ? ` to ${decision.agent_key}` : ''}`);
    }
    return out;
  }
}
