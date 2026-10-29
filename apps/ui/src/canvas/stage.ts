/**
 * The Studio canvas (handoff Part 03, plan §7.3). Three layers:
 *
 * 1. a bottom `<canvas>`: the dot grid, dependency splines and agent conduits with their pulses;
 * 2. a middle DOM layer of node cards, placed with `transform: translate` inside one world layer
 *    that carries the camera; cards off screen are culled (`content-visibility: hidden`);
 * 3. a top overlay: the zoom toolbar (Fit, −, 100 %, +, a *Finished goals* toggle and, once a card
 *    was dragged, *Tidy*) and the minimap, shown only while some card lies outside the view.
 *
 * Wheel and pinch zoom around the cursor, dragging empty space or the middle button pans, `F`, `+`
 * and `−` fit and zoom (not while typing). The draw loop runs only while the view moves, a fit
 * animates or pulses travel; idle costs nothing. The camera is kept in `store.ui.camera`. Cards are
 * diffed by id and re-rendered only when what they show changed.
 */
import type { SnapshotTask } from '@friday/protocol';
import {
  type Board,
  deriveBoard,
  emptyBoard,
  type GoalGroup,
  layoutInputOf,
  type PodModel,
  planBarId,
  TERMINAL_STATUSES,
} from '../model/board.js';
import { boundsOf, layout as computeLayout, type Layout, type Rect } from '../model/layout.js';
import { createAgentPod, type PodCardModel, ToolDurations } from '../nodes/agent-pod.js';
import { fromControl, type NodeView, nodeIcon, place } from '../nodes/common.js';
import { createGoalNode } from '../nodes/goal-node.js';
import { createPlanGhost, createPlanReviewBar } from '../nodes/plan-ghost.js';
import { createTaskNode, type TaskCardModel } from '../nodes/task-node.js';
import type { AppContext, Component } from '../shell/context.js';
import { button, h, setText, toggleClass } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { conduitCurves, drawEdges, drawPulses, type Palette, PULSE_LIFE_MS, readPalette } from './edges.js';
import { drawGrid } from './grid.js';
import { Minimap, type MinimapNode } from './minimap.js';
import { StatRefresher } from './stats.js';
import {
  anyOutside,
  type Camera,
  CameraTween,
  centreOn,
  FIT_DURATION_MS,
  FIT_MAX_ZOOM,
  FIT_PADDING,
  fitBounds,
  fullyVisible,
  inflate,
  intersects,
  type Point,
  pan,
  type Size,
  sameCamera,
  sanitizeCamera,
  visibleWorld,
  wheelFactor,
  ZOOM_STEP,
  zoomAt,
  zoomBy,
} from './viewport.js';

type Kind = 'goal' | 'task' | 'ghost' | 'planbar' | 'pod';

interface Entry {
  kind: Kind;
  view: NodeView<unknown>;
  rect: Rect | null;
  culled: boolean;
  status?: string;
}

/** The mounted Studio; the palette commands and the dock drive it through these. */
export interface StudioHandle extends Component {
  fit(animate?: boolean): void;
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  /** Brings a card into view (animated) when it is not wholly visible. */
  focusNode(id: string): void;
  camera(): Camera;
  layout(): Layout;
  board(): Board;
  /** Draws one frame now (tests; the page uses requestAnimationFrame). */
  drawNow(): void;
}

/** How far outside the screen a card still counts as visible (screen pixels). */
/** What "fit everything" leaves free: the Notch hangs from the top edge, the dock sits on the bottom. */
const OVERLAY_INSETS = { top: 56, bottom: 72 };
const CULL_MARGIN = 160;
const SAVE_DEBOUNCE_MS = 200;
const PRUNE_EVERY_MS = 250;
const TICK_MS = 15_000;
const STEP_DURATION_MS = 180;
const KEY_PAN_PX = 60;
const DRAG_THRESHOLD_PX = 4;

let current: StudioHandle | null = null;

/** The Studio currently mounted, if any. */
export function activeStudio(): StudioHandle | null {
  return current;
}

function isDefaultCamera(c: Camera): boolean {
  return c.x === 0 && c.y === 0 && c.zoom === 1;
}

