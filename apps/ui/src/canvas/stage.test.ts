import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeGoal, makeRun, makeScenario, makeSnapshot, makeTask } from '../test/fixtures.js';
import { PULSE_LIFE_MS } from './edges.js';
import { activeStudio, mountStudio, registerCanvasCommands, type StudioHandle } from './stage.js';
import { screenToWorld } from './viewport.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const API = 'task_00000000000000000000api001';
const UI = 'task_00000000000000000000ui0001';
const LOOSE = 'task_0000000000000000000loose01';
const GOAL = 'goal_0000000000000000000000gg01';
const W = 1200;
const H = 800;

/** Gives every element a 1200×800 box at the origin, as a real window would. */
function withSize(): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: W,
    height: H,
    right: W,
    bottom: H,
    toJSON: () => ({}),
  } as DOMRect);
}

/** A 2D context that records nothing and accepts everything. */
function withCanvas(): string[] {
  const calls: string[] = [];
  const fake = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key in target) return target[key];
      return (..._args: unknown[]) => {
        calls.push(String(key));
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fake as never);
  return calls;
}

function setup(opts: { size?: boolean; snapshot?: ReturnType<typeof makeScenario> } = {}): {
  ctx: TestContext;
  host: HTMLElement;
  studio: StudioHandle;
} {
  if (opts.size !== false) withSize();
  const ctx = makeContext({ snapshot: opts.snapshot ?? makeScenario() });
  ctx.store.patch('prefs', { motion: 'reduce' }); // camera moves apply at once
  const host = document.createElement('div');
  document.body.append(host);
  const studio = mountStudio(ctx, host);
  return { ctx, host, studio };
}

const card = (host: Element, id: string) => host.querySelector(`.nd-card[data-id="${id}"]`) as HTMLElement | null;

