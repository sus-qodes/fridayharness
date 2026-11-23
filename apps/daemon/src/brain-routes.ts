import {
  diffPlanVersions,
  existingTasks,
  INTENT_FEEDBACK_MAX_CHARS,
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
  GoalIntentUpdateRequest,
  type ModelCallView,
  PlanDecisionRequest,
  type PlanTaskView,
  type PlanVersionView,
  ProjectIntentProposeRequest,
  type TokenClass,
} from '@friday/protocol';
import { PLANNER_CHOICES, type PlannerChoice, type ProjectRef } from '@friday/sdk';
import type { FridayState, PlanProposal } from '@friday/state';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { AppEnv } from './app.js';
import type { BrainHandle } from './brain.js';
import { answerOf, directDraft } from './direct-goal.js';

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
    const req = GoalCreateRequest.parse(body);
    const goal = state.createGoal(pid, human, req, key ? { idempotency_key: key } : {});
    // A question, or one task to do now (2026-11-18): its one task is written here from the
    // request as it was typed, and started. The person who typed it is who approves it; no model
    // planned anything. A repeated request (the same idempotency key) finds the plan there.
    if (req.mode !== 'plan' && !goal.plan_id) {
      const bound = (t: Parameters<FridayState['boundPlanTask']>[0]) => state.boundPlanTask(t);
      const r = parsePlanDraft(directDraft(req.request, req.mode), bound);
      if (!r.ok) {
        throw new FridayError('schema_mismatch', `the request could not be started: ${r.errors.join('; ')}`, {
          errors: r.errors,
        });
      }
      const asked = req.mode === 'ask';
      const v = state.proposePlan(
        pid,
        human,
        goal.goal_id,
        proposalFromDraft(r.value, { trigger: asked ? 'a question, asked directly' : 'one task, started directly' }),
      );
      state.approvePlan(pid, human, v.plan_id, v.version, asked ? 'asked directly' : 'started directly');
      return c.json(state.q.goal(pid, goal.goal_id), 201);
    }
    return c.json(goal, 201);
  });

  /** A question's answer, in full, for the person who asked (`ask` goals only). */
  app.get(`${P}/goals/:gid/answer`, op, (c) => {
    const goal = state.q.goal(pid, c.req.param('gid'));
    if (goal.mode !== 'ask') throw new FridayError('invalid_request', `goal ${goal.goal_id} is not a question`);
    return c.json(answerOf(state, pid, goal, { full: true }));
  });

  /** The person opened the answer: it leaves what waits for them. */
  app.post(`${P}/goals/:gid/answer/read`, op, (c) => {
    const goal = state.q.goal(pid, c.req.param('gid'));
    if (goal.mode !== 'ask') throw new FridayError('invalid_request', `goal ${goal.goal_id} is not a question`);
    if (!answerOf(state, pid, goal).read) {
      state.recordObservation(pid, human, 'goal.answer_read', { goal_id: goal.goal_id }, []);
    }
    return c.json({ ok: true });
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

  /** A human edits what the goal is for (ADR-0034 §3); an unchanged edit records nothing. */
  app.post(`${P}/goals/:gid/intent`, op, async (c) => {
    const body = await json(c);
    return c.json(state.intent.updateGoal(pid, human, c.req.param('gid'), GoalIntentUpdateRequest.parse(body)));
  });

  // ---- project intent (ADR-0034 §1–§2) ---------------------------------------------------------

  const intentVersion = (v: string | undefined): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new FridayError('invalid_request', `not a version: ${v}`);
    return n;
  };
  const noteOf = (body: Record<string, unknown>) =>
    typeof body.note === 'string' && body.note.trim() ? body.note.trim() : undefined;

  /** The intent that counts and the proposal waiting for a human, either of which may be null. */
  app.get(`${P}/intent`, op, (c) =>
    c.json({
      approved: state.q.approvedProjectIntent(pid) ?? null,
      proposed: state.q.proposedProjectIntent(pid) ?? null,
    }),
  );

  app.get(`${P}/intent/versions`, op, (c) => c.json({ versions: state.q.projectIntents(pid) }));

  app.get(`${P}/intent/versions/:v`, op, (c) => c.json(state.q.projectIntent(pid, intentVersion(c.req.param('v')))));

  /** A human proposes (or answers the questions for) a version; it still needs an approval. */
  app.post(`${P}/intent`, op, async (c) => {
    const body = await json(c);
    const key = c.req.header('idempotency-key');
    const v = state.intent.propose(
      pid,
      human,
      ProjectIntentProposeRequest.parse(body),
      key ? { idempotency_key: key } : {},
    );
    return c.json(v, 201);
  });

  app.post(`${P}/intent/versions/:v/approve`, op, async (c) => {
    const body = await json(c);
    return c.json(state.intent.approve(pid, human, intentVersion(c.req.param('v')), noteOf(body)));
  });

  app.post(`${P}/intent/versions/:v/reject`, op, async (c) => {
    const body = await json(c);
    return c.json(state.intent.reject(pid, human, intentVersion(c.req.param('v')), noteOf(body)));
  });

  /**
   * Asks the Master Brain for a draft. By default waits for the model call and answers with the
   * outcome; `wait: false` queues it and answers at once (`friday start` uses that).
   */
  app.post(`${P}/intent/draft`, op, async (c) => {
    const body = await json(c);
    // `feedback` revises the waiting proposal (or `from`, or the approved intent) from what the
    // human says is wrong; one bounded model call, like the draft itself.
    if (body.feedback !== undefined && typeof body.feedback !== 'string')
      throw new FridayError('invalid_request', 'feedback must be a string');
    const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : '';
    if (feedback.length > INTENT_FEEDBACK_MAX_CHARS)
      throw new FridayError('invalid_request', `feedback: at most ${INTENT_FEEDBACK_MAX_CHARS} characters`);
    if (body.from !== undefined && !(Number.isInteger(body.from) && (body.from as number) > 0))
      throw new FridayError('invalid_request', 'from must be a positive intent version');
    const opts = {
      force: body.force === true,
      ...(feedback ? { feedback } : {}),
      ...(typeof body.from === 'number' ? { from: body.from } : {}),
    };
    if (body.wait === false) {
      void brain()
        .brain.requestIntentDraft({ ...opts, reason: 'no project intent yet when Friday started' })
        .catch(() => undefined);
      return c.json({ queued: true }, 202);
    }
    const result = await brain().brain.requestIntentDraft(opts);
    return c.json({ result, proposed: state.q.proposedProjectIntent(pid) ?? null });
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

  // How this person plans here, kept on this machine and not in the tracked config.yaml
  // (2026-11-17): null hands the choice back to the project's `master_brain.provider`. The planner
  // is built when Friday starts, so the answer's `choice.wanted` differs from `provider` until then.
  // The same route takes the planner's model (2026-11-17), kept on this machine too: `model` names
  // it, null hands it back to `master_brain.model`. It is read at each planning call, so it needs
  // no restart. A body names the planner, the model, or both.
  app.post(`${P}/brain/planner-choice`, op, async (c) => {
    const body = await json(c);
    const hasProvider = 'provider' in body;
    const hasModel = 'model' in body;
    if (!hasProvider && !hasModel) {
      throw new FridayError('invalid_request', 'send {"provider": …}, {"model": …} or both');
    }
    if (hasProvider) {
      const raw = body.provider;
      if (raw !== null && !(PLANNER_CHOICES as readonly unknown[]).includes(raw)) {
        throw new FridayError('invalid_request', `provider is one of ${PLANNER_CHOICES.join(', ')}, or null`);
      }
    }
    if (hasModel && body.model !== null && (typeof body.model !== 'string' || !body.model.trim())) {
      throw new FridayError('invalid_request', 'model is a model name, or null');
    }
    // The planner a model is for (2026-11-23): each keeps its own. Left out: the running planner.
    const forPlanner = body.model_for;
    if (forPlanner !== undefined && !(PLANNER_CHOICES as readonly unknown[]).includes(forPlanner)) {
      throw new FridayError('invalid_request', `model_for is one of ${PLANNER_CHOICES.join(', ')}`);
    }
    // The model first: a model Friday cannot price is refused before anything is written.
    if (hasModel) {
      const model = body.model === null ? null : (body.model as string).trim();
      const target = (forPlanner as string | undefined) ?? brain().status().provider;
      const was =
        brain()
          .status()
          .planners.find((p) => p.id === target)?.model ?? null;
      brain().choosePlannerModel(model, forPlanner as string | undefined);
      if (was !== model) {
        state.recordObservation(pid, human, 'planner.chosen', { model, was_model: was, planner: target }, []);
      }
    }
    if (hasProvider) {
      const provider = body.provider as PlannerChoice | null;
      const before = brain().status().choice.here;
      brain().choosePlanner(provider);
      if (before !== provider) {
        state.recordObservation(pid, human, 'planner.chosen', { provider, was: before }, []);
      }
    }
    return c.json(brain().status());
  });

  // "Turn spending off" (2026-11-17): this machine's approval to spend on planning is taken back.
  // Giving it stays the machine's own act (`friday brain allow-remote`, the desktop's dialog);
  // taking it back only tightens, so the interface may. It holds from the next planning call.
  app.post(`${P}/brain/deny-remote`, op, async (c) => {
    const raw = (await json(c)).provider;
    const known = brain()
      .status()
      .planners.filter((p) => p.remote)
      .map((p) => p.id);
    if (raw !== undefined && !known.includes(raw as string)) {
      throw new FridayError('invalid_request', `provider is one of ${known.join(', ')}, or left out`);
    }
    const removed = brain().denySpending(raw as string | undefined);
    if (removed) state.recordObservation(pid, human, 'planner.spending_denied', { provider: raw ?? null }, []);
    return c.json({ removed, brain: brain().status() });
  });

  // The models a key service or the model server on this machine offers (2026-11-23), for a
  // person to pick from: read on their request, with the key stored on this machine.
  app.get(`${P}/brain/models`, op, async (c) => {
    const provider = c.req.query('provider') ?? '';
    return c.json({ provider, models: await brain().listModels(provider) });
  });

  // Where the model server on this machine listens (2026-11-23: LM Studio's port, another of
  // Ollama's), kept on this machine. Only an address of this machine is taken, so no key and no
  // request can be sent elsewhere by it; null hands it back to the project's setting. The planner
  // reads it when Friday starts.
  app.post(`${P}/brain/local-endpoint`, op, async (c) => {
    const raw = (await json(c)).base_url;
    if (raw !== null && typeof raw !== 'string') {
      throw new FridayError('invalid_request', 'base_url is an address of this computer, or null');
    }
    const base_url = brain().setLocalEndpoint(raw);
    state.recordObservation(pid, human, 'planner.chosen', { local_endpoint: raw }, []);
    return c.json({ base_url });
  });

  app.get(`${P}/model-calls`, op, (c) => {
    const goalId = c.req.query('goal');
    const limit = Math.min(500, Number(c.req.query('limit') ?? 50) || 50);
    const calls = state.q.modelCalls(pid, { ...(goalId ? { goalId } : {}), limit });
    return c.json({ calls, ...spend(calls) });
  });
}
