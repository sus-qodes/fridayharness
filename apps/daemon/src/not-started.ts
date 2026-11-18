import type { TaskView, TaskWaits } from '@friday/protocol';
import type { FridayState } from '@friday/state';

/**
 * Why a task that has not started is not at work, said for a person (2026-11-18). The board showed
 * such a task with nothing, or with the coordinator's last note in its own words, which could be
 * out of date: in the trial the waiting list said "Your turn in Antigravity" for a task whose own
 * page said it was held for another task's files, and a goal's third task sat there with no word
 * at all. Computed from the state as it is now, each time the board is read.
 */

const short = (text: string, max = 60) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

export interface NotStartedFacts {
  paused: boolean;
  /** Tasks a pending question of Friday's is about: nothing is done with them until it is answered. */
  asked: ReadonlySet<string>;
  nowIso: string;
}

export function notStartedFacts(state: FridayState, projectId: string, nowMs: number): NotStartedFacts {
  return {
    paused: state.q.control(projectId).paused,
    asked: new Set(
      state.q
        .escalations(projectId, 'pending')
        .filter((e) => e.kind === 'recovery_needed' || e.kind === 'routing_violated')
        .map((e) => String(e.task_id)),
    ),
    nowIso: new Date(nowMs).toISOString(),
  };
}

export function whyNotStarted(
  state: FridayState,
  projectId: string,
  task: TaskView,
  facts: NotStartedFacts,
): TaskWaits | null {
  if (task.status !== 'PROPOSED' && task.status !== 'READY') return null;
  const agentKeyOf = (id: string | null) => (id ? (state.q.findAgent(id)?.agent_key ?? null) : null);
  const named = (t: TaskView) => `“${short(t.summary)}”`;

  if (task.status === 'PROPOSED') {
    // What it depends on is not done, or done and not yet merged into the goal.
    const open = state.q
      .dependencies(task.task_id)
      .map((id) => state.q.findTask(projectId, id))
      .filter((d): d is TaskView => Boolean(d) && d?.status !== 'CANCELLED' && d?.status !== 'ABANDONED')
      .filter((d) => d.status !== 'COMPLETED' || !state.integratedWork(projectId, d.task_id));
    if (!open.length) return null;
    const how = (d: TaskView): string => {
      const who = agentKeyOf(d.assigned_agent_id);
      switch (d.status) {
        case 'COMPLETED':
          return 'finished, its work is being merged';
        case 'ASSIGNED':
        case 'RUNNING':
          return who ? `${who} is working on it` : 'being worked on';
        case 'WAITING':
          return who ? `${who} is waiting on it` : 'waiting';
        case 'READY_FOR_VERIFICATION':
        case 'VERIFYING':
          return 'being checked';
        case 'FAILED':
        case 'REWORK':
          return 'being redone';
        case 'HARNESS_LOST':
          return 'its agent stopped';
        default:
          return 'not started';
      }
    };
    const listed = open.slice(0, 3).map((d) => `${named(d)} (${how(d)})`);
    const more = open.length > listed.length ? ` and ${open.length - listed.length} more` : '';
    return { code: 'dependencies', text: `waits for ${listed.join(', ')}${more}` };
  }

  if (facts.paused) return { code: 'paused', text: 'Friday is paused: nothing new starts until you resume it' };
  if (facts.asked.has(task.task_id)) {
    return { code: 'question', text: 'it waits for your answer under “Waiting for you”' };
  }
  const key = task.reserved_for_agent_key;
  if (key) {
    const agent = state.q.agents(projectId).find((a) => a.agent_key === key);
    const harness = agent?.harness_id ? state.q.findHarness(agent.harness_id) : undefined;
    const live = Boolean(harness && state.q.isHarnessLive(harness.harness_id, facts.nowIso));
    if (!agent || !harness || !live) {
      return {
        code: 'agent_away',
        text: `kept for ${key}, which is not connected. Start it, or give the task to another agent`,
      };
    }
    if (agent.current_task_id && agent.current_task_id !== task.task_id) {
      const current = state.q.findTask(projectId, agent.current_task_id);
      return { code: 'agent_busy', text: `next for ${key}${current ? `, after ${named(current)}` : ''}` };
    }
    if (harness.attach_mode !== 'spawn') {
      return { code: 'your_turn', text: `kept for ${key}, which takes it when you prompt it in its window` };
    }
    // An agent Friday starts takes it at the coordinator's next pass: nothing to say.
    return null;
  }
  const last = state.q.assignments(task.task_id).at(-1);
  if (!last || last.agent_key) return null;
  const reason = String(last.reason ?? '');
  if (/^waits: its write scope overlaps/i.test(reason)) {
    // Who holds it up, when the coordinator's note names the task.
    const id = /for (task_[a-z0-9]+)\)/i.exec(reason)?.[1];
    const holder = id ? state.q.findTask(projectId, id) : undefined;
    const who = holder ? agentKeyOf(holder.assigned_agent_id) : null;
    return {
      code: 'shared_files',
      text: holder
        ? `waits for ${named(holder)}: ${who ?? 'its agent'} is changing the same files in your project folder`
        : 'waits for a task that is changing the same files in the same folder',
    };
  }
  if (/^waits: it shares files/i.test(reason)) {
    return {
      code: 'own_copy',
      text: 'it shares files with a task that is running, so it goes to an agent that works in a copy of its own, and none is free right now',
    };
  }
  if (/^no available agent/i.test(reason)) {
    const anyone = state.q
      .agents(projectId)
      .some((a) => a.harness_id && !a.shadow && state.q.isHarnessLive(a.harness_id, facts.nowIso));
    return anyone
      ? { code: 'no_agent', text: 'no agent is free right now' }
      : { code: 'no_agent', text: 'no agent is connected. Start one under Agents' };
  }
  return { code: 'other', text: short(reason.replace(/^waits:\s*/i, ''), 300) };
}
