import {
  diffPlanVersions,
  existingTasks,
  type PlanVersionTask,
  parsePlanDraft,
  parseReplanDraft,
  proposalFromDraft,
  proposalFromReplan,
} from '@friday/planner';
import {
  type Actor,
  FridayError,
  GoalCreateRequest,
  type ModelCallView,
  PlanDecisionRequest,
  type PlanTaskView,
  type PlanVersionView,
  type TokenClass,
} from '@friday/protocol';
import type { ProjectRef } from '@friday/sdk';
import type { FridayState, PlanProposal } from '@friday/state';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { AppEnv } from './app.js';
import type { BrainHandle } from './brain.js';

export interface BrainRouteDeps {
  app: Hono<AppEnv>;
  allow: (...classes: TokenClass[]) => MiddlewareHandler<AppEnv>;
  json: (c: Context<AppEnv>) => Promise<Record<string, unknown>>;
  state: FridayState;
  project: ProjectRef;
  brain: BrainHandle | undefined;
  human: Actor;
}

const toDiffTask = (t: PlanTaskView): PlanVersionTask => ({
  key: t.key,
  task_id: t.task_id,
  change: t.change,
  kind: t.kind,
  summary: t.summary,
  depends_on: t.depends_on,
  write: t.scope.write,
  acceptance_criteria: t.acceptance_criteria,
  role: t.role,
  note: t.note,
});

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** A plan version with each task's live state next to what the plan says. */
export function liveVersion(state: FridayState, projectId: string, v: PlanVersionView) {
  return {
    ...v,
    tasks: v.tasks.map((t) => {
      const live = t.task_id ? state.q.findTask(projectId, t.task_id) : undefined;
      const agentId = live?.assigned_agent_id ?? null;
      return {
        ...t,
        status: live?.status ?? null,
        waiting_reason: live?.waiting_reason ?? null,
        agent_key: agentId ? (state.q.findAgent(agentId)?.agent_key ?? null) : null,
        reserved_for_agent_key: live?.reserved_for_agent_key ?? null,
      };
    }),
  };
}

/** Escalation rows with their JSON columns decoded. */
export function escalationView(row: Record<string, unknown>) {
  const { options_json, details_json, ...rest } = row;
  return {
    ...rest,
    options: parseJson<string[] | null>(options_json, null),
    details: parseJson<Record<string, unknown> | null>(details_json, null),
  };
}

