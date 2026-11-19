import type { RunView, TaskView, TaskWhy } from '@friday/protocol';
import type { FridayState } from '@friday/state';

/**
 * Why a task went to its agent and runs on its model, in a person's words (2026-11-18). In the
 * trial a read-only question went to Claude on Opus and cost about $1.60; the person asked "how does
 * it decide that this needs to be done by claude?". The answer was a pin they had set on the Models
 * page, and nothing on screen said so. Read from Friday's own records: the last assignment of the
 * task and the routing decision of its attempt. Null where nothing is on record.
 */

/** The coordinator's reason for an agent, as it writes it (`delegate`), in plain words. */
function agentWords(reason: string, role: string | null): string | null {
  if (/^the role it names/.test(reason))
    return role ? `it does ${role} work` : 'it does the kind of work the task needs';
  if (/^a small, low-risk task/.test(reason)) return 'a small task: the least costly agent that can do it';
  if (/^reserved for this agent/.test(reason)) return 'it worked on this task before';
  if (/^no agent that starts by itself is free/.test(reason))
    return 'the only free agent: it takes the task when you prompt it';
  if (/starts by itself/.test(reason)) return 'free, and it starts by itself';
  if (/^highest score/.test(reason)) return 'the best fit of the free agents';
  return null;
}

export function whyChosen(
  state: FridayState,
  projectId: string,
  task: TaskView,
  run: RunView | undefined,
): TaskWhy | null {
  const agentId = task.assigned_agent_id ?? run?.agent_id ?? null;
  const agentKey = agentId ? (state.q.findAgent(agentId)?.agent_key ?? null) : null;
  let agent: string | null = null;
  if (agentKey) {
    const assigned = state.store.readByRef(projectId, 'task', task.task_id, {
      types: ['task.assigned'],
      desc: true,
      limit: 1,
    })[0];
    const by = assigned?.actor.kind;
    if (by === 'human') agent = 'you gave it this task';
    else if (by === 'agent') agent = 'it took the task itself';
    else {
      const decided = state.q
        .assignments(task.task_id)
        .filter((a) => a.agent_key === agentKey)
        .at(-1);
      agent = decided?.reason ? agentWords(String(decided.reason), task.role ?? null) : null;
    }
  }
  let model: string | null = null;
  const decision = run?.routing_decision_id ? state.q.routingDecision(run.routing_decision_id) : undefined;
  if (decision?.model) {
    if (decision.source === 'pin') {
      const pin = decision.pin_id
        ? state.q.routingPins(projectId).find((p) => p.pin_id === decision.pin_id)
        : undefined;
      model =
        pin?.scope === 'project'
          ? 'you chose it for every task (Settings → Models)'
          : pin?.scope === 'task'
            ? 'you chose it for this task'
            : pin?.scope === 'kind'
              ? `you chose it for every ${pin.target ?? ''} task`.replace(/\s+/g, ' ')
              : pin?.scope === 'role'
                ? `you chose it for ${pin.target ?? 'this kind of'} work`
                : 'you chose it';
    } else if (decision.source === 'registry') {
      model = "Friday's choice for this kind of work";
    } else if (decision.source === 'assignment') {
      model = 'the model the agent was started with';
    }
  }
  if (!agent && !model) return null;
  return {
    agent_key: agentKey,
    agent,
    model: decision?.model ?? run?.model_observed ?? null,
    model_reason: model,
  };
}