/** Pointer capture, tolerated where the platform refuses it (an unknown pointer, a test DOM). */
export function capture(el: Element, pointerId: number, on: boolean): void {
  try {
    if (on) el.setPointerCapture?.(pointerId);
    else el.releasePointerCapture?.(pointerId);
  } catch {
    // capture is a convenience: moves outside the stage are simply not seen
  }
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function lineStats(s: { added: number; removed: number } | undefined): { added: number; removed: number } | null {
  return s ? { added: s.added, removed: s.removed } : null;
}

/** True once a card was dragged by hand: the toolbar's *Tidy* and the palette's reset apply. */
export function hasMovedCards(ctx: Pick<AppContext, 'store'>): boolean {
  return Object.keys(ctx.store.select('prefs').positions).length > 0;
}

/** Puts every moved card back where Friday lays it out (the toolbar's *Tidy*, the palette's reset). */
export function resetMovedCards(ctx: Pick<AppContext, 'store'>): void {
  ctx.store.patch('prefs', { positions: {} });
}

export function mountStudio(ctx: AppContext, container: HTMLElement): StudioHandle {
  const store = ctx.store;
  const palette: Palette = readPalette();
  const entries = new Map<string, Entry>();
  const labelEls = new Map<string, HTMLElement>();
  const durations = new ToolDurations();
  const stats = new StatRefresher({ store, api: ctx.api, now: () => ctx.now() });
  const unsubs: (() => void)[] = [];

  let board: Board = emptyBoard();
  let lay: Layout = { rects: new Map(), labels: [], bounds: null, layers: new Map() };
  /** The rectangles drawn now: the layout's, with a card being dragged moved. */
  let rects = new Map<string, Rect>();
  let groupById = new Map<string, GoalGroup>();
  let podTask = new Map<string, string | null>();
  let podAgent = new Map<string, string>();
  let cam: Camera = sanitizeCamera(store.select('ui').camera);
  let savedCamera: unknown = store.select('ui').camera;
  let fitted = !isDefaultCamera(cam);
  let size: Size = { width: 0, height: 0 };
  let tween: CameraTween | null = null;
  let raf: number | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let clickTimer: ReturnType<typeof setTimeout> | null = null;
  let tick: ReturnType<typeof setInterval> | null = null;
  let lastPrune = 0;
  let visibleKey = '';
  let selectingHere = false;
  let pointerFocus = false;
  let suppressClick = false;
  let destroyed = false;

  // ---- DOM ------------------------------------------------------------------------------------
  const grid = h('canvas', { class: 'cv-grid', aria: { hidden: 'true' } });
  const world = h('div', { class: 'cv-world' });
  const empty = h('div', { class: 'cv-empty', role: 'status', hidden: true });
  const pct = button('100%', () => resetZoom(), {
    class: 'btn btn-ghost cv-zoom-pct',
    ariaLabel: 'Zoom level; press to reset to 100 percent',
    title: 'Reset the zoom to 100 %',
    dataset: { action: 'zoom-reset' },
  });
  // The board filter and the layout reset live beside the zoom, where the board is (review M9k);
  // the Settings row for finished goals stays, and both read the same preference.
  // The two toggles' words are spans: a narrow Studio keeps the icons and the names for assistive
  // technology, so the toolbar does not cover the cards above the minimap (canvas.css).
  const finishedToggle = button(
    [icon('check'), h('span', { class: 'cv-btn-label' }, 'Finished goals')],
    () => toggleFinished(),
    {
      class: 'btn btn-ghost cv-finished',
      ariaLabel: 'Finished goals',
      aria: { pressed: false },
      dataset: { action: 'finished-goals' },
    },
  );
  const tidy = button([nodeIcon('layers'), h('span', { class: 'cv-btn-label' }, 'Tidy')], () => resetMovedCards(ctx), {
    class: 'btn btn-ghost cv-tidy',
    ariaLabel: 'Tidy',
    title: 'Put the cards you moved back where Friday lays them out',
    dataset: { action: 'tidy' },
    hidden: true,
  });
  const toolbar = h(
    'div',
    { class: ['cv-toolbar', 'glass-panel'], role: 'toolbar', aria: { label: 'View' } },
    button(icon('fit'), () => fit(true), {
      class: 'btn btn-ghost btn-icon',
      ariaLabel: 'Fit everything (F)',
      title: 'Fit everything (F)',
      dataset: { action: 'fit' },
    }),
    button(icon('zoomOut'), () => zoomOut(), {
      class: 'btn btn-ghost btn-icon',
      ariaLabel: 'Zoom out (−)',
      title: 'Zoom out (−)',
      dataset: { action: 'zoom-out' },
    }),
    pct,
    button(icon('zoomIn'), () => zoomIn(), {
      class: 'btn btn-ghost btn-icon',
      ariaLabel: 'Zoom in (+)',
      title: 'Zoom in (+)',
      dataset: { action: 'zoom-in' },
    }),
    finishedToggle,
    tidy,
  );
  const minimap = new Minimap({
    onMove: (w) => {
      stopTween();
      measure();
      cam = centreOn(cam, w, size);
      invalidate();
      scheduleSave();
    },
    onNudge: (fx, fy) => {
      stopTween();
      measure();
      cam = pan(cam, -fx * size.width, -fy * size.height);
      invalidate();
      scheduleSave();
    },
    palette: () => palette,
  });
  // Hidden until a frame finds a card outside the view (review M9k): a board that fits needs no map.
  minimap.el.hidden = true;
  const overlay = h('div', { class: 'cv-overlay' }, toolbar, minimap.el);
  const root = h(
    'div',
    {
      class: 'cv-stage',
      role: 'region',
      tabIndex: 0,
      aria: { label: 'Studio canvas', roledescription: 'canvas' },
    },
    grid,
    world,
    empty,
    overlay,
  );
  toggleClass(root, 'cv-minimap-off', true);
  container.append(root);

  // ---- helpers --------------------------------------------------------------------------------
  function measure(): void {
    const r = root.getBoundingClientRect();
    size = { width: r.width || root.clientWidth || 0, height: r.height || root.clientHeight || 0 };
  }

  function reducedMotion(): boolean {
    const m = store.select('prefs').motion;
    if (m === 'reduce') return true;
    if (m === 'full') return false;
    try {
      return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  const requestFrame: (cb: () => void) => number =
    typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(() => cb())
      : (cb) => setTimeout(cb, 16) as unknown as number;
  const cancelFrame: (id: number) => void =
    typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);

  function invalidate(): void {
    if (raf === null && !destroyed) raf = requestFrame(frame);
  }

  function stopTween(): void {
    tween = null;
  }

  function saveCamera(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const prev = store.select('ui').camera;
    if (prev && sameCamera(prev, cam)) return;
    const next = { x: cam.x, y: cam.y, zoom: cam.zoom };
    savedCamera = next;
    store.patch('ui', { camera: next });
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCamera, SAVE_DEBOUNCE_MS);
  }

  function moveTo(target: Camera, animate: boolean, durationMs = FIT_DURATION_MS): void {
    measure();
    if (!animate || reducedMotion() || size.width <= 0 || size.height <= 0) {
      tween = null;
      cam = target;
      saveCamera();
      invalidate();
      return;
    }
    tween = new CameraTween(cam, target, ctx.now(), durationMs, size);
    invalidate();
  }

  function centre(): Point {
    return { x: size.width / 2, y: size.height / 2 };
  }

  // ---- view commands --------------------------------------------------------------------------
  function fit(animate = true): void {
    measure();
    moveTo(fitBounds(boundsOf(rects.values()), size, FIT_PADDING, FIT_MAX_ZOOM, OVERLAY_INSETS), animate);
  }

  function zoomIn(): void {
    measure();
    moveTo(zoomBy(tween?.to ?? cam, ZOOM_STEP, centre()), true, STEP_DURATION_MS);
  }

  function zoomOut(): void {
    measure();
    moveTo(zoomBy(tween?.to ?? cam, 1 / ZOOM_STEP, centre()), true, STEP_DURATION_MS);
  }

  function resetZoom(): void {
    measure();
    moveTo(zoomAt(cam, 1, centre()), true, STEP_DURATION_MS);
  }

  function focusNode(id: string): void {
    const r = rects.get(id);
    if (!r) return;
    measure();
    if (size.width <= 0 || fullyVisible(cam, r, size, 24)) return;
    moveTo(centreOn(cam, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, size), true);
  }

  function toggleFinished(): void {
    store.patch('prefs', { showFinished: !store.select('prefs').showFinished });
  }

  /** The toolbar's toggles follow the preferences, whoever changed them (this toolbar, Settings). */
  function syncToolbar(): void {
    const prefs = store.select('prefs');
    finishedToggle.setAttribute('aria-pressed', String(prefs.showFinished));
    finishedToggle.title = prefs.showFinished
      ? 'Finished goals are shown; press to hide them'
      : 'Finished goals are hidden; press to show them';
    tidy.hidden = !hasMovedCards(ctx);
  }

  // ---- card models ----------------------------------------------------------------------------
  function taskModel(t: SnapshotTask): TaskCardModel {
    const snap = board.snapshot;
    const ui = store.select('ui');
    const run = snap?.runs[t.task_id] ?? null;
    const group = groupById.get(board.groupOf.get(t.task_id) ?? '');
    return {
      task: t,
      run,
      harness: run ? (board.harnessById.get(run.harness_id) ?? null) : null,
      verification: snap?.verifications[t.task_id] ?? null,
      integration: snap?.integrations[t.task_id] ?? null,
      reservations: board.reservations.get(t.task_id) ?? [],
      stats: lineStats(ui.stats[t.task_id]),
      files: stats.filesOf(t.task_id) ?? (run ? run.observed_paths.length : null),
      recoveryQuestion: board.recoveryTasks.has(t.task_id),
      dropped: !!group?.dropped.includes(t.task_id),
      proposedVersion: group?.proposed?.version ?? null,
      selected: ui.selectedTaskId === t.task_id,
      now: ctx.now(),
    };
  }

  function podModel(p: PodModel): PodCardModel {
    const a = store.select('activity');
    const ui = store.select('ui');
    return {
      pod: p,
      activity: a.agents[p.agentKey] ?? null,
      stats: p.taskId ? lineStats(ui.stats[p.taskId]) : null,
      lastToolMs: durations.last(p.agentKey),
      recentFile: p.taskId ? (a.files[p.taskId]?.[0]?.path ?? null) : null,
      selected: false,
    };
  }

  // ---- reconcile ------------------------------------------------------------------------------
  function upsert(
    seen: Set<string>,
    id: string,
    kind: Kind,
    make: () => NodeView<unknown>,
    model: unknown,
    status?: string,
  ): void {
    seen.add(id);
    let e = entries.get(id);
    if (e && e.kind !== kind) {
      e.view.destroy();
      entries.delete(id);
      e = undefined;
    }
    if (!e) {
      const view = make();
      world.append(view.el);
      e = { kind, view, rect: null, culled: false };
      entries.set(id, e);
    } else e.view.update(model);
    e.status = status;
    const r = rects.get(id);
    if (r && (!e.rect || !sameRect(e.rect, r))) {
      const moved = !!e.rect;
      place(e.view.el, r);
      e.rect = r;
      if (moved) e.view.moved?.();
    }
  }

  function reconcile(): void {
    const seen = new Set<string>();
    for (const g of board.groups) {
      const gm = { group: g };
      upsert(seen, g.id, 'goal', () => createGoalNode(ctx, gm), gm, g.goal.status);
      if (g.proposed) {
        const pm = { goalId: g.id, plan: g.proposed };
        upsert(seen, planBarId(g.id), 'planbar', () => createPlanReviewBar(ctx, pm), pm);
      }
    }
    for (const t of board.tasks.values()) {
      const m = taskModel(t);
      upsert(seen, t.task_id, 'task', () => createTaskNode(ctx, m), m, t.status);
    }
    for (const ghost of board.ghosts.values()) {
      const m = { ghost };
      upsert(seen, ghost.id, 'ghost', () => createPlanGhost(ctx, m), m);
    }
    for (const p of board.pods) {
      const m = podModel(p);
      upsert(seen, p.id, 'pod', () => createAgentPod(ctx, m), m, p.agent.status);
    }
    for (const [id, e] of entries) {
      if (seen.has(id)) continue;
      e.view.destroy();
      entries.delete(id);
    }
    const labelsSeen = new Set<string>();
    for (const l of lay.labels) {
      labelsSeen.add(l.id);
      let el = labelEls.get(l.id);
      if (!el) {
        el = h('div', { class: 'cv-label', aria: { hidden: 'true' } });
        world.prepend(el);
        labelEls.set(l.id, el);
      }
      setText(el, l.text);
      const t = `translate(${l.x}px, ${l.y}px)`;
      if (el.style.transform !== t) el.style.transform = t;
    }
    for (const [id, el] of labelEls) {
      if (labelsSeen.has(id)) continue;
      el.remove();
      labelEls.delete(id);
    }
  }

  /** Re-renders the cards whose live values changed (activity, line counts, selection, time). */
  function updateLive(): void {
    for (const t of board.tasks.values()) entries.get(t.task_id)?.view.update(taskModel(t));
    for (const p of board.pods) entries.get(p.id)?.view.update(podModel(p));
  }

  function renderEmpty(): void {
    const snap = board.snapshot;
    let text: string | null = null;
    let hint: string | null = null;
    if (!snap) {
      text = "Waiting for Friday's board…";
    } else if (board.empty) {
      const hiddenFinished = !store.select('prefs').showFinished && snap.goals.length > 0;
      text = hiddenFinished ? 'Only finished goals, and they are hidden' : 'Nothing on the board yet';
      hint = hiddenFinished
        ? 'Turn on "Finished goals" in the toolbar at the bottom right to see them.'
        : 'Create a goal with New goal, or start an agent from Agents.';
    }
    empty.hidden = text === null;
    if (text !== null)
      empty.replaceChildren(h('p', { class: 'cv-empty-title' }, text), hint ? h('p', { class: 'muted' }, hint) : '');
  }

  function scheduleTick(): void {
    const open = [...board.tasks.values()].some(
      (t) => t.started_at && !t.completed_at && !TERMINAL_STATUSES.has(t.status),
    );
    if (open && !tick) tick = setInterval(updateLive, TICK_MS);
    else if (!open && tick) {
      clearInterval(tick);
      tick = null;
    }
  }

  function rebuild(): void {
    const prefs = store.select('prefs');
    board = deriveBoard(store.select('board'), { showFinished: prefs.showFinished });
    groupById = new Map(board.groups.map((g) => [g.id, g]));
    podTask = new Map(board.pods.map((p) => [p.id, p.taskId]));
    podAgent = new Map(board.pods.map((p) => [p.id, p.agentKey]));
    lay = computeLayout(layoutInputOf(board), prefs.positions);
    rects = new Map(lay.rects);
    reconcile();
    renderEmpty();
    scheduleTick();
    measure();
    if (!fitted && !board.empty && size.width > 0 && size.height > 0) {
      fitted = true;
      fit(false);
    }
    cull();
    invalidate();
  }

  // ---- culling and drawing --------------------------------------------------------------------
  function cull(): void {
    const noSize = size.width <= 0 || size.height <= 0;
    const view = inflate(visibleWorld(cam, size), CULL_MARGIN / cam.zoom);
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    const onScreen: string[] = [];
    for (const [id, e] of entries) {
      if (!e.rect) continue;
      const off = !noSize && !intersects(e.rect, view) && !(active && e.view.el.contains(active));
      if (off !== e.culled) {
        e.culled = off;
        toggleClass(e.view.el, 'cv-off', off);
      }
      if (off) continue;
      if (e.kind === 'task') onScreen.push(id);
      else if (e.kind === 'pod') {
        const t = podTask.get(id);
        if (t) onScreen.push(t);
      }
    }
    const key = onScreen.join(',');
    if (key !== visibleKey) {
      visibleKey = key;
      stats.setVisible(onScreen);
    }
  }

  function applyCamera(): void {
    const t = `translate(${cam.x}px, ${cam.y}px) scale(${cam.zoom})`;
    if (world.style.transform !== t) world.style.transform = t;
    setText(pct, `${Math.round(cam.zoom * 100)}%`);
    toggleClass(root, 'cv-far', cam.zoom < 0.45);
  }

  function context2d(): CanvasRenderingContext2D | null {
    try {
      return grid.getContext('2d');
    } catch {
      return null;
    }
  }

  /** Draws grid, edges and pulses; returns how many pulses are still travelling. */
  function draw(now: number): number {
    const curves = conduitCurves(board.edges, rects, (pid) => podAgent.get(pid) ?? null);
    const pulses = store.select('activity').pulses;
    const g = context2d();
    if (!g || size.width <= 0 || size.height <= 0) return 0;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = Math.round(size.width * dpr);
    const hh = Math.round(size.height * dpr);
    if (grid.width !== w) grid.width = w;
    if (grid.height !== hh) grid.height = hh;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size.width, size.height);
    drawGrid(g, cam, size, palette.grid);
    g.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
    drawEdges(g, board.edges, rects, palette, cam.zoom);
    return drawPulses(g, pulses, curves, palette, now, cam.zoom, reducedMotion());
  }

  /** Draws the minimap while some card lies outside the view, and hides it otherwise. */
  function drawMini(): void {
    const needed = anyOutside(rects.values(), cam, size);
    if (minimap.el.hidden !== !needed) {
      minimap.el.hidden = !needed;
      toggleClass(root, 'cv-minimap-off', !needed);
    }
    if (!needed) return;
    const nodes: MinimapNode[] = [];
    for (const e of entries.values()) if (e.rect) nodes.push({ kind: e.kind, status: e.status, rect: e.rect });
    minimap.draw(nodes, boundsOf(rects.values()), visibleWorld(cam, size));
  }

  function prune(now: number): void {
    if (now - lastPrune < PRUNE_EVERY_MS) return;
    const a = store.select('activity');
    if (!a.pulses.some((p) => now - p.born >= PULSE_LIFE_MS)) return;
    lastPrune = now;
    store.setState({ activity: { ...a, pulses: a.pulses.filter((p) => now - p.born < PULSE_LIFE_MS) } });
  }

  function frame(): void {
    raf = null;
    if (destroyed) return;
    const now = ctx.now();
    if (tween) {
      cam = tween.at(now);
      if (tween.done(now)) {
        cam = tween.to;
        tween = null;
        saveCamera();
      }
    }
    applyCamera();
    cull();
    const alive = draw(now);
    drawMini();
    prune(now);
    if (tween || alive > 0) invalidate();
  }

  // ---- input ----------------------------------------------------------------------------------
  const pointers = new Map<number, Point>();
  let mode: 'pan' | 'drag' | null = null;
  let drag: { id: string; start: Point; rect: Rect; moved: boolean; pointerId: number } | null = null;

  function local(e: { clientX: number; clientY: number }): Point {
    const r = root.getBoundingClientRect();
    const x = Number.isFinite(e.clientX) ? e.clientX - r.left : size.width / 2;
    const y = Number.isFinite(e.clientY) ? e.clientY - r.top : size.height / 2;
    return { x, y };
  }

  function onPointerDown(e: PointerEvent): void {
    pointerFocus = true;
    const target = e.target as Element | null;
    if (!target || overlay.contains(target)) return;
    const card = target.closest?.('.nd-card') as HTMLElement | null;
    if (e.button === 1 || (e.button === 0 && !card)) {
      if (e.button === 1) e.preventDefault();
      stopTween();
      pointers.set(e.pointerId, local(e));
      mode = 'pan';
      capture(root, e.pointerId, true);
      toggleClass(root, 'cv-panning', true);
      return;
    }
    if (e.button === 0 && card && target.closest('[data-drag-handle]') && !fromControl(e)) {
      const id = card.dataset.id;
      const r = id ? rects.get(id) : undefined;
      if (id && r) {
        drag = { id, start: local(e), rect: r, moved: false, pointerId: e.pointerId };
        mode = 'drag';
      }
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (mode === 'pan') {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const p = local(e);
      const other = [...pointers.entries()].find(([id]) => id !== e.pointerId)?.[1];
      if (other) {
        const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
        const d1 = Math.hypot(p.x - other.x, p.y - other.y);
        const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
        const m1 = { x: (p.x + other.x) / 2, y: (p.y + other.y) / 2 };
        if (d0 > 0 && d1 > 0) cam = zoomBy(cam, d1 / d0, m1);
        cam = pan(cam, m1.x - m0.x, m1.y - m0.y);
      } else cam = pan(cam, p.x - prev.x, p.y - prev.y);
      pointers.set(e.pointerId, p);
      invalidate();
    } else if (mode === 'drag' && drag && e.pointerId === drag.pointerId) {
      const p = local(e);
      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!drag.moved) capture(root, e.pointerId, true);
      drag.moved = true;
      const r = {
        ...drag.rect,
        x: Math.round(drag.rect.x + dx / cam.zoom),
        y: Math.round(drag.rect.y + dy / cam.zoom),
      };
      rects.set(drag.id, r);
      const en = entries.get(drag.id);
      if (en) {
        place(en.view.el, r);
        en.rect = r;
        toggleClass(en.view.el, 'cv-dragging', true);
      }
      invalidate();
    }
  }

  function onPointerUp(e: PointerEvent): void {
    pointerFocus = false;
    if (mode === 'pan') {
      pointers.delete(e.pointerId);
      capture(root, e.pointerId, false);
      if (!pointers.size) {
        mode = null;
        toggleClass(root, 'cv-panning', false);
        saveCamera();
      }
    } else if (mode === 'drag' && drag && e.pointerId === drag.pointerId) {
      const d = drag;
      drag = null;
      mode = null;
      capture(root, e.pointerId, false);
      const en = entries.get(d.id);
      if (en) toggleClass(en.view.el, 'cv-dragging', false);
      if (!d.moved) return;
      // The click that ends the drag must not act; a click arrives in a later task, if at all.
      suppressClick = true;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        suppressClick = false;
      }, 0);
      const r = rects.get(d.id);
      if (r) {
        const positions = { ...store.select('prefs').positions, [d.id]: { x: r.x, y: r.y } };
        store.patch('prefs', { positions });
      }
    }
  }

  function onWheel(e: WheelEvent): void {
    const target = e.target as Element | null;
    if (target?.closest?.('.nd-menu, textarea')) return;
    e.preventDefault();
    stopTween();
    const pinch = e.ctrlKey;
    if (!pinch && Math.abs(e.deltaX) > Math.abs(e.deltaY)) cam = pan(cam, -e.deltaX, 0);
    else if (!pinch && e.shiftKey) cam = pan(cam, 0, -e.deltaY);
    else cam = zoomBy(cam, wheelFactor(e.deltaY, e.deltaMode, pinch), local(e));
    invalidate();
    scheduleSave();
  }

  function onClickCapture(e: MouseEvent): void {
    if (suppressClick) {
      suppressClick = false;
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    // A click on a task card's body selects it (the card does that in this same dispatch); the
    // flag tells the selection listener not to move the camera, and is set only when the
    // selection will change, so the listener always clears it.
    const card = (e.target as Element | null)?.closest?.('.nd-task') as HTMLElement | null;
    if (!card || fromControl(e)) return;
    if (card.dataset.id && card.dataset.id !== store.select('ui').selectedTaskId) selectingHere = true;
  }

  function onFocusIn(e: FocusEvent): void {
    const card = (e.target as Element | null)?.closest?.('.nd-card') as HTMLElement | null;
    if (!card || pointerFocus) return;
    const id = card.dataset.id;
    if (id) focusNode(id);
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.target !== root) return;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [KEY_PAN_PX, 0],
      ArrowRight: [-KEY_PAN_PX, 0],
      ArrowUp: [0, KEY_PAN_PX],
      ArrowDown: [0, -KEY_PAN_PX],
    };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    stopTween();
    cam = pan(cam, d[0], d[1]);
    invalidate();
    scheduleSave();
  }

  root.addEventListener('pointerdown', onPointerDown);
  root.addEventListener('pointermove', onPointerMove);
  root.addEventListener('pointerup', onPointerUp);
  root.addEventListener('pointercancel', onPointerUp);
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('click', onClickCapture, true);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('keydown', onKeyDown);

  const popKeys = ctx.keys.push({
    name: 'canvas',
    bindings: [
      { key: 'f', run: () => fit(true), description: 'Fit everything' },
      { key: '+', shift: true, run: () => zoomIn(), description: 'Zoom in' },
      { key: '+', run: () => zoomIn() },
      { key: '=', run: () => zoomIn() },
      { key: '-', run: () => zoomOut(), description: 'Zoom out' },
    ],
  });

  let observer: ResizeObserver | null = null;
  const onResize = () => {
    measure();
    if (!fitted && !board.empty && size.width > 0 && size.height > 0) {
      fitted = true;
      fit(false);
    } else invalidate();
  };
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(onResize);
    observer.observe(root);
  } else if (typeof window !== 'undefined') window.addEventListener('resize', onResize);

  // ---- store ----------------------------------------------------------------------------------
  let prevUi = store.select('ui');
  let prevPrefs = store.select('prefs');
  unsubs.push(store.subscribe('board', () => rebuild()));
  unsubs.push(
    store.subscribe('prefs', (prefs) => {
      const prev = prevPrefs;
      prevPrefs = prefs;
      if (prefs.positions !== prev.positions || prefs.showFinished !== prev.showFinished) {
        syncToolbar();
        rebuild();
      }
    }),
  );
  unsubs.push(
    store.subscribe('activity', (a) => {
      durations.observe(a.agents);
      for (const p of board.pods) entries.get(p.id)?.view.update(podModel(p));
      if (a.pulses.length) invalidate();
    }),
  );
  unsubs.push(
    store.subscribe('ui', (ui) => {
      const prev = prevUi;
      prevUi = ui;
      if (ui.camera !== prev.camera && ui.camera !== savedCamera) {
        savedCamera = ui.camera;
        tween = null;
        cam = sanitizeCamera(ui.camera);
        fitted = true;
        invalidate();
      }
      if (ui.stats !== prev.stats || ui.staleStats !== prev.staleStats || ui.selectedTaskId !== prev.selectedTaskId) {
        updateLive();
        stats.check();
      }
      if (ui.selectedTaskId !== prev.selectedTaskId && ui.selectedTaskId && !selectingHere)
        focusNode(ui.selectedTaskId);
      selectingHere = false;
    }),
  );

  durations.observe(store.select('activity').agents);
  syncToolbar();
  rebuild();
  applyCamera();

  const handle: StudioHandle = {
    el: root,
    fit,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    camera: () => ({ ...cam }),
    layout: () => lay,
    board: () => board,
    drawNow: () => {
      if (raf !== null) {
        cancelFrame(raf);
        raf = null;
      }
      frame();
    },
    destroy() {
      if (destroyed) return;
      if (tween) {
        cam = tween.to;
        tween = null;
      }
      saveCamera();
      destroyed = true;
      if (raf !== null) cancelFrame(raf);
      raf = null;
      if (saveTimer) clearTimeout(saveTimer);
      if (clickTimer) clearTimeout(clickTimer);
      if (tick) clearInterval(tick);
      for (const off of unsubs) off();
      popKeys();
      observer?.disconnect();
      if (!observer && typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      stats.destroy();
      for (const e of entries.values()) e.view.destroy();
      entries.clear();
      minimap.destroy();
      root.remove();
      if (current === handle) current = null;
    },
  };
  current = handle;
  return handle;
}

