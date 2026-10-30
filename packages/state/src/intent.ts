import { createHash } from 'node:crypto';
import {
  type Actor,
  FridayError,
  GoalIntentUpdateRequest,
  type GoalView,
  type IntentItem,
  PROJECT_INTENT_MAX_CHARS,
  ProjectIntentProposeRequest,
  type ProjectIntentView,
} from '@friday/protocol';
import type { z } from 'zod';
import type { FridayState } from './service.js';

/** The four intent lists, in the order Friday renders them (ADR-0034 §1). */
export const INTENT_LISTS = ['constraints', 'outcomes', 'non_goals', 'definition_of_done'] as const;
type IntentList = (typeof INTENT_LISTS)[number];

const normalized = (s: string) => s.trim().replace(/\s+/g, ' ');
const lineKey = (s: string) => normalized(s).toLowerCase();

/** Equal intents have equal hashes: whitespace and list order of duplicates do not matter, case does. */
export function projectIntentHash(intent: { objective: string } & Record<IntentList, { text: string }[]>): string {
  const body = {
    objective: normalized(intent.objective),
    ...Object.fromEntries(INTENT_LISTS.map((k) => [k, intent[k].map((i) => normalized(i.text))])),
  };
  return `pi1_${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16)}`;
}

/** Drops repeated lines (case-insensitively), keeping the first. */
function unique<T extends { text: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    const k = lineKey(i.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => normalized(x) === normalized(b[i] ?? ''));

/**
 * Project intent and goal intent (ADR-0034 §1–§3). Only a human approves a project intent; the
 * Master Brain and humans may propose one. A goal's intent is edited by humans; the planner's
 * additions stay apart and reach the goal through the plan flow.
 */
export class IntentService {
  constructor(private readonly state: FridayState) {}

  /**
   * Records a new proposed version. A line a human proposes keeps the `planner` source when it is
   * exactly a planner line of an earlier version (the human kept the suggestion); anything else
   * a human writes is `human`. Proposing what is already waiting, or already approved with
   * nothing waiting, records nothing and returns that version.
   */
  propose(
    projectId: string,
    actor: Actor,
    input: z.input<typeof ProjectIntentProposeRequest>,
    opts: { idempotency_key?: string } = {},
  ): ProjectIntentView {
    if (actor.kind !== 'human' && actor.kind !== 'master_brain') {
      throw new FridayError('permission_denied', 'only a human or the Master Brain proposes the project intent');
    }
    const req = ProjectIntentProposeRequest.parse(input);
    return this.state.bus.execute(
      {
        name: 'project_intent.propose',
        project_id: projectId,
        actor,
        idempotency_key: opts.idempotency_key,
        params: req,
      },
      (ctx) => {
        const history = this.state.q.projectIntents(projectId);
        const plannerLines = new Set(
          history
            .flatMap((v) => INTENT_LISTS.flatMap((k) => v[k].filter((i) => i.source === 'planner')))
            .map((i) => lineKey(i.text)),
        );
        const toItems = (list: (typeof req)[IntentList]): IntentItem[] =>
          unique(
            list.map((raw) => {
              const text = normalized(typeof raw === 'string' ? raw : raw.text);
              const from_paths = typeof raw === 'string' ? [] : raw.from_paths;
              const source =
                actor.kind === 'master_brain' || plannerLines.has(lineKey(text))
                  ? ('planner' as const)
                  : ('human' as const);
              return { text, source, from_paths };
            }),
          );
        const lists = Object.fromEntries(INTENT_LISTS.map((k) => [k, toItems(req[k])])) as Record<
          IntentList,
          IntentItem[]
        >;
        const objective = normalized(req.objective);
        const chars =
          objective.length + INTENT_LISTS.reduce((n, k) => n + lists[k].reduce((m, i) => m + i.text.length, 0), 0);
        if (chars > PROJECT_INTENT_MAX_CHARS) {
          throw new FridayError(
            'invalid_request',
            `the project intent is ${chars} characters; keep it within ${PROJECT_INTENT_MAX_CHARS} so every agent can always see all of it`,
            { chars, max: PROJECT_INTENT_MAX_CHARS },
          );
        }
        const content_hash = projectIntentHash({ objective, ...lists });
        const waiting = history.find((v) => v.status === 'proposed');
        if (waiting?.content_hash === content_hash) return waiting;
        const approved = history.find((v) => v.status === 'approved');
        if (!waiting && approved?.content_hash === content_hash) return approved;
        const version = (history[0]?.version ?? 0) + 1;
        ctx.emit({
          type: 'project_intent.proposed',
          payload: { intent: { version, objective, ...lists, content_hash } },
          refs: [{ kind: 'intent', id: `v${version}` }],
        });
        return this.state.q.projectIntent(projectId, version);
      },
    ).result;
  }

  approve(projectId: string, actor: Actor, version: number, note?: string): ProjectIntentView {
    return this.decide(projectId, actor, version, true, note);
  }

  reject(projectId: string, actor: Actor, version: number, note?: string): ProjectIntentView {
    return this.decide(projectId, actor, version, false, note);
  }

  private decide(projectId: string, actor: Actor, version: number, approve: boolean, note?: string): ProjectIntentView {
    const verb = approve ? 'approve' : 'reject';
    if (actor.kind !== 'human') {
      throw new FridayError('permission_denied', `only a human can ${verb} the project intent`);
    }
    return this.state.bus.execute(
      { name: `project_intent.${verb}`, project_id: projectId, actor, params: { version, note: note ?? null } },
      (ctx) => {
        const v = this.state.q.projectIntent(projectId, version);
        if (v.status !== 'proposed') {
          throw new FridayError('invalid_state_transition', `project intent v${version} is ${v.status}, not proposed`);
        }
        ctx.emit({
          type: approve ? 'project_intent.approved' : 'project_intent.rejected',
          payload: { version, note: note ?? null },
          refs: [{ kind: 'intent', id: `v${version}` }],
        });
        return this.state.q.projectIntent(projectId, version);
      },
    ).result;
  }

  /** A human edit of a goal's own intent; an unchanged field is left out, and no change records nothing. */
  updateGoal(
    projectId: string,
    actor: Actor,
    goalId: string,
    input: z.input<typeof GoalIntentUpdateRequest>,
  ): GoalView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', "only a human edits a goal's intent");
    const req = GoalIntentUpdateRequest.parse(input);
    return this.state.bus.execute(
      { name: 'goal.update_intent', project_id: projectId, actor, params: { goalId, ...req } },
      (ctx) => {
        const goal = this.state.q.goal(projectId, goalId);
        if (goal.status === 'COMPLETED' || goal.status === 'CANCELLED') {
          throw new FridayError('invalid_state_transition', `goal ${goalId} is ${goal.status}`);
        }
        const changes: Record<string, unknown> = {};
        if (req.objective !== undefined && normalized(req.objective) !== normalized(goal.objective ?? '')) {
          changes.objective = normalized(req.objective);
        }
        for (const k of INTENT_LISTS) {
          const next = req[k];
          if (next === undefined) continue;
          const lines = unique(next.map((text) => ({ text: normalized(text) }))).map((i) => i.text);
          if (!sameLines(lines, goal[k])) changes[k] = lines;
        }
        if (Object.keys(changes).length > 0) {
          ctx.emit({
            type: 'goal.updated',
            payload: { goal_id: goalId, changes },
            refs: [{ kind: 'goal', id: goalId }],
          });
        }
        return this.state.q.goal(projectId, goalId);
      },
    ).result;
  }
}