/** Goals, plans and the Master Brain over the operator API (plan M2, ADR-0013). */
export function mountBrainRoutes(d: BrainRouteDeps): void {
  const { app, allow, json, state, project, human } = d;
  const pid = project.project_id;
  const P = '/api/v1/projects/:pid';
  const op = allow('operator');
  const brain = (): BrainHandle => {
    if (!d.brain) throw new FridayError('capability_unsupported', 'the Master Brain is not running in this daemon');
    return d.brain;
  };
  const version = (planId: string, v: string | undefined): PlanVersionView => {
    const n = Number(v);
    const found = Number.isInteger(n) ? state.q.planVersion(planId, n) : undefined;
    if (!found) throw new FridayError('plan_not_found', `plan ${planId} has no version ${v}`);
    return found;
  };

  const liveTask = (id: string) => state.q.findTask(pid, id);
  const withLive = (v: PlanVersionView) => liveVersion(state, pid, v);

  const goalDetail = (goalId: string) => {
    const goal = state.q.goal(pid, goalId);
    const versions = goal.plan_id ? state.q.planVersions(goal.plan_id) : [];
    const active = [...versions].reverse().find((v) => v.status === 'ACTIVE' || v.status === 'COMPLETED');
    const proposed = [...versions].reverse().find((v) => v.status === 'PROPOSED');
    const calls = state.q.modelCalls(pid, { goalId, limit: 500 });
    return {
      goal,
      versions: versions.map(({ tasks, ...rest }) => ({ ...rest, task_count: tasks.length })),
      active: active ? withLive(active) : null,
      proposed: proposed ? withLive(proposed) : null,
      escalations: state.q
        .escalations(pid, 'pending')
        .filter((e) => e.goal_id === goalId)
        .map(escalationView),
      model_calls: { count: calls.length, ...spend(calls) },
      // What Friday did for the goal, from its records (plan M12.7): the card's line, the landing
      // dialog's rows and `friday goal show` are built from this.
      summary: state.q.goalSummary(pid, goalId),
    };
  };

  /** Known spend, plus how many calls have an unknown cost and what the budget counts for them (review F04). */
  const spend = (calls: ModelCallView[]) => {
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    const unknown = calls.filter((c) => c.cost_usd === null);
    return {
      cost_usd: round(calls.reduce((sum, c) => sum + (c.cost_usd ?? 0), 0)),
      unknown_cost_calls: unknown.length,
      estimated_usd: round(unknown.reduce((sum, c) => sum + (c.cost_estimate_usd ?? 0), 0)),
    };
  };

  // ---- goals -----------------------------------------------------------------------------------

  app.get(`${P}/goals`, op, (c) => c.json({ goals: state.q.goals(pid) }));

  app.post(`${P}/goals`, op, async (c) => {
    const body = await json(c);
    const key = c.req.header('idempotency-key');
    const goal = state.createGoal(pid, human, GoalCreateRequest.parse(body), key ? { idempotency_key: key } : {});
    return c.json(goal, 201);
  });

  app.get(`${P}/goals/:gid`, op, (c) => c.json(goalDetail(c.req.param('gid'))));

  app.post(`${P}/goals/:gid/cancel`, op, async (c) => {
    const body = await json(c);
    const reason = typeof body.reason === 'string' && body.reason ? body.reason : 'cancelled by a human';
    return c.json(state.cancelGoal(pid, human, c.req.param('gid'), reason));
  });

  /** Asks the Master Brain for a new proposal now; waits for the model call. */
  app.post(`${P}/goals/:gid/replan`, op, async (c) => {
    const body = await json(c);
    const goalId = c.req.param('gid');
    state.q.goal(pid, goalId);
    const result = await brain().brain.requestReplan(
      goalId,
      typeof body.note === 'string' && body.note ? body.note : undefined,
    );
    return c.json({ result, ...goalDetail(goalId) });
  });

  /** A plan written by a human: a full plan when nothing is active, otherwise a revision. */
  app.post(`${P}/goals/:gid/plans`, op, async (c) => {
    const goalId = c.req.param('gid');
    const body = await json(c);
    if (!body.draft || typeof body.draft !== 'object')
      throw new FridayError('invalid_request', 'send {"draft": {...}}');
    const goal = state.q.goal(pid, goalId);
    const active = (goal.plan_id ? state.q.planVersions(goal.plan_id) : []).find((v) => v.status === 'ACTIVE');
    const trigger = typeof body.trigger === 'string' && body.trigger ? body.trigger : 'written by a human';
    let proposal: PlanProposal;
    // The ceiling of each task's role (plan M12.2) is checked with the draft, so a human's plan is
    // refused with the task and the ceiling named, as the planner's is; the version recorded
    // carries the cut scope and its note on each task.
    const bound = (t: Parameters<FridayState['boundPlanTask']>[0]) => state.boundPlanTask(t);
    if (active) {
      const r = parseReplanDraft(existingTasks(active, liveTask), bound)(body.draft);
      if (!r.ok)
        throw new FridayError('schema_mismatch', `the revision is not valid: ${r.errors.join('; ')}`, {
          errors: r.errors,
        });
      proposal = proposalFromReplan(active, r.value, liveTask, { trigger });
    } else {
      const r = parsePlanDraft(body.draft, bound);
      if (!r.ok)
        throw new FridayError('schema_mismatch', `the plan is not valid: ${r.errors.join('; ')}`, { errors: r.errors });
      proposal = proposalFromDraft(r.value, { trigger });
    }
    return c.json(withLive(state.proposePlan(pid, human, goalId, proposal)), 201);
  });

  // ---- plans -----------------------------------------------------------------------------------

  app.get(`${P}/plans/:planId`, op, (c) => {
    const versions = state.q.planVersions(c.req.param('planId'));
    if (versions.length === 0) throw new FridayError('plan_not_found', `plan ${c.req.param('planId')} not found`);
    return c.json({ versions: versions.map(withLive) });
  });

  app.get(`${P}/plans/:planId/versions/:v`, op, (c) =>
    c.json(withLive(version(c.req.param('planId'), c.req.param('v')))),
  );

  app.post(`${P}/plans/:planId/versions/:v/approve`, op, async (c) => {
    const { note } = PlanDecisionRequest.parse(await json(c));
    const v = version(c.req.param('planId'), c.req.param('v'));
    const r = state.approvePlan(pid, human, v.plan_id, v.version, note);
    return c.json({ ...r, plan: withLive(r.plan) });
  });

  app.post(`${P}/plans/:planId/versions/:v/reject`, op, async (c) => {
    const { note } = PlanDecisionRequest.parse(await json(c));
    const v = version(c.req.param('planId'), c.req.param('v'));
    return c.json(withLive(state.rejectPlan(pid, human, v.plan_id, v.version, note)));
  });

  app.get(`${P}/plans/:planId/diff`, op, (c) => {
    const planId = c.req.param('planId');
    const from = version(planId, c.req.query('from'));
    const to = version(planId, c.req.query('to'));
    return c.json({
      plan_id: planId,
      from: from.version,
      to: to.version,
      diff: diffPlanVersions(from.tasks.map(toDiffTask), to.tasks.map(toDiffTask)),
    });
  });

  // ---- the Master Brain ------------------------------------------------------------------------

  app.get(`${P}/brain`, op, (c) => c.json(brain().status()));

  app.post(`${P}/brain/run-once`, op, async (c) => c.json(await brain().brain.runOnce()));

  app.get(`${P}/model-calls`, op, (c) => {
    const goalId = c.req.query('goal');
    const limit = Math.min(500, Number(c.req.query('limit') ?? 50) || 50);
    const calls = state.q.modelCalls(pid, { ...(goalId ? { goalId } : {}), limit });
    return c.json({ calls, ...spend(calls) });
  });
}
