/**
 * What the palette offers and in which order (plan §7.6): tasks, goals, agents and files from the
 * board (an open goal without a plan also offers its plan editor), and the registered commands;
 * recent actions first. The entries carry their own `run`, so the overlay only shows and runs
 * them. A command may ask to be offered only when typed (housekeeping) or never (what a button or
 * a key already does); the empty list shows the daily commands alone. Collecting and ranking need
 * no DOM.
 */
import type { UiSnapshot } from '@friday/protocol';
import { statusLook } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, type Command, type CommandShow, openDrawer, openModal } from '../shell/context.js';
import type { ActivityState } from '../store/state.js';
import { basename, cleanText, humanize, shortId, truncate } from '../ui/format.js';
import type { IconName } from '../ui/svg.js';
import { type FuzzyMatch, fuzzyMatch } from './fuzzy.js';

export type EntryGroup = 'command' | 'agent' | 'task' | 'goal' | 'file';

export interface PaletteEntry {
  /**
   * Stable across re-reads: `cmd:pause`, `task:<id>`, `goal:<id>`, `goal-plan:<id>`, `agent:<key>`,
   * `file:<task>:<path>`.
   */
  id: string;
  group: EntryGroup;
  /** Display text, already made safe (summaries cleaned, names with visible escapes). */
  label: string;
  detail?: string;
  /** Other words the search matches (ids, keys, roles, full paths). */
  keywords: string[];
  icon: IconName;
  /** Offered only once something is typed (housekeeping commands); never in the empty list. */
  typedOnly?: boolean;
  run: (ctx: AppContext) => void | Promise<void>;
}

export interface RankedEntry {
  entry: PaletteEntry;
  score: number;
  /** Matched characters of the label (empty when a keyword matched or the query is empty). */
  indices: number[];
  recent: boolean;
}

export const GROUP_LABEL: Record<EntryGroup, string> = {
  command: 'Commands',
  agent: 'Agents',
  task: 'Tasks',
  goal: 'Goals',
  file: 'Files',
};

const GROUP_ORDER: EntryGroup[] = ['command', 'agent', 'task', 'goal', 'file'];

export const LABEL_MAX = 120;
export const RECENT_MAX = 6;
export const RESULT_LIMIT = 50;
/** A keyword match counts a little less than the same match on the label. */
const KEYWORD_PENALTY = 4;

const COMMAND_ICON: Record<string, IconName> = {
  pause: 'pause',
  resume: 'play',
  halt: 'halt',
  'new-goal': 'plus',
  agents: 'robot',
  memory: 'memory',
  graph: 'graph',
  'reindex-graph': 'rework',
  'prune-worktrees': 'branch',
  settings: 'gear',
  mute: 'mute',
  unmute: 'sound',
  'stop-friday': 'stop',
  inbox: 'message',
  fit: 'fit',
  'zoom-in': 'zoomIn',
  'zoom-out': 'zoomOut',
  'reset-layout': 'fit',
};

/**
 * Where the palette offers a command: what the command declares (`show`, beside its registration,
 * so the rule for a command lives with the command), else always.
 */
export function commandShow(c: Pick<Command, 'id' | 'show'>): CommandShow {
  return c.show ?? 'always';
}

// ---- recent actions (kept in memory, per interface instance)

const RECENT = new WeakMap<object, string[]>();

/** The ids of the entries run most recently, newest first. */
export function recentIds(ctx: Pick<AppContext, 'registry'>): string[] {
  return RECENT.get(ctx.registry) ?? [];
}

export function remember(ctx: Pick<AppContext, 'registry'>, id: string): void {
  const next = [id, ...recentIds(ctx).filter((x) => x !== id)].slice(0, RECENT_MAX);
  RECENT.set(ctx.registry, next);
}

export function forgetRecent(ctx: Pick<AppContext, 'registry'>): void {
  RECENT.delete(ctx.registry);
}

// ---- collecting

