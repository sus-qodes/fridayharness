/**
 * A goal's story in a few lines (2026-11-18): what needs the person, who is working on what, what
 * waits and why, and what is finished. The goal card showed a bar and a percentage; to learn who
 * did what a person opened each task, and the agents' cards said "last tool", "tokens" and
 * "reported" instead. Pure: read from the board, no DOM.
 */
import type { IntegrationView, RunView, SnapshotTask, UiSnapshot } from '@friday/protocol';
import { cleanText, truncate } from '../ui/format.js';

export type StoryTone = 'you' | 'work' | 'wait' | 'done';

export interface StoryLine {
  tone: StoryTone;
  text: string;
  taskId: string | null;
}

/** At most this many lines on a goal card; the rest is counted in the last one. */
export const STORY_MAX = 4;

export interface StoryInput {
  tasks: readonly SnapshotTask[];
  runs: Readonly<Record<string, RunView>>;
  integrations: Readonly<Record<string, IntegrationView>>;
  /** Agent id to the name people see. */
  agentKeyOf: (agentId: string | null | undefined) => string | null;
  /** Tasks a card under "Waiting for you" is about (an approval or a question). */
  asked: ReadonlySet<string>;
}

const ORDER: Record<StoryTone, number> = { you: 0, work: 1, wait: 2, done: 3 };

function lineOf(t: SnapshotTask, input: StoryInput, alone: boolean): StoryLine | null {
  // One task: the goal's own text says what it is.
  const name = alone ? 'it' : `“${truncate(cleanText(t.summary), 48)}”`;
  const who = t.agent_key ?? input.agentKeyOf(input.runs[t.task_id]?.agent_id) ?? null;
  const line = (tone: StoryTone, text: string): StoryLine => ({ tone, text, taskId: t.task_id });
  const integration = input.integrations[t.task_id];
  switch (t.status) {
    case 'CANCELLED':
    case 'ABANDONED':
      return null;
    case 'COMPLETED': {
      if (integration?.status === 'conflicted' || integration?.status === 'failed') {
        return line('you', `${alone ? 'Its work' : `${name}`} does not fit the other tasks’ work yet: your decision`);
      }
      if (integration && integration.status !== 'integrated' && integration.status !== 'not_needed') {
        return line('work', `Friday is merging ${name}`);
      }
      return line('done', who ? `${who} finished ${name}` : `${alone ? 'It is' : `${name} is`} finished`);
    }
    case 'WAITING':
      if (t.waiting_reason === 'blocked' || t.waiting_reason === 'human_approval' || input.asked.has(t.task_id)) {
        return line('you', `${who ?? 'The agent'} needs you for ${name}`);
      }
      return line('work', `${who ?? 'An agent'} is on ${name}, waiting`);
    case 'ASSIGNED':
    case 'RUNNING':
      if (input.asked.has(t.task_id) || t.attention) {
        return line('you', `${who ?? 'The agent'} needs you for ${name}`);
      }
      return line('work', `${who ?? 'An agent'} is working on ${name}`);
    case 'READY_FOR_VERIFICATION':
    case 'VERIFYING':
      return line('work', `Friday is checking ${alone ? 'the work' : name}`);
    case 'FAILED':
    case 'REWORK':
      return line('work', `${alone ? 'It' : name} goes back to ${who ?? 'its agent'}`);
    case 'HARNESS_LOST':
      return line('you', `${who ?? 'The agent'} stopped on ${name}`);
    default: {
      // PROPOSED, READY: not started, and why when Friday knows.
      const why = t.delegation_note ? cleanText(t.delegation_note).replace(/^waits:\s*/i, '') : '';
      if (t.waits_for === 'your_turn' || t.waits_for === 'agent_away' || t.waits_for === 'question') {
        return line('you', `${alone ? 'It' : name}: ${truncate(why, 90)}`);
      }
      return line(
        'wait',
        why ? `${alone ? 'It' : name} ${truncate(why, 90)}` : `${alone ? 'It has' : `${name} has`} not started`,
      );
    }
  }
}

/** The goal's lines, what needs the person first; finished tasks last, and counted when there is no room. */
export function goalStory(input: StoryInput): StoryLine[] {
  const live = input.tasks.filter((t) => t.status !== 'CANCELLED' && t.status !== 'ABANDONED');
  const alone = live.length === 1;
  const lines = live
    .map((t) => lineOf(t, input, alone))
    .filter((l): l is StoryLine => l !== null)
    .map((l, i) => ({ l, i }))
    .sort((a, b) => ORDER[a.l.tone] - ORDER[b.l.tone] || a.i - b.i)
    .map((x) => x.l);
  if (lines.length <= STORY_MAX) return lines;
  const shown = lines.slice(0, STORY_MAX - 1);
  const rest = lines.slice(STORY_MAX - 1);
  const done = rest.filter((l) => l.tone === 'done').length;
  const other = rest.length - done;
  const parts = [other ? `${other} more not finished` : '', done ? `${done} finished` : ''].filter(Boolean);
  return [...shown, { tone: other ? 'wait' : 'done', text: `and ${parts.join(', ')}`, taskId: null }];
}

/** The story of one goal as the board's snapshot has it; nothing for a question, whose card says where its answer stands. */
export function storyOfGoal(snapshot: UiSnapshot | null, goalId: string): StoryLine[] {
  if (!snapshot) return [];
  if (snapshot.goals.find((g) => g.goal_id === goalId)?.mode === 'ask') return [];
  const tasks = snapshot.tasks.filter((t) => t.goal_id === goalId);
  if (!tasks.length) return [];
  const keys = new Map(snapshot.agents.map((a) => [a.agent_id, a.agent_key]));
  const asked = new Set<string>();
  for (const a of snapshot.approvals) if (a.task_id && !a.expired) asked.add(a.task_id);
  for (const e of snapshot.escalations) if (e.task_id) asked.add(String(e.task_id));
  return goalStory({
    tasks,
    runs: snapshot.runs,
    integrations: snapshot.integrations,
    agentKeyOf: (id) => (id ? (keys.get(id) ?? null) : null),
    asked,
  });
}

/** What the lines add to a goal card's height: the layout reserves exactly the space the card is drawn in. */
export function storyHeight(lines: number): number {
  return lines > 0 ? 6 + lines * 18 : 0;
}
