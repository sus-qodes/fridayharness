/**
 * Mounts the Notch (plan §7.8): the state machine, the island and its views, wired to the store.
 *
 * - **Pin:** pending unexpired approvals, pending questions and agents waiting for a human pin the
 *   card open; a new one opens it (`itemArrived`), one leaving it (decided here or elsewhere)
 *   collapses it unless another waits. `ui.notchPinned` and `ui.notchFolded` mirror the machine.
 * - **Reactions** are consumed by id: `approval` and `question` open the card in the same tick as
 *   their event, before the snapshot re-read; `goal-completed` celebrates.
 * - **In the page** the island sits at the top centre of its container; **in the notch window** it
 *   fills the window, makes the page transparent and reports its rectangle through `onRect`.
 */
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import type { RootState } from '../store/state.js';
import { buildModel, type NotchModel, nextExpiryIn, routingLabel, studioTarget, waitingItems } from './derive.js';
import {
  type AnimationEnv,
  ISLAND_BORDER,
  Island,
  PAGE_MAX_HEIGHT,
  stateGeometry,
  WINDOW_MAX_HEIGHT,
} from './island.js';
import { IslandFsm, type IslandSnapshot, type IslandState, realTimers, type TimerApi } from './island-fsm.js';
import {
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

export interface NotchOptions {
  mode: 'in-page' | 'window';
  onRect?: (r: { x: number; y: number; width: number; height: number }) => void;
  onOpenStudio?: (target: { task_id?: string; approval_id?: string }) => void;
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
/** The height the dock keeps at the bottom of the Studio, below an in-page card. */
const DOCK_ROOM = 96;
const STATS_INTERVAL_MS = 1000;
const STATS_BACKOFF_MS = 30_000;
/** Re-derive the pin this long after the next approval expires. */
const EXPIRY_SLACK_MS = 50;
/** Never wait longer than this for an expiry (timers have a ceiling). */
const EXPIRY_MAX_MS = 10 * 60_000;

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
  const prefs0 = store.select('prefs');
  const fsm = new IslandFsm({
    initial: 'compact',
    timers: env.timers,
    timings: { collapseS: prefs0.notchAutoCollapseS, hideS: prefs0.notchHideS },
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
  let routing = 'Routing';

  const inPage = opts.mode === 'in-page';

  function goStudio(target: { task_id?: string; approval_id?: string }): void {
    if (opts.onOpenStudio) opts.onOpenStudio(target);
    else {
      if (target.task_id) store.patch('ui', { selectedTaskId: target.task_id });
      if (target.approval_id) openModal(ctx, { kind: 'approval', id: target.approval_id });
    }
  }

  const handlers: ViewHandlers = {
    open: () => fsm.open(),
    openDiff: (taskId, path) => {
      if (inPage || !opts.onOpenStudio) openDrawer(ctx, { kind: 'diff', id: taskId, path });
      else opts.onOpenStudio({ task_id: taskId });
    },
    openStudio: () => {
      const items = model?.items ?? [];
      const item = items.find((i) => i.key === currentKey) ?? items[0] ?? null;
      goStudio(studioTarget(item, model?.active?.task.task_id ?? null));
      fsm.studioOpened();
    },
    openStudioGeneral: () => {
      goStudio(studioTarget(null, model?.active?.task.task_id ?? null));
      fsm.studioOpened();
    },
    inspect: (taskId) => {
      if (inPage || !opts.onOpenStudio) {
        store.patch('ui', { selectedTaskId: taskId });
        openDrawer(ctx, { kind: 'inspector', id: taskId });
      } else opts.onOpenStudio({ task_id: taskId });
    },
    later: () => fsm.later(),
    settings: () => {
      // The notch window is too small for the settings drawer: the Studio shows it.
      if (inPage || !opts.onOpenStudio) openDrawer(ctx, { kind: 'settings' });
      else opts.onOpenStudio({});
    },
    toggleMute: () => store.patch('prefs', { muted: !store.select('prefs').muted }),
    routing: () => {
      if (inPage || !opts.onOpenStudio) openDrawer(ctx, { kind: 'agents', tab: 'routing' });
      else opts.onOpenStudio({});
    },
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
  const compact = compactView(handlers);
  const expanded: ExpandedView = expandedView(ctx, slots, handlers);
  const greeting = greetingView();
  const views: Record<IslandState, NotchView> = { hidden, compact, expanded, greeting };
  island.el.append(hidden.el, compact.el, expanded.el, greeting.el);
  container.append(island.el);
  const root = document.documentElement;
  if (opts.mode === 'window') root.classList.add('nt-transparent');

  const maxHeight = (): number => {
    if (opts.mode === 'window') return WINDOW_MAX_HEIGHT;
    // The layer itself takes no height; the Studio under it does, and the dock keeps its row.
    const room = (container.parentElement?.clientHeight ?? 0) - DOCK_ROOM;
    return room > 160 ? Math.min(PAGE_MAX_HEIGHT, room) : PAGE_MAX_HEIGHT;
  };

  /**
   * Something new waits. The window opens its card over the editor; in a page the Decisions tray
   * already shows it in full, so the pill pins with its count and opens on hover or click
   * (ERRATA F40).
   */
  function arrived(): void {
    if (inPage) fsm.pinQuietly();
    else fsm.itemArrived();
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
    const m = buildModel(store.getState(), snap, ctx.now(), routing);
    model = m;
    if (currentKey && !m.items.some((i) => i.key === currentKey)) currentKey = null;
    if (!currentKey) currentKey = m.items[0]?.key ?? null;
    const index = Math.max(
      0,
      m.items.findIndex((i) => i.key === currentKey),
    );
    expanded.setMaxHeight(maxHeight());
    show(snap.state);
    views[snap.state].update(m, index);
    island.el.classList.toggle('nt-pinned', snap.pinned);
    island.el.classList.toggle('nt-folded', snap.folded);
    const content = snap.state === 'expanded' ? env.measure(expanded.el) + ISLAND_BORDER : 0;
    island.setTarget(stateGeometry(snap.state, content, maxHeight()));
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
      if (items.length) arrived();
      else fsm.greet();
    } else {
      const added = [...keys].some((k) => !known.has(k));
      const removed = [...known].some((k) => !keys.has(k));
      known = keys;
      if (added) arrived();
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

  // ---- the routing badge ---------------------------------------------------------------------
  function readRouting(): void {
    ctx.api.models().then(
      (r) => {
        if (destroyed) return;
        const label = routingLabel(r?.settings);
        if (label !== routing) {
          routing = label;
          render();
        }
      },
      () => undefined,
    );
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
        if (r.kind === 'approval' || r.kind === 'question') arrived();
        else if (r.kind === 'goal-completed') fsm.celebrate();
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
      if (next.connection === prev.connection) return;
      if (next.connection === 'live' && prev.connection !== 'live') readRouting();
      render();
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
    if (e.defaultPrevented) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      handlers.later();
    } else if ((e.key === ' ' || e.code === 'Space') && !e.repeat && !isInteractive(e.target, expanded.el)) {
      e.preventDefault();
      handlers.openStudio();
    }
  };
  expanded.el.addEventListener('keydown', onCardKey);

  const onResize = (): void => {
    island.reportRect(true);
    render();
  };
  window.addEventListener('resize', onResize);

  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      if (fsm.state === 'expanded') render();
    });
    observer.observe(expanded.el);
  }

  // ---- start ---------------------------------------------------------------------------------
  derivePin();
  render();
  island.reportRect(true);
  if (store.select('system').connection === 'live') readRouting();

  return {
    el: island.el,
    open(focus = false) {
      fsm.open();
      if (focus) expanded.el.focus();
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
      expanded.el.removeEventListener('keydown', onCardKey);
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