function pointer(type: string, target: Element, init: Partial<PointerEventInit> = {}): void {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      clientX: 0,
      clientY: 0,
      ...init,
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  activeStudio()?.destroy();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('mountStudio', () => {
  it('renders a card per goal, task and agent, and the group labels', () => {
    const { host, studio } = setup();
    expect(card(host, GOAL)).not.toBeNull();
    for (const id of [API, UI, LOOSE, 'pod:claude-1', 'pod:codex-1']) expect(card(host, id)).not.toBeNull();
    expect(host.querySelectorAll('.nd-task')).toHaveLength(5);
    expect(host.querySelectorAll('.nd-pod')).toHaveLength(2);
    expect([...host.querySelectorAll('.cv-label')].map((l) => l.textContent)).toContain('Loose tasks');
    const r = studio.layout().rects.get(API);
    expect(card(host, API)?.style.transform).toBe(`translate(${r?.x}px, ${r?.y}px)`);
    expect(card(host, API)?.style.width).toBe('300px');
    expect(host.querySelector('.cv-empty')?.hasAttribute('hidden')).toBe(true);
    expect(host.querySelector('.cv-stage')?.getAttribute('aria-label')).toBe('Studio canvas');
  });

  it('renders hostile daemon strings as text', () => {
    const s = makeScenario();
    const t = s.tasks.find((x) => x.task_id === API);
    if (t) t.summary = HOSTILE;
    const g = s.goals[0];
    if (g) g.request = HOSTILE;
    const { host } = setup({ snapshot: s });
    expect(host.querySelector('img')).toBeNull();
    expect(card(host, API)?.textContent).toContain(HOSTILE);
    expect(card(host, GOAL)?.textContent).toContain(HOSTILE);
  });

  it('fits the board on the first snapshot and keeps the camera in the store', () => {
    const { ctx, studio } = setup();
    const cam = ctx.store.select('ui').camera;
    expect(cam).toEqual(studio.camera());
    expect(cam.zoom).toBeLessThanOrEqual(1);
    // Every card is inside the screen with the padding.
    const b = studio.layout().bounds;
    expect(b).not.toBeNull();
    const tl = { x: (b?.x ?? 0) * cam.zoom + cam.x, y: (b?.y ?? 0) * cam.zoom + cam.y };
    expect(tl.x).toBeGreaterThanOrEqual(79);
    expect(tl.y).toBeGreaterThanOrEqual(79);
  });

  it('keeps a saved camera instead of fitting', () => {
    withSize();
    const ctx = makeContext({ snapshot: makeScenario() });
    ctx.store.patch('ui', { camera: { x: 11, y: 22, zoom: 0.5 } });
    const host = document.createElement('div');
    const studio = mountStudio(ctx, host);
    expect(studio.camera()).toEqual({ x: 11, y: 22, zoom: 0.5 });
  });

  it('reuses card elements across snapshots and removes cards that left', () => {
    const { ctx, host } = setup();
    const before = card(host, API);
    const s = makeScenario();
    const t = s.tasks.find((x) => x.task_id === API);
    if (t) t.status = 'READY_FOR_VERIFICATION';
    s.tasks = s.tasks.filter((x) => x.task_id !== LOOSE);
    ctx.board(s);
    expect(card(host, API)).toBe(before);
    expect(card(host, API)?.dataset.status).toBe('READY_FOR_VERIFICATION');
    expect(card(host, LOOSE)).toBeNull();
    expect([...host.querySelectorAll('.cv-label')].map((l) => l.textContent)).not.toContain('Loose tasks');
  });

  it('hides finished goals when the preference says so', () => {
    const s = makeScenario();
    const g = s.goals[0];
    if (g) g.status = 'COMPLETED';
    const { ctx, host } = setup({ snapshot: s });
    expect(card(host, GOAL)).not.toBeNull();
    ctx.store.patch('prefs', { showFinished: false });
    expect(card(host, GOAL)).toBeNull();
    expect(card(host, API)).toBeNull();
  });

  it('says when the board is empty or not loaded yet', () => {
    const { ctx, host } = setup({ snapshot: makeSnapshot() });
    const empty = host.querySelector('.cv-empty') as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(empty.textContent).toContain('Nothing on the board yet');
    ctx.store.setState({ board: null });
    expect(empty.textContent).toContain("Waiting for Friday's board");
    ctx.board(makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED' })] }));
    ctx.store.patch('prefs', { showFinished: false });
    expect(empty.textContent).toContain('hidden');
    // The hint points at the toolbar's toggle, which is right there (review M9k).
    expect(empty.textContent).toContain('"Finished goals"');
    expect(empty.textContent).not.toContain('Settings');
  });
});

describe('view controls', () => {
  it('zooms with the toolbar, the palette commands and the keys', () => {
    const { ctx, host, studio } = setup();
    registerCanvasCommands(ctx);
    expect([...ctx.registry.commands.keys()]).toEqual(['fit', 'zoom-in', 'zoom-out', 'reset-layout']);
    const z0 = studio.camera().zoom;
    (host.querySelector('[data-action="zoom-in"]') as HTMLElement).click();
    expect(studio.camera().zoom).toBeCloseTo(z0 * 1.2);
    void ctx.registry.commands.get('zoom-out')?.run(ctx);
    expect(studio.camera().zoom).toBeCloseTo(z0);
    ctx.keys.handle(new KeyboardEvent('keydown', { key: '+', shiftKey: true }));
    expect(studio.camera().zoom).toBeCloseTo(z0 * 1.2);
    ctx.keys.handle(new KeyboardEvent('keydown', { key: '-' }));
    expect(studio.camera().zoom).toBeCloseTo(z0);
    ctx.keys.handle(new KeyboardEvent('keydown', { key: '=' }));
    expect(studio.camera().zoom).toBeCloseTo(z0 * 1.2);
    ctx.keys.handle(new KeyboardEvent('keydown', { key: 'f' }));
    expect(studio.camera().zoom).toBeCloseTo(z0);
    expect(ctx.store.select('ui').camera).toEqual(studio.camera());
    (host.querySelector('[data-action="zoom-reset"]') as HTMLElement).click();
    expect(studio.camera().zoom).toBe(1);
    studio.drawNow();
    expect(host.querySelector('.cv-zoom-pct')?.textContent).toBe('100%');
    expect((host.querySelector('.cv-world') as HTMLElement).style.transform).toContain('scale(1)');
  });

  it('never takes the keys while typing in a field', () => {
    const { ctx, studio } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    const z0 = studio.camera().zoom;
    const e = new KeyboardEvent('keydown', { key: '-', bubbles: true });
    Object.defineProperty(e, 'target', { value: input });
    expect(ctx.keys.handle(e)).toBe(false);
    expect(studio.camera().zoom).toBe(z0);
  });

  it('zooms with the wheel around the cursor', () => {
    const { host, studio } = setup();
    const stage = host.querySelector('.cv-stage') as HTMLElement;
    const before = studio.camera();
    const cursor = { x: 300, y: 200 };
    const world = screenToWorld(before, cursor);
    const wheel = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    // happy-dom's WheelEvent drops the mouse coordinates of its init.
    Object.defineProperty(wheel, 'clientX', { value: cursor.x });
    Object.defineProperty(wheel, 'clientY', { value: cursor.y });
    stage.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    const after = studio.camera();
    expect(after.zoom).toBeGreaterThan(before.zoom);
    const still = screenToWorld(after, cursor);
    expect(still.x).toBeCloseTo(world.x, 6);
    expect(still.y).toBeCloseTo(world.y, 6);
  });

  it('pans by dragging empty space and saves the camera when the drag ends', () => {
    const { ctx, host, studio } = setup();
    const stage = host.querySelector('.cv-stage') as HTMLElement;
    const c0 = studio.camera();
    pointer('pointerdown', stage, { clientX: 100, clientY: 100 });
    pointer('pointermove', stage, { clientX: 160, clientY: 70 });
    expect(studio.camera()).toMatchObject({ x: c0.x + 60, y: c0.y - 30 });
    expect(ctx.store.select('ui').camera).toEqual(c0);
    pointer('pointerup', stage, { clientX: 160, clientY: 70 });
    expect(ctx.store.select('ui').camera).toMatchObject({ x: c0.x + 60, y: c0.y - 30 });
  });

  it('pans with the arrow keys while the stage has focus', () => {
    const { host, studio } = setup();
    const stage = host.querySelector('.cv-stage') as HTMLElement;
    const c0 = studio.camera();
    stage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(studio.camera().x).toBe(c0.x + 60);
  });

  it('moves a card by its header and remembers the position', () => {
    const { ctx, host, studio } = setup();
    const head = card(host, API)?.querySelector('.nd-head') as HTMLElement;
    const r0 = studio.layout().rects.get(API);
    const zoom = studio.camera().zoom;
    pointer('pointerdown', head, { clientX: 10, clientY: 10 });
    pointer('pointermove', head, { clientX: 12, clientY: 11 }); // under the threshold
    expect(ctx.store.select('prefs').positions[API]).toBeUndefined();
    pointer('pointermove', head, { clientX: 110, clientY: 60 });
    pointer('pointerup', head, { clientX: 110, clientY: 60 });
    const p = ctx.store.select('prefs').positions[API];
    expect(p).toEqual({ x: Math.round((r0?.x ?? 0) + 100 / zoom), y: Math.round((r0?.y ?? 0) + 50 / zoom) });
    expect(studio.layout().rects.get(API)).toMatchObject(p ?? {});
    // The click that ends a drag does not select the card.
    card(host, API)?.click();
    expect(ctx.store.select('ui').selectedTaskId).toBeNull();
    registerCanvasCommands(ctx);
    void ctx.registry.commands.get('reset-layout')?.run(ctx);
    expect(studio.layout().rects.get(API)).toEqual(r0);
  });

  it('offers Tidy only after a card was dragged, and Tidy puts the cards back (review M9k)', async () => {
    const { ctx, host, studio } = setup();
    const tidy = host.querySelector('[data-action="tidy"]') as HTMLButtonElement;
    expect(tidy.hidden).toBe(true);
    const head = card(host, API)?.querySelector('.nd-head') as HTMLElement;
    const r0 = studio.layout().rects.get(API);
    pointer('pointerdown', head, { clientX: 10, clientY: 10 });
    pointer('pointermove', head, { clientX: 110, clientY: 60 });
    pointer('pointerup', head, { clientX: 110, clientY: 60 });
    expect(studio.layout().rects.get(API)).not.toEqual(r0);
    expect(tidy.hidden).toBe(false);
    expect(tidy.textContent).toContain('Tidy');
    // The click that ends the drag is swallowed; a later press is a real one.
    await new Promise((r) => setTimeout(r, 0));
    tidy.click();
    expect(ctx.store.select('prefs').positions).toEqual({});
    expect(studio.layout().rects.get(API)).toEqual(r0);
    expect(tidy.hidden).toBe(true);
  });

  it('toggles finished goals from the toolbar, in step with the Settings row (review M9k)', () => {
    const s = makeScenario();
    const g = s.goals[0];
    if (g) g.status = 'COMPLETED';
    const { ctx, host } = setup({ snapshot: s });
    const toggle = host.querySelector('[data-action="finished-goals"]') as HTMLButtonElement;
    expect(toggle.textContent).toContain('Finished goals');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(card(host, GOAL)).not.toBeNull();
    toggle.click();
    expect(ctx.store.select('prefs').showFinished).toBe(false);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.title).toContain('hidden');
    expect(card(host, GOAL)).toBeNull();
    // Settings writes the same preference: the toolbar follows.
    ctx.store.patch('prefs', { showFinished: true });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(card(host, GOAL)).not.toBeNull();
  });

  it('follows a camera another part of the interface set', () => {
    const { ctx, studio } = setup();
    ctx.store.patch('ui', { camera: { x: 5, y: 6, zoom: 9 } });
    expect(studio.camera()).toEqual({ x: 5, y: 6, zoom: 2 });
  });

  it('brings a task selected elsewhere into view, but not one clicked on the canvas', () => {
    const { ctx, host, studio } = setup();
    ctx.store.patch('ui', { camera: { x: -50_000, y: -50_000, zoom: 1 } });
    ctx.store.patch('ui', { selectedTaskId: LOOSE });
    const r = studio.layout().rects.get(LOOSE);
    const cam = studio.camera();
    const cx = ((r?.x ?? 0) + (r?.w ?? 0) / 2) * cam.zoom + cam.x;
    expect(cx).toBeCloseTo(W / 2);
    ctx.store.patch('ui', { camera: { x: -50_000, y: -50_000, zoom: 1 } });
    card(host, API)
      ?.querySelector('.nd-summary')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(ctx.store.select('ui').selectedTaskId).toBe(API);
    expect(studio.camera().x).toBe(-50_000);
    // Clicking the selected card again, or a button on it, leaves no stale flag behind.
    card(host, API)
      ?.querySelector('.nd-summary')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    (card(host, API)?.querySelector('[data-action="inspect"]') as HTMLElement | null)?.click();
    ctx.store.patch('ui', { selectedTaskId: LOOSE });
    expect(studio.camera().x).not.toBe(-50_000);
  });
});

describe('the minimap', () => {
  it('shows only while some card lies outside the view (review M9k)', () => {
    withCanvas();
    const { ctx, host, studio } = setup();
    const minimap = host.querySelector('.cv-minimap') as HTMLElement;
    const stage = host.querySelector('.cv-stage') as HTMLElement;
    // Fitted: every card is on the screen, so there is nothing for a map to show.
    studio.drawNow();
    expect(minimap.hidden).toBe(true);
    expect(stage.classList.contains('cv-minimap-off')).toBe(true);
    // Panned away: a card crosses the edge, and the map appears.
    ctx.store.patch('ui', { camera: { x: -600, y: 0, zoom: 1 } });
    studio.drawNow();
    expect(minimap.hidden).toBe(false);
    expect(stage.classList.contains('cv-minimap-off')).toBe(false);
    // Fit everything brings every card back, and the map goes.
    ctx.keys.handle(new KeyboardEvent('keydown', { key: 'f' }));
    studio.drawNow();
    expect(minimap.hidden).toBe(true);
  });
});

describe('culling and line counts', () => {
  it('culls cards off screen and reads +N −M only for the tasks on screen', async () => {
    const { ctx, host, studio } = setup();
    // Fitted: every card is on screen; tasks with a run get their stat diff read.
    expect(host.querySelectorAll('.cv-off')).toHaveLength(0);
    expect(ctx.transport.to('GET', `/tasks/${API}/diff`)).toHaveLength(1);
    expect(ctx.transport.to('GET', `/tasks/${UI}/diff`)).toHaveLength(1);
    expect(ctx.transport.to('GET', `/tasks/${LOOSE}/diff`)).toHaveLength(0); // no run
    ctx.store.patch('ui', { camera: { x: -100_000, y: -100_000, zoom: 1 } });
    studio.drawNow();
    expect(card(host, API)?.classList.contains('cv-off')).toBe(true);
    ctx.store.patch('ui', { staleStats: { [API]: 1 } });
    await new Promise((r) => setTimeout(r, 1100));
    expect(ctx.transport.to('GET', `/tasks/${API}/diff`)).toHaveLength(1);
  });

  it('shows the line counts the daemon answers on the task and its pod', async () => {
    withSize();
    const ctx = makeContext({
      snapshot: makeScenario(),
      answers: { [`GET /tasks/${API}/diff`]: { files: [{ path: 'a.ts', added: 14, removed: 2 }] } },
    });
    ctx.store.patch('prefs', { motion: 'reduce' });
    const host = document.createElement('div');
    mountStudio(ctx, host);
    expect(card(host, API)?.querySelector('.nd-lines')?.textContent).toBe('—');
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.store.select('ui').stats[API]).toMatchObject({ added: 14, removed: 2 });
    expect(card(host, API)?.querySelector('.nd-lines')?.textContent).toBe('+14 −2');
    expect(card(host, API)?.textContent).toContain('1 file');
    expect(card(host, 'pod:claude-1')?.querySelector('.nd-lines')?.textContent).toBe('+14 −2');
  });
});