/** A summary or request as one safe line. */
export function summaryLabel(text: string | null | undefined): string {
  return truncate(
    cleanText(text ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
    LABEL_MAX,
  );
}

export function commandEntry(c: Command): PaletteEntry {
  return {
    id: `cmd:${c.id}`,
    group: 'command',
    label: c.label,
    keywords: [...(c.keywords ?? []), c.id],
    icon: COMMAND_ICON[c.id] ?? 'bolt',
    ...(commandShow(c) === 'typed' ? { typedOnly: true } : {}),
    run: (ctx) => c.run(ctx),
  };
}

function commandAvailable(ctx: AppContext, c: Command): boolean {
  if (!c.available) return true;
  try {
    return c.available(ctx);
  } catch {
    return false;
  }
}

export function boardEntries(board: UiSnapshot | null, activity: ActivityState | null): PaletteEntry[] {
  if (!board) return [];
  const out: PaletteEntry[] = [];
  const taskById = new Map(board.tasks.map((t) => [t.task_id, t]));

  for (const agent of board.agents) {
    const harness = board.harnesses.find((x) => x.harness_id === agent.harness_id);
    const task = agent.current_task_id ? taskById.get(agent.current_task_id) : undefined;
    const parts = [humanize(agent.status)];
    if (task) parts.push(summaryLabel(task.summary));
    out.push({
      id: `agent:${agent.agent_key}`,
      group: 'agent',
      label: visible(agent.agent_key),
      detail: parts.join(' · '),
      keywords: [agent.role, harness?.vendor ?? '', harness?.name ?? ''].filter(Boolean).map((k) => visible(k)),
      icon: 'robot',
      run: (ctx) => openDrawer(ctx, { kind: 'terminal', id: agent.agent_key }),
    });
  }

  for (const task of board.tasks) {
    out.push({
      id: `task:${task.task_id}`,
      group: 'task',
      label: summaryLabel(task.summary) || shortId(task.task_id),
      detail: `${shortId(task.task_id)} · ${statusLook(task.status).label}${task.agent_key ? ` · ${visible(task.agent_key)}` : ''}`,
      keywords: [task.task_id, task.plan_key ?? '', task.kind].filter(Boolean).map((k) => visible(k)),
      icon: 'target',
      run: (ctx) => {
        ctx.store.patch('ui', { selectedTaskId: task.task_id });
        openDrawer(ctx, { kind: 'inspector', id: task.task_id });
      },
    });
  }

  for (const goal of board.goals) {
    const label = summaryLabel(goal.objective || goal.request) || shortId(goal.goal_id);
    out.push({
      id: `goal:${goal.goal_id}`,
      group: 'goal',
      label,
      detail: `${shortId(goal.goal_id)} · ${humanize(goal.status)}`,
      keywords: [goal.goal_id, summaryLabel(goal.request)],
      icon: 'goal',
      // The interface has one selection; the canvas selects and centres the node whose id it holds.
      run: (ctx) => ctx.store.patch('ui', { selectedTaskId: goal.goal_id }),
    });
    // An open goal without a plan, active or proposed: its plan editor, whenever the human returns.
    const plans = board.plans[goal.goal_id];
    if (goal.status === 'OPEN' && !plans?.active && !plans?.proposed) {
      out.push({
        id: `goal-plan:${goal.goal_id}`,
        group: 'goal',
        label: truncate(`Write the plan: ${label}`, LABEL_MAX),
        detail: `${shortId(goal.goal_id)} · No plan yet`,
        keywords: [goal.goal_id, 'write plan', 'plan editor'],
        icon: 'goal',
        run: (ctx) => openModal(ctx, { kind: 'plan-editor', id: goal.goal_id, mode: 'first' }),
      });
    }
  }

  if (activity) {
    const seen = new Set<string>();
    for (const [taskId, files] of Object.entries(activity.files)) {
      const task = taskById.get(taskId);
      for (const f of files) {
        const key = `${taskId}\u0000${f.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const shown = visible(f.path);
        out.push({
          id: `file:${taskId}:${f.path}`,
          group: 'file',
          label: visible(basename(f.path)),
          detail: `${shown}${task ? ` · ${summaryLabel(task.summary)}` : ` · ${shortId(taskId)}`}`,
          keywords: [shown],
          icon: 'file',
          run: (ctx) => openDrawer(ctx, { kind: 'diff', id: taskId, path: f.path }),
        });
      }
    }
  }
  return out;
}

/**
 * Every entry the palette offers now: available commands first (never the ones the palette does
 * not list), then the board.
 */
export function collectEntries(ctx: AppContext): PaletteEntry[] {
  const commands = [...ctx.registry.commands.values()]
    .filter((c) => commandShow(c) !== 'never' && commandAvailable(ctx, c))
    .map(commandEntry);
  return [...commands, ...boardEntries(ctx.store.select('board'), ctx.store.select('activity'))];
}

// ---- ranking

function bestMatch(query: string, entry: PaletteEntry): FuzzyMatch | null {
  const onLabel = fuzzyMatch(query, entry.label);
  let best: FuzzyMatch | null = onLabel;
  for (const k of entry.keywords) {
    const m = fuzzyMatch(query, k);
    if (m && (!best || m.score - KEYWORD_PENALTY > best.score))
      best = { score: m.score - KEYWORD_PENALTY, indices: [] };
  }
  return best;
}

/**
 * Orders the entries for `query`. With no query: recent entries (newest first), then by group
 * (commands, agents, tasks, goals, files) in their own order, leaving out the entries offered only
 * when typed (a recently run one still shows under Recent: the person chose it). With a query:
 * only matches, recent matches first, then by score, then by a shorter label.
 */
export function rankEntries(
  entries: readonly PaletteEntry[],
  query: string,
  recent: readonly string[] = [],
  limit = RESULT_LIMIT,
): RankedEntry[] {
  const recentRank = new Map(recent.map((id, i) => [id, i]));
  const q = query.trim();
  if (!q) {
    const recents = recent
      .map((id) => entries.find((e) => e.id === id))
      .filter((e): e is PaletteEntry => !!e)
      .map((entry) => ({ entry, score: 0, indices: [], recent: true }));
    const rest = entries
      .filter((e) => !recentRank.has(e.id) && !e.typedOnly)
      .map((entry, i) => ({ entry, i }))
      .sort((a, b) => GROUP_ORDER.indexOf(a.entry.group) - GROUP_ORDER.indexOf(b.entry.group) || a.i - b.i)
      .map(({ entry }) => ({ entry, score: 0, indices: [], recent: false }));
    return [...recents, ...rest].slice(0, limit);
  }
  const ranked: (RankedEntry & { i: number })[] = [];
  entries.forEach((entry, i) => {
    const m = bestMatch(q, entry);
    if (m) ranked.push({ entry, score: m.score, indices: m.indices, recent: recentRank.has(entry.id), i });
  });
  ranked.sort((a, b) => {
    if (a.recent !== b.recent) return a.recent ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    const len = Array.from(a.entry.label).length - Array.from(b.entry.label).length;
    return len || a.i - b.i;
  });
  return ranked.slice(0, limit).map(({ i: _i, ...r }) => r);
}
