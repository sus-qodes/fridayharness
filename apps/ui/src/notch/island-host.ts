/**
 * Mounts the Notch (plan §7.8): the state machine, the island and its views, wired to the store.
 *
 * - **Pin:** everything that waits for a human (`waitingItems`) pins the island; a new one opens
 *   the card (`itemArrived`), one leaving it (decided here or elsewhere) collapses it unless
 *   another waits. `ui.notchPinned` and `ui.notchFolded` mirror the machine. Memories to review and
 *   an untrusted policy pin without opening the card: they wait, but not on this minute.
 * - **Reactions** are consumed by id: `approval` and `question` open the card in the same tick as
 *   their event, before the snapshot re-read; `goal-completed` celebrates.
 * - **In the page** the island is the pill alone (review §4, owner decision 1): no card is built,
 *   hover and click open nothing, and the pill's parts are doors to the Studio beside it. **In the
 *   notch window** it fills the window, makes the page transparent and reports its rectangle
 *   through `onRect`.
 */
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import type { RootState } from '../store/state.js';
import {
  buildModel,
  type NotchModel,
  nextExpiryIn,
  type StudioTarget,
  studioTarget,
  type WaitingItem,
  type WaitingKind,
  waitingItems,
} from './derive.js';
import { type AnimationEnv, ISLAND_BORDER, Island, stateGeometry, WINDOW_MAX_HEIGHT } from './island.js';
import { IslandFsm, type IslandSnapshot, type IslandState, realTimers, type TimerApi } from './island-fsm.js';
import {
  absentView,
  compactView,
  type ExpandedView,
  expandedView,
  greetingView,
  hiddenView,
  isInteractive,
  type NotchSlots,
  type NotchView,
  type ViewHandlers,
} from './island-views.js';

export type { IslandRect } from './island.js';
export type { NotchSlots } from './island-views.js';

/** Where the Studio opens for the notch window: a task, an approval, or one of its drawers. */
export type NotchStudioTarget = StudioTarget;

export interface NotchOptions {
  mode: 'in-page' | 'window';
  onRect?: (r: { x: number; y: number; width: number; height: number }) => void;
  onOpenStudio?: (target: NotchStudioTarget) => void;
  /**
   * The pill's waiting chip was clicked in a page: show the rail (the shell scrolls it to the top
   * and focuses it, as for the header's count). Without it the Notch finds the list in the page.
   */
  onShowWaiting?: () => void;
}

/** The mounted Notch. It is a `Component`; `open` serves the Notch shortcut. */
export interface NotchHandle extends Component {
  /** Opens the card; `focus` gives it the keyboard (the desktop's Notch shortcut). */
  open(focus?: boolean): void;
  /** The machine's state (tests and the desktop shell). */
  state(): IslandSnapshot;
}

/** What the Notch needs from its surroundings; tests pass fakes. */
export interface NotchEnv {
  timers: TimerApi;
  raf(cb: (t: number) => void): number;
  caf(handle: number): void;
  /** The expanded card's natural height. */
  measure(el: HTMLElement): number;
  /** The system's reduced-motion setting. */
  systemReducedMotion(): boolean;
}

/** Stats are read at most once a second per task, and not again for 30 s after a failure. */
const STATS_INTERVAL_MS = 1000;
const STATS_BACKOFF_MS = 30_000;
/** Re-derive the pin this long after the next approval expires. */
const EXPIRY_SLACK_MS = 50;
/** Never wait longer than this for an expiry (timers have a ceiling). */
const EXPIRY_MAX_MS = 10 * 60_000;
/**
 * The kinds whose arrival opens the window's card: someone is waiting on the human now. A proposed
 * plan, memories to review and an untrusted policy pin the pill with their count instead (the
 * notifier announces the plan).
 */
const OPENS_CARD: ReadonlySet<WaitingKind> = new Set<WaitingKind>(['approval', 'question', 'waiting', 'message']);
/** The Studio's "Waiting for you" list, found in the page when the shell gave no `onShowWaiting`. */
const TRAY_SELECTOR = '.gv-tray';

