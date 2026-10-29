/**
 * Browser notifications and the title badge (plan FD-25, §7.1, §7.10).
 *
 * - **Title:** always `(N) Friday — <project>`, N = approvals + questions + blocked agents waiting
 *   (one decision counted once), or `Friday — <project>` when nothing waits; `opts.title` replaces
 *   the base.
 * - **Notifications:** only when the Settings toggle is on (`prefs.notifications`, asked from a
 *   user gesture there), the browser granted permission, and the tab is hidden. Triggers: a new
 *   approval, question, proposed plan, blocked agent, failure, and Friday stopping. One per item;
 *   items present when the notifier starts are not announced. Clicking one focuses the window.
 *
 * In the desktop shell native notifications come from Rust (plan §8.7); the shell decides whether
 * to start this one.
 */
import type { SnapshotTask, UiSnapshot } from '@friday/protocol';
import { visible } from '../model/text.js';
import { nextExpiryIn, waitingItems } from '../notch/derive.js';
import { realTimers, type TimerApi } from '../notch/island-fsm.js';
import type { AppContext } from '../shell/context.js';
import type { Connection } from '../store/state.js';
import { cleanText, truncate } from '../ui/format.js';

export interface NotificationLike {
  onclick: ((this: never, ev: Event) => unknown) | null;
  close(): void;
}

export interface NotificationCtor {
  new (title: string, options?: NotificationOptions): NotificationLike;
  readonly permission: NotificationPermission;
}

export interface NotifierEnv {
  Notification: NotificationCtor | undefined;
  document: { title: string; readonly visibilityState: DocumentVisibilityState } & Pick<
    Document,
    'addEventListener' | 'removeEventListener'
  >;
  focusWindow(): void;
  timers: TimerApi;
}

export interface Notice {
  key: string;
  title: string;
  body: string;
  taskId: string | null;
}

/** At most this many notifications per update; the rest are summed up in one. */
export const MAX_PER_UPDATE = 3;
const EXPIRY_SLACK_MS = 50;
const EXPIRY_MAX_MS = 10 * 60_000;