describe('draw loop', () => {
  it('draws once when idle, keeps drawing while pulses travel, then prunes them', () => {
    const calls = withCanvas();
    const { ctx, studio } = setup();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    studio.drawNow();
    expect(calls).toContain('fillRect'); // the grid
    expect(calls).toContain('bezierCurveTo'); // edges
    raf.mockClear();
    studio.drawNow();
    expect(raf).not.toHaveBeenCalled(); // idle: no next frame
    const now = ctx.now();
    ctx.store.setState({
      activity: {
        ...ctx.store.select('activity'),
        pulses: [{ id: 1, agentKey: 'claude-1', taskId: API, kind: 'write', born: now }],
      },
    });
    expect(raf).toHaveBeenCalled(); // a pulse arrived: a frame is asked for
    raf.mockClear();
    studio.drawNow();
    expect(raf).toHaveBeenCalledTimes(1); // still travelling
    expect(calls).toContain('arc');
    raf.mockClear();
    ctx.clock.now = now + PULSE_LIFE_MS + 10;
    studio.drawNow();
    expect(ctx.store.select('activity').pulses).toHaveLength(0);
  });

  it('draws nothing for a pulse whose conduit is not on the board', () => {
    const calls = withCanvas();
    const { ctx, studio } = setup();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    ctx.store.setState({
      activity: {
        ...ctx.store.select('activity'),
        pulses: [{ id: 1, agentKey: 'nobody', taskId: API, kind: 'read', born: ctx.now() }],
      },
    });
    raf.mockClear();
    calls.length = 0;
    studio.drawNow();
    expect(calls).not.toContain('arc');
    expect(raf).not.toHaveBeenCalled();
  });
});

describe('destroy', () => {
  it('removes the stage, its keys, its listeners and its timers', () => {
    vi.useFakeTimers();
    withSize();
    const snapshot = makeScenario();
    snapshot.tasks.push(makeTask({ task_id: 'task_run2', status: 'RUNNING', started_at: '2026-10-17T09:00:00.000Z' }));
    snapshot.runs.task_run2 = makeRun({ task_id: 'task_run2', run_id: 'run_2' });
    const ctx = makeContext({ snapshot });
    const host = document.createElement('div');
    const studio = mountStudio(ctx, host);
    expect(activeStudio()).toBe(studio);
    studio.destroy();
    expect(host.children).toHaveLength(0);
    expect(activeStudio()).toBeNull();
    expect(ctx.keys.handle(new KeyboardEvent('keydown', { key: 'f' }))).toBe(false);
    ctx.board(makeScenario()); // no listener left to re-render
    expect(host.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    studio.destroy(); // twice is harmless
  });
});
