/**
 * Questions act by kind (plan FD-21, §7.5). An escalation is answered with one text, and what that
 * does depends on its kind: an agent's question (kind `null`) and `ambiguous_intent` compose the
 * answer from option chips and a write-in; every other kind gets a card whose buttons call the
 * routes that do the work. The options of Friday's own kinds are CLI instructions for a human, so
 * they are never offered as choices (LESSONS UI-20). Pure module: no DOM.
 */
import type { EscalationView } from '@friday/protocol';

/** Which card a question gets. */
export type QuestionCardKind = 'free' | 'recovery' | 'routing' | 'integration' | 'unanswered' | 'brain';

/** A button a question card offers. */
export type QuestionAction =
  /** Send the composed answer (chips and write-in). */
  | 'send'
  /** Answer `LET_AGENT_DECIDE`. */
  | 'let-agent-decide'
  /** Fold the card (Notch) or close it (Studio); the question stays pending. */
  | 'later'
  /** Open the recovery dialog for the task. */
  | 'recover'
  /** `GET routing/explain/:tid`. */
  | 'routing-why'
  /** Pin a model to the task (`POST routing/pins`). */
  | 'pin-model'
  | 'cancel-task'
  /** Open the task's worktree in VS Code. */
  | 'open-worktree'
  /** `POST tasks/:tid/integrate`. */
  | 'integrate-again'
  /** `POST tasks/:tid/integrate {repaired: true}`. */
  | 'integrate-repair'
  | 'cancel-goal'
  /** A reply box whose text is the answer. */
  | 'reply'
  /** `POST goals/:gid/replan {note}` (a planner is ready). */
  | 'revise-note'
  /** The plan editor in revision mode (no planner). */
  | 'write-revision'
  /** `POST tasks/:tid/rework`. */
  | 'rework-task'
  /** Settings → Planner. */
  | 'planner-settings';

export interface QuestionSpec {
  card: QuestionCardKind;
  kind: string | null;
  /** The card's heading. */
  title: string;
  /** Who asked. */
  asker: 'agent' | 'master_brain' | 'friday';
  question: string;
  why: string | null;
  proposedAction: string | null;
  evidence: string[];
  /** Option chips a human may pick: only for an agent's question and `ambiguous_intent`. */
  choices: string[];
  /**
   * The options of a system kind: instructions for someone at a terminal. Never chips; a card may
   * show them as small "What the CLI would do" text.
   */
  cliHints: string[];
  actions: QuestionAction[];
  taskId: string | null;
  goalId: string | null;
}

/** The answer "Let the agent decide" sends (plan §7.5). */
export const LET_AGENT_DECIDE = 'No preference; use your judgement';

/** The Master Brain's own kinds besides `ambiguous_intent` (packages/planner `EscalationReason`). */
export const BRAIN_KINDS: readonly string[] = [
  'repeated_verification_failures',
  'repeated_failures',
  'replan_limit',
  'planner_unavailable',
  'invalid_plan',
  'budget_exceeded',
  'plan_rejected',
  'action_failed',
];

const TITLES: Record<string, string> = {
  ambiguous_intent: 'The Master Brain asks what you mean',
  recovery_needed: 'A task needs a recovery decision',
  routing_blocked: 'Routing does not let a task start',
  routing_violated: 'Routing stopped a task',
  integration_conflict: 'Integration conflict',
  integration_failed: 'Integration failed',
  unanswered_request: 'An agent waits for an answer',
  repeated_verification_failures: 'A task keeps failing verification',
  repeated_failures: 'A task keeps failing',
  replan_limit: 'The plan reached its revision limit',
  planner_unavailable: 'Friday cannot plan',
  invalid_plan: 'The planner produced no valid plan',
  budget_exceeded: "Today's model budget is spent",
  plan_rejected: 'A revision was rejected',
  action_failed: 'The Master Brain could not finish',
};

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/** Options as chips: strings only, no blanks, no repeats, at most 20. */
function chipsOf(options: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const o of strings(options)) {
    if (seen.has(o)) continue;
    seen.add(o);
    out.push(o);
    if (out.length === 20) break;
  }
  return out;
}

function words(kind: string): string {
  const t = kind.replace(/[_.]+/g, ' ').trim();
  return t ? t[0]?.toUpperCase() + t.slice(1) : 'A question';
}

/** Which card an escalation kind gets. */
export function cardKindOf(kind: string | null): QuestionCardKind {
  if (kind === null || kind === 'ambiguous_intent') return 'free';
  if (kind === 'recovery_needed') return 'recovery';
  if (kind === 'routing_blocked' || kind === 'routing_violated') return 'routing';
  if (kind === 'integration_conflict' || kind === 'integration_failed') return 'integration';
  if (kind === 'unanswered_request') return 'unanswered';
  // Every other kind is the Master Brain's, or one this interface does not know yet: it is
  // answered by revising the plan (or, without a goal, by a recorded reply).
  return 'brain';
}

/** Turns an escalation into the card that acts on it (plan FD-21). */
export function classifyEscalation(e: EscalationView, env: { plannerAvailable: boolean }): QuestionSpec {
  const kind = e.kind ?? null;
  const card = cardKindOf(kind);
  const d = (e.details ?? {}) as Record<string, unknown>;
  const asker: QuestionSpec['asker'] =
    e.requested_by_kind === 'agent' ? 'agent' : e.requested_by_kind === 'master_brain' ? 'master_brain' : 'friday';
  const taskId = e.task_id ?? null;
  const goalId = e.goal_id ?? null;
  const free = card === 'free';
  const actions: QuestionAction[] = [];
  switch (card) {
    case 'free':
      actions.push('send', 'let-agent-decide');
      break;
    case 'recovery':
      if (taskId) actions.push('recover');
      break;
    case 'routing':
      if (taskId) actions.push('routing-why', 'pin-model', 'cancel-task');
      break;
    case 'integration':
      if (taskId) actions.push('open-worktree', 'integrate-again', 'integrate-repair');
      if (goalId) actions.push('cancel-goal');
      break;
    case 'unanswered':
      actions.push('reply');
      break;
    case 'brain':
      if (goalId) actions.push(env.plannerAvailable ? 'revise-note' : 'write-revision');
      if (taskId) actions.push('rework-task', 'cancel-task');
      if (kind === 'planner_unavailable' || kind === 'budget_exceeded') actions.push('planner-settings');
      // Nothing to act on: the answer is recorded (and becomes guidance when a planner reads it).
      if (!goalId && !taskId) actions.push('reply');
      break;
  }
  actions.push('later');
  return {
    card,
    kind,
    title: kind === null ? 'A question from the agent' : (TITLES[kind] ?? words(kind)),
    asker,
    question: e.question,
    why: str(d.why),
    proposedAction: str(d.proposed_action),
    evidence: strings(d.evidence),
    choices: free ? chipsOf(e.options) : [],
    cliHints: free ? [] : strings(e.options),
    actions,
    taskId,
    goalId,
  };
}

/**
 * The answer text of a free question (plan §7.5): `Selected: <option>` and `Note: <text>`, one per
 * line, each only when present. Empty when neither is.
 */
export function composeAnswer(selected: string | null, note: string): string {
  const lines: string[] = [];
  if (selected?.trim()) lines.push(`Selected: ${selected}`);
  const n = note.trim();
  if (n) lines.push(`Note: ${n}`);
  return lines.join('\n');
}