/** `(2) Friday — shop`; `Friday — shop` when nothing waits. */
export function pageTitle(base: string, waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${base}` : base;
}

export function baseTitle(board: UiSnapshot | null, override?: string): string {
  if (override) return override;
  const name = board?.project.name ? truncate(cleanText(board.project.name), 60) : '';
  return name ? `Friday — ${name}` : 'Friday';
}

/** What the notifier remembers between boards. */
export interface NoticeMemory {
  /** Approvals, questions and plans already announced (or present at the start). */
  seen: Set<string>;
  /** Tasks blocked (WAITING(blocked)) in the previous board. */
  blocked: Set<string>;
  /** Tasks failed or lost in the previous board, with the status. */
  failed: Map<string, string>;
}

function blockedTasks(board: UiSnapshot): SnapshotTask[] {
  return board.tasks.filter((t) => t.status === 'WAITING' && t.waiting_reason === 'blocked');
}

function failedTasks(board: UiSnapshot): SnapshotTask[] {
  return board.tasks.filter((t) => t.status === 'FAILED' || t.status === 'HARNESS_LOST');
}

function planKeys(board: UiSnapshot): { key: string; goalId: string }[] {
  const out: { key: string; goalId: string }[] = [];
  for (const [goalId, p] of Object.entries(board.plans)) {
    if (p.proposed) out.push({ key: `plan:${p.proposed.plan_id}:${p.proposed.version}`, goalId });
  }
  return out;
}

/** The memory of a board whose items are not announced (the first one). */
export function remember(board: UiSnapshot, now: number): NoticeMemory {
  const seen = new Set<string>();
  for (const item of waitingItems(board, now)) if (item.kind !== 'waiting') seen.add(item.key);
  for (const p of planKeys(board)) seen.add(p.key);
  return {
    seen,
    blocked: new Set(blockedTasks(board).map((t) => t.task_id)),
    failed: new Map(failedTasks(board).map((t) => [t.task_id, t.status])),
  };
}

function short(text: string | null | undefined, max = 160): string {
  return text ? truncate(cleanText(text), max) : '';
}

/**
 * The notices a new board brings, and the memory after it. Pure: the caller decides whether they
 * are shown (and marks them seen either way, so an item is never announced twice).
 */
export function diffNotices(memory: NoticeMemory, board: UiSnapshot, now: number): Notice[] {
  const notices: Notice[] = [];
  const items = waitingItems(board, now);
  const covered = new Set<string>();
  for (const item of items) {
    if (item.kind === 'approval') {
      if (item.taskId) covered.add(item.taskId);
      if (memory.seen.has(item.key)) continue;
      memory.seen.add(item.key);
      const a = item.approval;
      const target = a.target ? `: ${truncate(visible(a.target), 140)}` : '';
      notices.push({
        key: item.key,
        title: a.risk === 'high' ? 'High-risk approval needed' : 'Approval needed',
        body: `${truncate(visible(a.capability), 60)}${target}`,
        taskId: a.task_id,
      });
    } else if (item.kind === 'question') {
      if (item.taskId) covered.add(item.taskId);
      if (memory.seen.has(item.key)) continue;
      memory.seen.add(item.key);
      notices.push({
        key: item.key,
        title: 'A question for you',
        body: short(item.escalation.question),
        taskId: item.taskId,
      });
    }
  }
  for (const p of planKeys(board)) {
    if (memory.seen.has(p.key)) continue;
    memory.seen.add(p.key);
    const goal = board.goals.find((g) => g.goal_id === p.goalId);
    notices.push({
      key: p.key,
      title: 'A plan waits for your review',
      body: short(goal?.objective ?? goal?.request ?? board.plans[p.goalId]?.proposed?.summary ?? ''),
      taskId: null,
    });
  }
  const blocked = blockedTasks(board);
  for (const t of blocked) {
    if (memory.blocked.has(t.task_id) || covered.has(t.task_id)) continue;
    notices.push({
      key: `blocked:${t.task_id}:${t.updated_at}`,
      title: 'An agent is blocked',
      body: `${t.agent_key ? `${short(t.agent_key, 40)}: ` : ''}${short(t.waiting_note ?? t.summary)}`,
      taskId: t.task_id,
    });
  }
  memory.blocked = new Set(blocked.map((t) => t.task_id));
  const failed = failedTasks(board);
  for (const t of failed) {
    if (memory.failed.get(t.task_id) === t.status) continue;
    notices.push({
      key: `${t.status === 'FAILED' ? 'failed' : 'lost'}:${t.task_id}:${t.updated_at}`,
      title: t.status === 'FAILED' ? 'A task failed' : 'An agent was lost',
      body: short(t.summary),
      taskId: t.task_id,
    });
  }
  memory.failed = new Map(failed.map((t) => [t.task_id, t.status]));
  return notices;
}

export function startNotifier(ctx: AppContext, opts: { title?: string } = {}): () => void {
  return startNotifierWith(ctx, opts, {
    Notification: typeof Notification === 'undefined' ? undefined : (Notification as unknown as NotificationCtor),
    document,
    focusWindow: () => window.focus(),
    timers: realTimers,
  });
}

export function startNotifierWith(ctx: AppContext, opts: { title?: string }, env: NotifierEnv): () => void {
  const store = ctx.store;
  const doc = env.document;
  const originalTitle = doc.title;
  let memory: NoticeMemory | null = null;
  let stopped = false;
  let expiryTimer: unknown = null;
  /** Shown notifications by item key, closed when their item leaves or the tab comes back. */
  const open = new Map<string, NotificationLike>();

  function allowed(): boolean {
    return (
      store.select('prefs').notifications === true &&
      !!env.Notification &&
      env.Notification.permission === 'granted' &&
      doc.visibilityState === 'hidden'
    );
  }

  function show(n: Notice): void {
    const Ctor = env.Notification;
    if (!Ctor) return;
    try {
      const shown = new Ctor(n.title, { body: n.body, tag: n.key });
      shown.onclick = () => {
        env.focusWindow();
        if (n.taskId) store.patch('ui', { selectedTaskId: n.taskId });
        shown.close();
        open.delete(n.key);
      };
      open.set(n.key, shown);
    } catch {
      // A browser that refuses page notifications (some need a service worker): the title still counts.
    }
  }

  function announce(notices: Notice[]): void {
    if (!notices.length || !allowed()) return;
    const project = baseTitle(store.select('board'), opts.title);
    for (const n of notices.slice(0, MAX_PER_UPDATE)) show({ ...n, title: `${n.title} — ${project}` });
    const rest = notices.length - MAX_PER_UPDATE;
    if (rest > 0) {
      show({
        key: `more:${notices[MAX_PER_UPDATE]?.key ?? rest}`,
        title: `${project}: ${rest} more ${rest === 1 ? 'item needs' : 'items need'} you`,
        body: 'Open Friday to see them.',
        taskId: null,
      });
    }
  }

  function closeGone(board: UiSnapshot): void {
    if (!open.size) return;
    const live = new Set(waitingItems(board, ctx.now()).map((i) => i.key));
    for (const [key, n] of open) {
      if (!(key.startsWith('approval:') || key.startsWith('question:'))) continue;
      if (live.has(key)) continue;
      try {
        n.close();
      } catch {
        // already closed
      }
      open.delete(key);
    }
  }

  function updateTitle(): void {
    const board = store.select('board');
    const next = pageTitle(baseTitle(board, opts.title), waitingItems(board, ctx.now()).length);
    if (doc.title !== next) doc.title = next;
    if (expiryTimer !== null) env.timers.clear(expiryTimer);
    expiryTimer = null;
    const ms = nextExpiryIn(board, ctx.now());
    if (ms !== null)
      expiryTimer = env.timers.set(
        () => {
          expiryTimer = null;
          if (!stopped) updateTitle();
        },
        Math.min(EXPIRY_MAX_MS, ms + EXPIRY_SLACK_MS),
      );
  }

  function onBoard(board: UiSnapshot | null): void {
    updateTitle();
    if (!board) return;
    if (!memory) {
      memory = remember(board, ctx.now());
      return;
    }
    announce(diffNotices(memory, board, ctx.now()));
    closeGone(board);
  }

  function onConnection(next: Connection, prev: Connection): void {
    if (next !== 'stopped' || prev === 'stopped') return;
    announce([
      {
        key: `stopped:${ctx.now()}`,
        title: 'Friday stopped',
        body: 'Open it again from its shortcut or the desktop app.',
        taskId: null,
      },
    ]);
  }

  const onVisibility = (): void => {
    if (doc.visibilityState !== 'visible') return;
    for (const n of open.values()) {
      try {
        n.close();
      } catch {
        // already closed
      }
    }
    open.clear();
  };

  const unsubs = [
    store.subscribe('board', (b) => onBoard(b)),
    store.subscribe('system', (next, prev) => onConnection(next.connection, prev.connection)),
  ];
  doc.addEventListener('visibilitychange', onVisibility);
  onBoard(store.select('board'));

  return () => {
    if (stopped) return;
    stopped = true;
    for (const u of unsubs) u();
    doc.removeEventListener('visibilitychange', onVisibility);
    if (expiryTimer !== null) env.timers.clear(expiryTimer);
    doc.title = originalTitle;
  };
}
