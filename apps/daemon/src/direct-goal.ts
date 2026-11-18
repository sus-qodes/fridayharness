/**
 * A goal that needs no plan to read (2026-11-18): a question, or one task to do now.
 *
 * In the trial "Explain how menu price revisions work" went the way of every goal: a planner call
 * (ten cents and a minute), a plan with a rationale, instructions and six criteria to approve,
 * three minutes of waiting for that approval, then the build, the types, the lint and 565 tests on
 * a change of no file, and at the end a button "Ready to land" with nothing to land. A person asked
 * a question and wanted the answer.
 *
 * Two ways past the planner, each chosen by the person who types the request:
 *  - `ask`: one read-only task. The agent that takes it changes nothing and hands back the answer
 *    in full (`answer` of its result); Friday checks only that nothing changed, runs none of the
 *    project's checks, and has nothing to land. The answer is read in Friday.
 *  - `do`: one task with the request as it was typed, started at once. No model plans it and
 *    nobody approves a plan: the person wrote the task and pressed start. Its work is checked and
 *    landed like any other.
 *
 * Neither starts a plan a model wrote without a person's approval: that stays the setting it was
 * (`master_brain.auto_approve`), trusted per computer.
 */
import type { PlanDraftInput } from '@friday/planner';
import type { AnswerView, GoalMode, GoalView } from '@friday/protocol';
import type { FridayState } from '@friday/state';

export type DirectMode = Exclude<GoalMode, 'plan'>;

const clip = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`;
};

/** What the agent that answers is told, before the question itself. */
export const ASK_BRIEF = [
  'A person asked the question below and waits for the answer. This is not a task to change anything.',
  '- Read what you need in the project. Change no file, install nothing, commit nothing.',
  '- Answer in plain language, for a person who may not know the code: say what is so first, then how it works, with the files and names that matter.',
  '- Put the whole answer in the `answer` field of your final result (Markdown is fine). Keep `summary` to one sentence that says what the answer is.',
  '- If the question cannot be answered from this project, say what is missing in the answer. Do not end as blocked for that.',
].join('\n');

/** The one-task plan of a goal that is asked or done directly. */
export function directDraft(request: string, mode: DirectMode): PlanDraftInput {
  const title = clip(request, 200);
  if (mode === 'ask') {
    return {
      objective: clip(`Answer: ${request}`, 500),
      summary: 'One agent reads the project and answers. Nothing is changed.',
      tasks: [
        {
          key: 'answer',
          kind: 'research',
          summary: title,
          description: `${ASK_BRIEF}\n\nThe question:\n${request.trim()}`.slice(0, 4000),
          acceptance_criteria: [
            'The question is answered in full in the answer field of the result',
            'No file of the project is changed',
          ],
          scope: { write: [], read: ['**'] },
          depends_on: [],
        },
      ],
    };
  }
  return {
    objective: clip(request, 500).padEnd(5, '.'),
    summary: 'One agent does this as one task, started at once.',
    tasks: [
      {
        key: 'do',
        kind: 'implementation',
        summary: title,
        description: request.trim().slice(0, 4000),
        acceptance_criteria: ['What was asked is done, and nothing else is changed', "The project's checks pass"],
        // Nobody planned which files it needs: the whole project, as a person working in it has.
        scope: { write: ['**'], read: ['**'] },
        depends_on: [],
      },
    ],
  };
}

/** The goals whose answer a person opened (`goal.answer_read`). */
function readAnswers(state: FridayState, projectId: string): Set<string> {
  const out = new Set<string>();
  for (const e of state.store.readSince(projectId, 0, { types: ['goal.answer_read'], limit: 5000 })) {
    const id = (e.payload as { goal_id?: unknown }).goal_id;
    if (typeof id === 'string') out.add(id);
  }
  return out;
}

/** Where the question of an `ask` goal stands; `full` reads the whole answer from its artifact. */
export function answerOf(
  state: FridayState,
  projectId: string,
  goal: GoalView,
  opts: { full?: boolean; read?: Set<string> } = {},
): AnswerView {
  const task = state.q.goalTasks(projectId, goal.goal_id)[0] ?? null;
  const read = (opts.read ?? readAnswers(state, projectId)).has(goal.goal_id);
  const base: AnswerView = {
    goal_id: goal.goal_id,
    question: goal.request,
    state: 'waiting',
    task_id: task?.task_id ?? null,
    agent_key: null,
    summary: null,
    preview: null,
    note: null,
    at: null,
    read,
  };
  if (goal.status === 'CANCELLED') return { ...base, state: 'cancelled' };
  if (!task) return base;
  const runs = state.q.runs(task.task_id);
  const run = runs.at(-1);
  const agent_key = run ? (state.q.findAgent(run.agent_id)?.agent_key ?? null) : null;
  // The newest attempt that handed in an answer: a later attempt without one does not unsay it.
  const claimed = [...runs].reverse().find((r) => (r.claim as { summary?: unknown } | null)?.summary);
  const claim = (claimed?.claim ?? null) as {
    summary?: string;
    answer_ref?: string | null;
    answer_preview?: string;
  } | null;
  if (task.status === 'COMPLETED' && claim) {
    let answer: string | null = null;
    if (opts.full) {
      try {
        answer = claim.answer_ref && state.artifacts ? state.artifacts.readText(claim.answer_ref) : null;
      } catch {
        answer = null;
      }
      // An agent that put its answer in the summary alone still answered.
      answer = answer ?? claim.answer_preview ?? claim.summary ?? null;
    }
    return {
      ...base,
      state: 'ready',
      agent_key: claimed ? (state.q.findAgent(claimed.agent_id)?.agent_key ?? agent_key) : agent_key,
      summary: claim.summary ?? null,
      preview: (claim.answer_preview ?? claim.summary ?? '').slice(0, 400) || null,
      ...(opts.full ? { answer } : {}),
      at: claimed?.ended_at ?? task.completed_at ?? null,
    };
  }
  if (task.status === 'FAILED' || task.status === 'ABANDONED') {
    return { ...base, state: 'failed', agent_key, at: task.updated_at };
  }
  if (task.status === 'CANCELLED') return { ...base, state: 'cancelled', agent_key };
  const working = ['ASSIGNED', 'RUNNING', 'WAITING', 'READY_FOR_VERIFICATION', 'VERIFYING', 'HARNESS_LOST'].includes(
    task.status,
  );
  return { ...base, state: working ? 'answering' : 'waiting', agent_key: working ? agent_key : null };
}

/** Every question on the board, by goal, without the answers' full text. */
export function answersOf(
  state: FridayState,
  projectId: string,
  goals: readonly GoalView[],
): Record<string, AnswerView> {
  const asked = goals.filter((g) => g.mode === 'ask');
  if (!asked.length) return {};
  const read = readAnswers(state, projectId);
  return Object.fromEntries(asked.map((g) => [g.goal_id, answerOf(state, projectId, g, { read })]));
}