/**
 * Palette commands of the canvas (plan §7.6): fit, zoom in, zoom out, and resetting moved cards
 * (the toolbar's *Tidy*, by its older name). Where the palette offers each is declared here, with
 * the command (review §4): zooming left the palette for the toolbar, the wheel and the keys, and
 * the reset shows only when typed.
 */
export function registerCanvasCommands(ctx: AppContext): void {
  ctx.registry.command({
    id: 'fit',
    label: 'Fit everything',
    keywords: ['view', 'canvas', 'zoom', 'all', 'overview'],
    available: () => current !== null,
    run: () => current?.fit(true),
  });
  ctx.registry.command({
    id: 'zoom-in',
    label: 'Zoom in',
    keywords: ['view', 'canvas', 'bigger', 'magnify'],
    available: () => current !== null,
    show: 'never',
    run: () => current?.zoomIn(),
  });
  ctx.registry.command({
    id: 'zoom-out',
    label: 'Zoom out',
    keywords: ['view', 'canvas', 'smaller'],
    available: () => current !== null,
    show: 'never',
    run: () => current?.zoomOut(),
  });
  ctx.registry.command({
    id: 'reset-layout',
    label: 'Reset moved cards',
    keywords: ['layout', 'positions', 'arrange', 'canvas', 'tidy'],
    available: (c) => hasMovedCards(c),
    show: 'typed',
    run: (c) => resetMovedCards(c),
  });
}