export function defaultNotchEnv(): NotchEnv {
  return {
    timers: realTimers,
    raf: (cb) => window.requestAnimationFrame(cb),
    caf: (handle) => window.cancelAnimationFrame(handle),
    measure: (el) => el.offsetHeight || el.getBoundingClientRect().height || el.scrollHeight || 0,
    systemReducedMotion: () => {
      try {
        return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    },
  };
}

export function mountNotch(
  ctx: AppContext,
  container: HTMLElement,
  slots: NotchSlots,
  opts: NotchOptions,
): NotchHandle {
  return mountNotchWith(ctx, container, slots, opts, defaultNotchEnv());
}

function maxReaction(state: Readonly<RootState>): number {
  return state.activity.reactions.reduce((m, r) => Math.max(m, r.id), 0);
}

export function mountNotchWith(
  ctx: AppContext,
  container: HTMLElement,
  slots: NotchSlots,
  opts: NotchOptions,
  env: NotchEnv,
): NotchHandle {
  const store = ctx.store;
  let destroyed = false;
  const inPage = opts.mode === 'in-page';
  const prefs0 = store.select('prefs');
  const fsm = new IslandFsm({
    initial: 'compact',
    timers: env.timers,
    timings: { collapseS: prefs0.notchAutoCollapseS, hideS: prefs0.notchHideS },
    card: !inPage,
  });

  const reducedMotion = (): boolean => {
    const motion = store.select('prefs').motion;
    if (motion === 'reduce') return true;
    if (motion === 'full') return false;
    return env.systemReducedMotion();
  };
  const containerWidth = (): number =>
    container.clientWidth || container.getBoundingClientRect().width || window.innerWidth || 0;
  const animation: AnimationEnv = { raf: env.raf, caf: env.caf, reducedMotion, containerWidth };
  const island = new Island({ mode: opts.mode, env: animation, ...(opts.onRect ? { onRect: opts.onRect } : {}) });

  // ---- what the views ask for --------------------------------------------------------------
  let model: NotchModel | null = null;
  let currentKey: string | null = null;

  /** Opens `target` in the Studio: through the shell when there is one, else in this page. */
  function goStudio(target: StudioTarget): void {
    if (opts.onOpenStudio) {
      opts.onOpenStudio(target);
      return;
    }
    if (target.panel === 'plan-review') {
      // The plan review is a dialog, not a drawer; it opens on the goal.
      openModal(ctx, { kind: 'plan-review', ...(target.id ? { id: target.id } : {}) });
      return;
    }
    if (target.panel) {
      const id = target.id ?? target.task_id;
      openDrawer(ctx, {
        kind: target.panel,
        ...(id ? { id } : {}),
        ...(target.tab ? { tab: target.tab } : {}),
        ...(target.path ? { path: target.path } : {}),
      });
      return;
    }
    if (target.task_id) store.patch('ui', { selectedTaskId: target.task_id });
    if (target.approval_id) openModal(ctx, { kind: 'approval', id: target.approval_id });
  }

  function currentItem(): WaitingItem | null {
    const items = model?.items ?? [];
    return items.find((i) => i.key === currentKey) ?? items[0] ?? null;
  }

  function focusWaiting(): void {
    if (opts.onShowWaiting) {
      opts.onShowWaiting();
      return;
    }
    const tray = container.ownerDocument.querySelector<HTMLElement>(TRAY_SELECTOR);
    if (!tray) return;
    if (typeof tray.scrollIntoView === 'function') tray.scrollIntoView({ block: 'start' });
    (tray.querySelector<HTMLElement>('button') ?? tray).focus();
  }

  const handlers: ViewHandlers = {
    open: () => fsm.open(),
    openDiff: (taskId, path) => {
      if (inPage || !opts.onOpenStudio) openDrawer(ctx, { kind: 'diff', id: taskId, path });
      else opts.onOpenStudio({ task_id: taskId, panel: 'diff', ...(path ? { path } : {}) });
    },
    openStudio: () => {
      goStudio(studioTarget(currentItem(), model?.active?.task.task_id ?? null));
      fsm.studioOpened();
    },
    openStudioGeneral: () => {
      goStudio(studioTarget(null, model?.active?.task.task_id ?? null));
      fsm.studioOpened();
    },
    openItem: (item) => {
      goStudio(studioTarget(item, model?.active?.task.task_id ?? null));
      fsm.studioOpened();
    },
    inspect: (taskId) => {
      if (inPage || !opts.onOpenStudio) {
        store.patch('ui', { selectedTaskId: taskId });
        openDrawer(ctx, { kind: 'inspector', id: taskId });
      } else opts.onOpenStudio({ task_id: taskId });
    },
    focusWaiting,
    later: () => fsm.later(),
    settings: () => {
      // The notch window is too small for the settings drawer: the Studio shows it.
      if (inPage || !opts.onOpenStudio) openDrawer(ctx, { kind: 'settings' });
      else opts.onOpenStudio({ panel: 'settings' });
    },
    toggleMute: () => store.patch('prefs', { muted: !store.select('prefs').muted }),
    page: (delta) => {
      const items = model?.items ?? [];
      if (!items.length) return;
      const at = Math.max(
        0,
        items.findIndex((i) => i.key === currentKey),
      );
      const next = Math.min(items.length - 1, Math.max(0, at + delta));
      currentKey = items[next]?.key ?? null;
      render();
    },
    promptDone: () => {
      const waiting = waitingItems(store.select('board'), ctx.now()).length;
      fsm.decided(waiting > 0);
    },
  };

  // ---- views ---------------------------------------------------------------------------------
  const hidden = hiddenView(handlers);
  const compact = compactView(handlers, { card: !inPage });
  // A page has no card: nothing of it is built, the goal line included.
  const expanded: ExpandedView | null = inPage ? null : expandedView(ctx, slots, handlers);
  const greeting = greetingView();
  const views: Record<IslandState, NotchView> = { hidden, compact, expanded: expanded ?? absentView(), greeting };
  island.el.append(hidden.el, compact.el, views.expanded.el, greeting.el);
  container.append(island.el);
  const root = document.documentElement;
  if (opts.mode === 'window') root.classList.add('nt-transparent');

  /** Pins for new items: the card opens for someone waiting on the human; the rest pin the pill. */
  function arrived(added: readonly WaitingItem[]): void {
    const loud = !inPage && added.some((i) => OPENS_CARD.has(i.kind));
    if (loud) fsm.itemArrived();
    else fsm.pinQuietly();
  }

  let shown: IslandState | null = null;
  let mascot: Component | null = null;

  function show(state: IslandState): void {
    if (shown === state) return;
    const hadFocus = island.el.contains(document.activeElement);
    for (const [name, view] of Object.entries(views) as [IslandState, NotchView][]) view.el.hidden = name !== state;
    shown = state;
    island.el.dataset.state = state;
    mascot?.destroy();
    mascot = null;
    const view = views[state];
    if (view.mascotHolder) {
      try {
        mascot = slots.mascot(ctx, { size: view.mascotSize });
        view.mascotHolder.replaceChildren(mascot.el);
      } catch {
        mascot = null;
      }
    }
    if (hadFocus) view.focusTarget()?.focus();
  }

  // ---- rendering -----------------------------------------------------------------------------
  let rendering = false;
  let again = false;

  function renderOnce(): void {
    const snap = fsm.snapshot;
    const m = buildModel(store.getState(), snap, ctx.now());
    model = m;
    if (currentKey && !m.items.some((i) => i.key === currentKey)) currentKey = null;
    if (!currentKey) currentKey = m.items[0]?.key ?? null;
    const index = Math.max(
      0,
      m.items.findIndex((i) => i.key === currentKey),
    );
    expanded?.setMaxHeight(WINDOW_MAX_HEIGHT);
    show(snap.state);
    views[snap.state].update(m, index);
    island.el.classList.toggle('nt-pinned', snap.pinned);
    island.el.classList.toggle('nt-folded', snap.folded);
    const content = snap.state === 'expanded' && expanded ? env.measure(expanded.el) + ISLAND_BORDER : 0;
    island.setTarget(stateGeometry(snap.state, content, WINDOW_MAX_HEIGHT));
    fetchStats(m.active?.task.task_id ?? null);
  }

  function render(): void {
    if (destroyed) return;
    if (rendering) {
      again = true;
      return;
    }
    rendering = true;
    try {
      let rounds = 0;
      do {
        again = false;
        renderOnce();
        rounds += 1;
      } while (again && rounds < 4);
    } finally {
      rendering = false;
    }
  }

  // ---- the pin, from the board ---------------------------------------------------------------
  let started = false;
  let known = new Set<string>();
  let expiryTimer: unknown = null;

  function derivePin(): void {
    if (destroyed) return;
    const board = store.select('board');
    const items = waitingItems(board, ctx.now());
    const keys = new Set(items.map((i) => i.key));
    if (!started) {
      if (!board) return;
      started = true;
      known = keys;
      if (items.length) arrived(items);
      else fsm.greet();
    } else {
      const added = items.filter((i) => !known.has(i.key));
      const removed = [...known].some((k) => !keys.has(k));
      known = keys;
      if (added.length) arrived(added);
      else if (removed) fsm.decided(items.length > 0);
      else fsm.setPinned(items.length > 0);
    }
    scheduleExpiry();
  }

  function scheduleExpiry(): void {
    if (expiryTimer !== null) env.timers.clear(expiryTimer);
    expiryTimer = null;
    const ms = nextExpiryIn(store.select('board'), ctx.now());
    if (ms === null) return;
    expiryTimer = env.timers.set(
      () => {
        expiryTimer = null;
        derivePin();
        render();
      },
      Math.min(EXPIRY_MAX_MS, ms + EXPIRY_SLACK_MS),
    );
  }

  // ---- the +N −M of the active task ----------------------------------------------------------
  const statsInFlight = new Set<string>();
  const statsAllowedAt = new Map<string, number>();
  let statsRetry: unknown = null;

  function fetchStats(taskId: string | null): void {
    if (!taskId || destroyed) return;
    const st = store.getState();
    const have = st.ui.stats[taskId];
    const staleAt = Math.max(st.ui.staleStats[taskId] ?? 0, st.activity.files[taskId]?.[0]?.at ?? 0);
    if (have && have.at >= staleAt) return;
    if (statsInFlight.has(taskId)) return;
    const now = ctx.now();
    const allowed = statsAllowedAt.get(taskId) ?? 0;
    if (now < allowed) {
      if (statsRetry === null)
        statsRetry = env.timers.set(() => {
          statsRetry = null;
          render();
        }, allowed - now);
      return;
    }
    statsInFlight.add(taskId);
    statsAllowedAt.set(taskId, now + STATS_INTERVAL_MS);
    ctx.api
      .taskDiff(taskId, true)
      .then(
        (diff) => {
          if (destroyed) return;
          let added = 0;
          let removed = 0;
          for (const f of diff?.files ?? []) {
            added += typeof f.added === 'number' ? f.added : 0;
            removed += typeof f.removed === 'number' ? f.removed : 0;
          }
          const ui = store.select('ui');
          store.patch('ui', { stats: { ...ui.stats, [taskId]: { added, removed, at: now } } });
        },
        () => {
          statsAllowedAt.set(taskId, ctx.now() + STATS_BACKOFF_MS);
        },
      )
      .finally(() => statsInFlight.delete(taskId));
  }

  // ---- subscriptions -------------------------------------------------------------------------
  let lastReaction = maxReaction(store.getState());
  const unsubs: (() => void)[] = [];

  unsubs.push(
    fsm.subscribe((s) => {
      const ui = store.select('ui');
      if (ui.notchPinned !== s.pinned || ui.notchFolded !== s.folded)
        store.patch('ui', { notchPinned: s.pinned, notchFolded: s.folded });
      render();
    }),
  );

  unsubs.push(
    store.subscribe('board', () => {
      derivePin();
      render();
    }),
  );

  unsubs.push(
    store.subscribe('activity', (next, prev) => {
      for (const r of [...next.reactions].sort((a, b) => a.id - b.id)) {
        if (r.id <= lastReaction) continue;
        lastReaction = r.id;
        // Opened in the same tick as the event; the card fills in when the snapshot lists the item.
        if (r.kind === 'approval' || r.kind === 'question') {
          if (inPage) fsm.pinQuietly();
          else fsm.itemArrived();
        } else if (r.kind === 'goal-completed') fsm.celebrate();
      }
      if (next.lastActivityAt !== prev.lastActivityAt) fsm.activity();
      if (next.files !== prev.files || next.agents !== prev.agents || next.reactions !== prev.reactions) render();
    }),
  );

  unsubs.push(
    store.subscribe('ui', (next, prev) => {
      if (next.stats !== prev.stats || next.staleStats !== prev.staleStats) render();
    }),
  );

  unsubs.push(
    store.subscribe('prefs', (next, prev) => {
      if (next.notchAutoCollapseS !== prev.notchAutoCollapseS || next.notchHideS !== prev.notchHideS)
        fsm.setTimings({ collapseS: next.notchAutoCollapseS, hideS: next.notchHideS });
      if (next.muted !== prev.muted || next.motion !== prev.motion) render();
    }),
  );

  unsubs.push(
    store.subscribe('system', (next, prev) => {
      if (next.connection !== prev.connection) render();
    }),
  );

  // ---- pointer, focus and keys ---------------------------------------------------------------
  const onEnter = (): void => fsm.pointerEnter();
  const onLeave = (): void => fsm.pointerLeave();
  const onFocusIn = (): void => {
    if (!fsm.snapshot.focusInside) fsm.focusEnter();
  };
  const onFocusOut = (e: FocusEvent): void => {
    const to = e.relatedTarget;
    if (to instanceof Node && island.el.contains(to)) return;
    fsm.focusLeave();
  };
  island.el.addEventListener('pointerenter', onEnter);
  island.el.addEventListener('pointerleave', onLeave);
  island.el.addEventListener('focusin', onFocusIn);
  island.el.addEventListener('focusout', onFocusOut);

  const onCardKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || !expanded) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handlers.later();
    } else if ((e.key === ' ' || e.code === 'Space') && !e.repeat && !isInteractive(e.target, expanded.el)) {
      e.preventDefault();
      handlers.openStudio();
    }
  };
  expanded?.el.addEventListener('keydown', onCardKey);

  const onResize = (): void => {
    island.reportRect(true);
    render();
  };
  window.addEventListener('resize', onResize);

  let observer: ResizeObserver | null = null;
  if (expanded && typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      if (fsm.state === 'expanded') render();
    });
    observer.observe(expanded.el);
  }

  // ---- start ---------------------------------------------------------------------------------
  derivePin();
  render();
  island.reportRect(true);

  return {
    el: island.el,
    open(focus = false) {
      fsm.open();
      if (!focus) return;
      // A page has no card to focus: the pill takes the keyboard instead.
      (expanded ? expanded.el : compact.focusTarget())?.focus();
    },
    state: () => fsm.snapshot,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const u of unsubs) u();
      fsm.destroy();
      if (expiryTimer !== null) env.timers.clear(expiryTimer);
      if (statsRetry !== null) env.timers.clear(statsRetry);
      island.el.removeEventListener('pointerenter', onEnter);
      island.el.removeEventListener('pointerleave', onLeave);
      island.el.removeEventListener('focusin', onFocusIn);
      island.el.removeEventListener('focusout', onFocusOut);
      expanded?.el.removeEventListener('keydown', onCardKey);
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      mascot?.destroy();
      mascot = null;
      for (const view of Object.values(views)) view.destroy();
      island.destroy();
      if (opts.mode === 'window') root.classList.remove('nt-transparent');
    },
  };
}
