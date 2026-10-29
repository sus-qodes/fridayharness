import type { ApprovalRow, EscalationView, SnapshotTask, UiSnapshot } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, Component } from '../shell/context.js';
import { makeContext, type TestContext } from '../test/context.js';
import {
  makeApproval,
  makeEscalation,
  makeGoal,
  makeInboxItem,
  makeRun,
  makeScenario,
  makeSnapshot,
  makeTask,
  T0,
} from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import { type AnimationEnv, Island, type IslandRect, islandRect, stateGeometry, WINDOW_MAX_HEIGHT } from './island.js';
import { realTimers } from './island-fsm.js';
import { mountNotchWith, type NotchEnv, type NotchHandle, type NotchOptions } from './island-host.js';
import type { NotchSlots } from './island-views.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const BIDI = '‮';
const ZW = '​';
const LONG = 'L'.repeat(5000);

// ---- fakes ------------------------------------------------------------------------------------

function fakeFrames() {
  const queue = new Map<number, (t: number) => void>();
  let id = 0;
  let t = 0;
  return {
    queue,
    raf: (cb: (t: number) => void): number => {
      id += 1;
      queue.set(id, cb);
      return id;
    },
    caf: (handle: number): void => {
      queue.delete(handle);
    },
    /** Runs frames at 60 fps until none is queued (or `max`). */
    flush(max = 2000): number {
      let n = 0;
      while (queue.size && n < max) {
        const [key, cb] = queue.entries().next().value as [number, (t: number) => void];
        queue.delete(key);
        t += 1000 / 60;
        cb(t);
        n += 1;
      }
      return n;
    },
  };
}

interface SlotCalls {
  approval: { a: ApprovalRow; compact: boolean }[];
  question: { e: EscalationView; compact: boolean; onLater: () => void }[];
  waiting: { t: SnapshotTask; compact: boolean }[];
  prompt: { onDone: () => void }[];
  mascot: number[];
  destroyed: string[];
}

function fakeSlots(opts: { throwOn?: 'approval' } = {}): { slots: NotchSlots; calls: SlotCalls } {
  const calls: SlotCalls = { approval: [], question: [], waiting: [], prompt: [], mascot: [], destroyed: [] };
  const comp = (name: string, text: string): Component => {
    const el = h('div', { class: `fake-${name}` }, text);
    if (name !== 'mascot' && name !== 'prompt') el.append(h('button', { type: 'button', class: 'fake-btn' }, 'act'));
    return { el, destroy: () => calls.destroyed.push(name) };
  };
  const slots: NotchSlots = {
    approval: (_c, a, o) => {
      if (opts.throwOn === 'approval') throw new Error('broken card');
      calls.approval.push({ a, ...o });
      return comp('approval', a.target ?? '');
    },
    question: (_c, e, o) => {
      calls.question.push({ e, ...o });
      return comp('question', e.question);
    },
    waiting: (_c, t, o) => {
      calls.waiting.push({ t, ...o });
      return comp('waiting', t.summary);
    },
    quickPrompt: (_c, o) => {
      calls.prompt.push(o);
      return comp('prompt', '');
    },
    mascot: (_c, o) => {
      calls.mascot.push(o.size);
      return comp('mascot', '');
    },
  };
  return { slots, calls };
}

let mounted: { handle: NotchHandle; container: HTMLElement }[] = [];

function mount(
  ctx: AppContext,
  opts: Partial<NotchOptions> = {},
  extra: { height?: number; slots?: ReturnType<typeof fakeSlots> } = {},
) {
  const frames = fakeFrames();
  const s = extra.slots ?? fakeSlots();
  const env: NotchEnv = {
    timers: realTimers,
    raf: frames.raf,
    caf: frames.caf,
    measure: () => extra.height ?? 200,
    systemReducedMotion: () => false,
  };
  const container = h('div', { class: 'host' });
  document.body.append(container);
  // The window's behaviour by default: a new item opens the card there (the page has no card, tested below).
  const handle = mountNotchWith(ctx, container, s.slots, { mode: 'window', ...opts }, env);
  mounted.push({ handle, container });
  const q = <T extends Element = HTMLElement>(sel: string): T => {
    const el = handle.el.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    return el as T;
  };
  return { handle, container, frames, calls: s.calls, q };
}

function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const m of mounted) {
    m.handle.destroy();
    m.container.remove();
  }
  mounted = [];
  vi.useRealTimers();
  document.documentElement.className = '';
  document.body.replaceChildren();
});

function board(ctx: TestContext, s: UiSnapshot): void {
  ctx.board(s);
}

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** A board with one running task that touched a file. */
function running(): UiSnapshot {
  return makeSnapshot({
    tasks: [makeTask({ task_id: 't1', status: 'RUNNING', plan_key: 'api', summary: 'Add the API' })],
    runs: { t1: makeRun({ task_id: 't1' }) },
  });
}

// ---- the island element -------------------------------------------------------------------------

describe('island geometry', () => {
  it('has the Part 01 size of each state; the card follows its content within bounds', () => {
    expect(stateGeometry('hidden', 0, 272)).toEqual({ width: 120, height: 4, radius: 2 });
    expect(stateGeometry('compact', 0, 272)).toEqual({ width: 200, height: 32, radius: 16 });
    expect(stateGeometry('greeting', 0, 272)).toEqual({ width: 320, height: 96, radius: 24 });
    expect(stateGeometry('expanded', 180.2, 272)).toEqual({ width: 400, height: 181, radius: 24 });
    expect(stateGeometry('expanded', 0, 272).height).toBe(120);
    expect(stateGeometry('expanded', 9999, 272).height).toBe(272);
    expect(stateGeometry('expanded', Number.NaN, Number.NaN).height).toBe(120);
  });

  it('rounds the reported rectangle outwards', () => {
    expect(islandRect({ width: 400, height: 240, radius: 24 }, 460)).toEqual({ x: 30, y: 0, width: 400, height: 240 });
    const r = islandRect({ width: 200.5, height: 31.2, radius: 16 }, 461);
    expect(r.x).toBe(130);
    expect(r.x + r.width).toBeGreaterThanOrEqual((461 + 200.5) / 2);
    expect(r.height).toBe(32);
  });
});

describe('the island element', () => {
  function env(frames: ReturnType<typeof fakeFrames>, reduced = false): AnimationEnv {
    return { raf: frames.raf, caf: frames.caf, reducedMotion: () => reduced, containerWidth: () => 460 };
  }

  it('animates with one frame loop while a spring moves, then stops; reports each new rectangle', () => {
    const frames = fakeFrames();
    const rects: IslandRect[] = [];
    const island = new Island({ mode: 'window', env: env(frames), onRect: (r) => rects.push(r) });
    expect(rects).toHaveLength(1);
    island.setTarget(stateGeometry('expanded', 240, WINDOW_MAX_HEIGHT));
    island.setTarget(stateGeometry('expanded', 240, WINDOW_MAX_HEIGHT));
    expect(frames.queue.size).toBe(1);
    expect(island.animating).toBe(true);
    const n = frames.flush();
    expect(n).toBeGreaterThan(10);
    expect(n).toBeLessThan(200);
    expect(island.animating).toBe(false);
    expect(island.geometry).toEqual({ width: 400, height: 240, radius: 24 });
    expect(island.el.style.getPropertyValue('--nt-w')).toBe('400px');
    expect(island.el.style.getPropertyValue('--nt-h')).toBe('240px');
    expect(island.el.style.getPropertyValue('--nt-r')).toBe('24px');
    expect(rects.at(-1)).toEqual({ x: 30, y: 0, width: 400, height: 240 });
    const count = rects.length;
    island.reportRect();
    expect(rects).toHaveLength(count);
    island.reportRect(true);
    expect(rects).toHaveLength(count + 1);
    // Nothing moves: no frame is requested.
    island.setTarget(stateGeometry('expanded', 240, WINDOW_MAX_HEIGHT));
    expect(frames.queue.size).toBe(0);
    island.destroy();
  });

  it('jumps without frames under reduced motion', () => {
    const frames = fakeFrames();
    const rects: IslandRect[] = [];
    const island = new Island({ mode: 'in-page', env: env(frames, true), onRect: (r) => rects.push(r) });
    island.setTarget(stateGeometry('greeting', 0, 272));
    expect(frames.queue.size).toBe(0);
    expect(island.geometry).toEqual({ width: 320, height: 96, radius: 24 });
    expect(rects.at(-1)).toEqual({ x: 70, y: 0, width: 320, height: 96 });
    island.destroy();
  });

  it('cancels its frame when destroyed', () => {
    const frames = fakeFrames();
    const island = new Island({ mode: 'in-page', env: env(frames) });
    document.body.append(island.el);
    island.setTarget(stateGeometry('hidden', 0, 272));
    expect(frames.queue.size).toBe(1);
    island.destroy();
    expect(frames.queue.size).toBe(0);
    expect(island.el.isConnected).toBe(false);
    island.setTarget(stateGeometry('compact', 0, 272));
    expect(frames.queue.size).toBe(0);
  });
});

// ---- the mounted Notch ----------------------------------------------------------------------------

describe('mounted Notch: greeting, idle and the strip', () => {
  it('greets with the project name, then shows the pill, then hides after 60 s', () => {
    const ctx = makeContext();
    const { handle, calls, q, frames } = mount(ctx);
    expect(handle.el.dataset.state).toBe('greeting');
    expect(q('.nt-greet-title').textContent).toBe('Welcome to Friday');
    expect(q('.nt-greet-sub').textContent).toBe('shop · 0 running');
    expect(calls.mascot).toEqual([56]);
    vi.advanceTimersByTime(2400);
    expect(handle.el.dataset.state).toBe('compact');
    expect(calls.mascot).toEqual([56, 24]);
    expect(calls.destroyed).toContain('mascot');
    expect(q('.nt-tag').textContent).toBe('shop');
    frames.flush();
    expect(handle.el.style.getPropertyValue('--nt-w')).toBe('200px');
    vi.advanceTimersByTime(60_000);
    expect(handle.el.dataset.state).toBe('hidden');
    expect(calls.mascot).toEqual([56, 24]);
    frames.flush();
    expect(handle.el.style.getPropertyValue('--nt-h')).toBe('4px');
  });

  it('waits for the first board before greeting', () => {
    const ctx = makeContext();
    ctx.store.setState({ board: null });
    const { handle } = mount(ctx);
    expect(handle.el.dataset.state).toBe('compact');
    board(ctx, makeSnapshot());
    expect(handle.el.dataset.state).toBe('greeting');
  });

  it('wakes from the strip on hover and opens on a second hover', () => {
    const ctx = makeContext();
    const { handle } = mount(ctx);
    vi.advanceTimersByTime(2400 + 60_000);
    expect(handle.el.dataset.state).toBe('hidden');
    handle.el.dispatchEvent(new Event('pointerenter'));
    expect(handle.el.dataset.state).toBe('compact');
    handle.el.dispatchEvent(new Event('pointerleave'));
    handle.el.dispatchEvent(new Event('pointerenter'));
    expect(handle.el.dataset.state).toBe('expanded');
    handle.el.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(600);
    expect(handle.el.dataset.state).toBe('compact');
  });

  it('shows itself when keyboard focus reaches the strip, and moves focus to the pill', () => {
    const ctx = makeContext();
    const { handle, q } = mount(ctx);
    vi.advanceTimersByTime(2400 + 60_000);
    q<HTMLButtonElement>('.nt-strip').focus();
    expect(handle.el.dataset.state).toBe('compact');
    expect(document.activeElement).toBe(q('.nt-compact-open'));
  });

  it('agents at work bring the pill back', () => {
    const ctx = makeContext();
    const { handle } = mount(ctx);
    vi.advanceTimersByTime(2400 + 60_000);
    ctx.store.patch('activity', { lastActivityAt: 99 });
    expect(handle.el.dataset.state).toBe('compact');
  });
});

describe('mounted Notch in a page: the pill alone (review §4, owner decision 1)', () => {
  it('pins the pill with its count on launch instead of opening a card', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { handle, calls, q } = mount(ctx, { mode: 'in-page' });
    expect(handle.el.dataset.state).toBe('compact');
    expect(handle.state()).toMatchObject({ pinned: true, folded: true });
    expect(q('.nt-chip').textContent).toBe('3 waiting');
    expect(calls.approval).toHaveLength(0);
    // The pin holds: it never hides while something waits.
    vi.advanceTimersByTime(3 * 3600_000);
    expect(handle.el.dataset.state).toBe('compact');
  });

  it('builds no card: no goal line, and hover, click and new items leave the pill as it is', () => {
    const ctx = makeContext();
    const { handle, calls, q } = mount(ctx, { mode: 'in-page' });
    expect(calls.prompt).toHaveLength(0);
    expect(handle.el.querySelector('.nt-expanded')).toBeNull();
    expect(handle.el.querySelector('.nt-view-absent')).not.toBeNull();
    vi.advanceTimersByTime(2400);
    ctx.store.patch('activity', { reactions: [{ id: 1, kind: 'approval', at: 0 }] });
    expect(handle.el.dataset.state).toBe('compact');
    board(ctx, makeSnapshot({ approvals: [makeApproval()] }));
    expect(handle.el.dataset.state).toBe('compact');
    expect(handle.state().pinned).toBe(true);
    handle.el.dispatchEvent(new Event('pointerenter'));
    expect(handle.el.dataset.state).toBe('compact');
    handle.el.dispatchEvent(new Event('pointerleave'));
    handle.open(true);
    expect(handle.el.dataset.state).toBe('compact');
    // The shortcut's focus lands on the pill, since there is no card to take it.
    expect(document.activeElement).toBe(q('.nt-chip'));
    expect(calls.prompt).toHaveLength(0);
    // Nothing of the pill is a chevron into a card.
    expect(handle.el.querySelector('.nt-chev')).toBeNull();
  });

  it('the tag opens the task’s inspector; without an active task it names the project and opens nothing', () => {
    const ctx = makeContext({ snapshot: running() });
    const { q } = mount(ctx, { mode: 'in-page' });
    vi.advanceTimersByTime(2400);
    const tag = q<HTMLButtonElement>('.nt-compact-open');
    expect(tag.getAttribute('aria-disabled')).toBe('false');
    expect(tag.tabIndex).toBe(0);
    expect(tag.getAttribute('aria-label')).toBe('Inspect api: Running');
    expect(q('.nt-tag').textContent).toBe('api');
    tag.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: 't1' });
    expect(ctx.store.select('ui').selectedTaskId).toBe('t1');
    ctx.store.patch('ui', { drawer: null });
    board(ctx, makeSnapshot());
    // Said with aria-disabled, never `disabled`: an idle board is not drawn as a fault.
    expect(tag.disabled).toBe(false);
    expect(tag.getAttribute('aria-disabled')).toBe('true');
    expect(tag.tabIndex).toBe(-1);
    expect(tag.classList.contains('nt-compact-idle')).toBe(true);
    expect(tag.getAttribute('aria-label')).toBe('Friday: shop');
    expect(q('.nt-tag').textContent).toBe('shop');
    tag.click();
    expect(ctx.store.select('ui').drawer).toBeNull();
  });

  it('the ticker opens the diff at the file', async () => {
    const ctx = makeContext({
      snapshot: running(),
      answers: { 'GET /tasks/t1/diff': { files: [{ path: 'a', added: 4, removed: 1 }] } },
    });
    ctx.store.patch('activity', { files: { t1: [{ path: 'backend/src/checkout.ts', at: 100 }] } });
    const { handle, q } = mount(ctx, { mode: 'in-page' });
    vi.advanceTimersByTime(2400);
    await flushPromises();
    expect(q('.nt-ticker').hidden).toBe(false);
    expect(q('.nt-ticker-file').textContent).toBe('checkout.ts');
    expect(q('.nt-add').textContent).toBe('+4');
    q<HTMLButtonElement>('.nt-ticker').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 't1', path: 'backend/src/checkout.ts' });
    expect(handle.el.dataset.state).toBe('compact');
  });

  it('the waiting chip hands the keyboard to the rail: the shell’s callback, or the list found in the page', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ approvals: [makeApproval()] }) });
    const onShowWaiting = vi.fn();
    const { q } = mount(ctx, { mode: 'in-page', onShowWaiting });
    const chip = q<HTMLButtonElement>('.nt-chip');
    expect(chip.hidden).toBe(false);
    expect(chip.textContent).toBe('1 waiting');
    expect(chip.getAttribute('aria-label')).toBe('1 waiting for you: show the list');
    chip.click();
    expect(onShowWaiting).toHaveBeenCalledTimes(1);
    // Without the callback: the Studio's list, its first row focused.
    const row = h('button', { type: 'button', class: 'gv-tray-row' }, 'Approval');
    const tray = h('section', { class: 'gv-tray', tabIndex: -1 }, row);
    document.body.append(tray);
    const second = mount(ctx, { mode: 'in-page' });
    second.q<HTMLButtonElement>('.nt-chip').click();
    expect(document.activeElement).toBe(row);
    row.remove();
    second.q<HTMLButtonElement>('.nt-chip').click();
    expect(document.activeElement).toBe(tray);
    expect(ctx.store.select('ui').drawer).toBeNull();
  });

  it('keeps the greeting and the goal celebration', () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ goals: [makeGoal({ status: 'COMPLETED', request: 'Ship it', completed_at: T0 })] }),
    });
    const { handle, q } = mount(ctx, { mode: 'in-page' });
    expect(handle.el.dataset.state).toBe('greeting');
    expect(q('.nt-greet-title').textContent).toBe('Welcome to Friday');
    vi.advanceTimersByTime(2400);
    expect(handle.el.dataset.state).toBe('compact');
    ctx.store.patch('activity', { reactions: [{ id: 1, kind: 'goal-completed', at: 0 }] });
    expect(handle.el.dataset.state).toBe('greeting');
    expect(q('.nt-greet-title').textContent).toBe('Goal completed');
    expect(q('.nt-greet-sub').textContent).toBe('Ship it');
    vi.advanceTimersByTime(2400);
    expect(handle.el.dataset.state).toBe('compact');
  });
});

describe('mounted Notch: waiting items and the pin', () => {
  it('opens and pins on launch when items wait; lists approvals, questions, waiting agents', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { handle, calls, q } = mount(ctx);
    expect(handle.el.dataset.state).toBe('expanded');
    expect(handle.state()).toMatchObject({ pinned: true, folded: false });
    expect(ctx.store.select('ui').notchPinned).toBe(true);
    expect(handle.el.classList.contains('nt-pinned')).toBe(true);
    expect(calls.approval).toHaveLength(1);
    expect(calls.approval[0]?.compact).toBe(true);
    expect(q('.nt-pager-label').textContent).toBe('Waiting for you · 1 of 3');
    expect(q<HTMLButtonElement>('.nt-pager-btn[aria-label="Previous waiting item"]').disabled).toBe(true);
    expect(calls.mascot.at(-1)).toBe(36);
    // The pin holds: no timer collapses or hides it.
    vi.advanceTimersByTime(3 * 3600_000);
    expect(handle.el.dataset.state).toBe('expanded');
  });

  it('pages through the items, building each card from its slot', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { calls, q } = mount(ctx);
    q<HTMLButtonElement>('[aria-label="Next waiting item"]').click();
    expect(calls.question).toHaveLength(1);
    expect(calls.question[0]?.compact).toBe(true);
    expect(calls.destroyed).toContain('approval');
    expect(q('.nt-pager-label').textContent).toBe('Waiting for you · 2 of 3');
    q<HTMLButtonElement>('[aria-label="Next waiting item"]').click();
    expect(calls.waiting).toHaveLength(1);
    expect(calls.waiting[0]?.t.task_id).toBe('task_00000000000000000000ui0001');
    expect(q<HTMLButtonElement>('[aria-label="Next waiting item"]').disabled).toBe(true);
  });

  it('"Later" from a question folds the card and keeps the pin; hover reopens it', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ escalations: [makeEscalation()] }) });
    const { handle, calls, q } = mount(ctx);
    calls.question[0]?.onLater();
    expect(handle.el.dataset.state).toBe('compact');
    expect(ctx.store.select('ui')).toMatchObject({ notchPinned: true, notchFolded: true });
    expect(q('.nt-chip').textContent).toBe('1 waiting');
    expect(q('.nt-chip').hidden).toBe(false);
    vi.advanceTimersByTime(3600_000);
    expect(handle.el.dataset.state).toBe('compact');
    handle.el.dispatchEvent(new Event('pointerenter'));
    expect(handle.el.dataset.state).toBe('expanded');
  });

  it('the chip on the folded pill opens the card at its items', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ escalations: [makeEscalation()] }) });
    const { handle, calls, q } = mount(ctx);
    calls.question[0]?.onLater();
    expect(handle.el.dataset.state).toBe('compact');
    q<HTMLButtonElement>('.nt-chip').click();
    expect(handle.el.dataset.state).toBe('expanded');
  });

  it('collapses when the last item is decided anywhere, and stays open while another waits', () => {
    const scenario = makeScenario();
    const ctx = makeContext({ snapshot: scenario });
    const { handle, calls } = mount(ctx);
    board(ctx, { ...scenario, approvals: [] });
    expect(handle.el.dataset.state).toBe('expanded');
    expect(calls.question).toHaveLength(1);
    board(ctx, { ...scenario, approvals: [], escalations: [], tasks: [] });
    expect(handle.el.dataset.state).toBe('compact');
    expect(ctx.store.select('ui')).toMatchObject({ notchPinned: false, notchFolded: false });
    vi.advanceTimersByTime(60_000);
    expect(handle.el.dataset.state).toBe('hidden');
  });

  it('opens at once on an approval reaction, before the snapshot lists it', () => {
    const ctx = makeContext();
    const { handle, q } = mount(ctx);
    vi.advanceTimersByTime(2400);
    ctx.store.patch('activity', { reactions: [{ id: 1, kind: 'approval', at: 0 }] });
    expect(handle.el.dataset.state).toBe('expanded');
    expect(q('.nt-arriving').hidden).toBe(false);
    expect(q('.nt-empty').hidden).toBe(true);
    // The re-read lists it.
    board(ctx, makeSnapshot({ approvals: [makeApproval()] }));
    expect(q('.nt-arriving').hidden).toBe(true);
    expect(q('.fake-approval')).toBeTruthy();
  });

  it('consumes reactions by id: old ones are not replayed, each new one acts once', () => {
    const ctx = makeContext();
    ctx.store.patch('activity', { reactions: [{ id: 5, kind: 'goal-completed', at: 0 }] });
    const { handle } = mount(ctx);
    vi.advanceTimersByTime(2400);
    expect(handle.el.dataset.state).toBe('compact');
    ctx.store.patch('activity', {
      reactions: [
        { id: 5, kind: 'goal-completed', at: 0 },
        { id: 6, kind: 'node', at: 1 },
      ],
    });
    expect(handle.el.dataset.state).toBe('compact');
    ctx.store.patch('activity', {
      reactions: [
        { id: 5, kind: 'goal-completed', at: 0 },
        { id: 6, kind: 'node', at: 1 },
        { id: 7, kind: 'goal-completed', at: 2 },
      ],
    });
    expect(handle.state().greeting).toBe('celebrate');
  });

  it('celebrates a completed goal with its request', () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        goals: [makeGoal({ status: 'COMPLETED', request: `Ship it ${HOSTILE}`, completed_at: T0 })],
      }),
    });
    const { handle, q } = mount(ctx);
    vi.advanceTimersByTime(2400);
    ctx.store.patch('activity', { reactions: [{ id: 1, kind: 'goal-completed', at: 0 }] });
    expect(handle.el.dataset.state).toBe('greeting');
    expect(q('.nt-greet-title').textContent).toBe('Goal completed');
    expect(q('.nt-greet-sub').textContent).toBe(`Ship it ${HOSTILE}`);
    expect(handle.el.querySelector('img')).toBeNull();
    vi.advanceTimersByTime(2400);
    expect(handle.el.dataset.state).toBe('compact');
  });

  it('drops the pin when the only approval expires', () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ approvals: [makeApproval({ expires_at: '2026-10-17T10:01:00.000Z' })] }),
    });
    const { handle } = mount(ctx);
    expect(handle.state().pinned).toBe(true);
    ctx.clock.now += 61_000;
    vi.advanceTimersByTime(61_000);
    expect(handle.state()).toMatchObject({ pinned: false, state: 'compact' });
  });

  it('the goal line is mounted once; creating a goal collapses the card when nothing waits', () => {
    const ctx = makeContext();
    const { handle, calls } = mount(ctx);
    handle.open();
    expect(handle.el.dataset.state).toBe('expanded');
    expect(calls.prompt).toHaveLength(1);
    calls.prompt[0]?.onDone();
    expect(handle.el.dataset.state).toBe('compact');
    expect(calls.prompt).toHaveLength(1);
  });

  it('shows a short message when a card cannot be built, and keeps working', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ approvals: [makeApproval()] }) });
    const { q, handle } = mount(ctx, {}, { slots: fakeSlots({ throwOn: 'approval' }) });
    expect(q('.nt-item-error').textContent).toContain('open it in the Studio');
    expect(handle.el.dataset.state).toBe('expanded');
  });
});

describe('mounted Notch: messages, memories to review and an untrusted policy (review §4, decision 6)', () => {
  it('a message that waits for a reply opens the card with its notice; the door opens Messages in the Studio', () => {
    const ctx = makeContext();
    const onOpenStudio = vi.fn();
    const { handle, q } = mount(ctx, { mode: 'window', onOpenStudio });
    vi.advanceTimersByTime(2400);
    board(
      ctx,
      makeSnapshot({
        inbox: [
          makeInboxItem({
            delivery_id: 'dlv_req',
            mode: 'request',
            subject: `Which plan names? ${HOSTILE}${BIDI}`,
            from: { kind: 'agent', id: 'agent_x', agent_key: `claude-1${BIDI}`, role: 'developer' },
          }),
        ],
      }),
    );
    expect(handle.el.dataset.state).toBe('expanded');
    expect(handle.state()).toMatchObject({ pinned: true, folded: false });
    const notice = q('.nt-notice-message');
    expect(notice.querySelector('.nt-notice-title')?.textContent).toBe('A message waits for your reply');
    expect(notice.querySelector('.nt-notice-line')?.textContent).toContain('claude-1⟨U+202E⟩');
    expect(notice.textContent).toContain('Which plan names?');
    expect(notice.textContent).not.toContain(BIDI);
    expect(handle.el.querySelector('img')).toBeNull();
    q<HTMLButtonElement>('.nt-notice-door').click();
    // With the delivery: the drawer opens on this message, as the rail's row opens it.
    expect(onOpenStudio).toHaveBeenLastCalledWith({ panel: 'inbox', id: 'dlv_req' });
    expect(handle.state()).toMatchObject({ state: 'compact', folded: true, pinned: true });
    expect(q('.nt-chip').textContent).toBe('1 waiting');
    // Replied: the pin drops.
    board(ctx, makeSnapshot());
    expect(handle.state().pinned).toBe(false);
  });

  it('memories to review and an untrusted policy pin the pill without opening the card', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ memories_to_review: 2, policy_untrusted: true }) });
    const onOpenStudio = vi.fn();
    const { handle, q } = mount(ctx, { mode: 'window', onOpenStudio });
    expect(handle.el.dataset.state).toBe('compact');
    expect(handle.state()).toMatchObject({ pinned: true, folded: true });
    expect(q('.nt-chip').textContent).toBe('2 waiting');
    vi.advanceTimersByTime(3 * 3600_000);
    expect(handle.el.dataset.state).toBe('compact');
    // Opened by hand, the card shows both notices with their doors.
    handle.open();
    expect(q('.nt-pager-label').textContent).toBe('Waiting for you · 1 of 2');
    expect(q('.nt-notice-memory .nt-notice-title').textContent).toBe('2 memories need review');
    q<HTMLButtonElement>('.nt-notice-memory .nt-notice-door').click();
    expect(onOpenStudio).toHaveBeenLastCalledWith({ panel: 'memory', tab: 'review' });
    handle.open();
    q<HTMLButtonElement>('[aria-label="Next waiting item"]').click();
    expect(q('.nt-notice-policy .nt-notice-title').textContent).toBe('Policy change not yet trusted');
    q<HTMLButtonElement>('.nt-studio').click();
    expect(onOpenStudio).toHaveBeenLastCalledWith({ panel: 'settings', tab: 'policy' });
    // A later arrival of the same quiet kinds keeps the card closed too.
    board(ctx, makeSnapshot({ memories_to_review: 3, policy_untrusted: true }));
    expect(handle.el.dataset.state).toBe('compact');
    board(ctx, makeSnapshot({ memories_to_review: 0, policy_untrusted: false }));
    expect(handle.state().pinned).toBe(false);
  });

  it('without a shell, a notice’s door opens the drawer in this page', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ memories_to_review: 1 }) });
    const { handle, q } = mount(ctx);
    handle.open();
    expect(q('.nt-notice-memory .nt-notice-title').textContent).toBe('1 memory needs review');
    q<HTMLButtonElement>('.nt-notice-door').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'memory', tab: 'review' });
  });
});

describe('mounted Notch: the compact pill', () => {
  it('shows the active task coloured by status and the live file with its line counts', async () => {
    const ctx = makeContext({
      snapshot: running(),
      answers: {
        'GET /tasks/t1/diff': {
          files: [
            { path: 'a', added: 4, removed: 1 },
            { path: 'b', added: 2, removed: null },
          ],
        },
      },
    });
    ctx.store.patch('activity', { files: { t1: [{ path: 'backend/src/checkout.ts', at: 100 }] } });
    const { handle, q } = mount(ctx);
    vi.advanceTimersByTime(2400);
    expect(handle.el.dataset.state).toBe('compact');
    const tag = q('.nt-tag');
    expect(tag.textContent).toBe('api');
    expect(tag.dataset.status).toBe('RUNNING');
    expect(tag.style.getPropertyValue('--nt-tag-color')).toBe('var(--status-running)');
    expect(q('.nt-ticker').hidden).toBe(false);
    expect(q('.nt-ticker-file').textContent).toBe('checkout.ts');
    expect(q('.nt-add').textContent).toBe('—');
    await flushPromises();
    expect(ctx.transport.to('GET', '/tasks/t1/diff')).toHaveLength(1);
    expect(ctx.transport.to('GET', '/tasks/t1/diff')[0]?.path).toContain('stat=1');
    expect(ctx.store.select('ui').stats.t1).toMatchObject({ added: 6, removed: 1 });
    expect(q('.nt-add').textContent).toBe('+6');
    expect(q('.nt-del').textContent).toBe('−1');
    q<HTMLButtonElement>('.nt-ticker').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 't1', path: 'backend/src/checkout.ts' });
    expect(handle.el.dataset.state).toBe('compact');
  });

  it('in the notch window the ticker asks the Studio for the diff at that file (deep review R7)', () => {
    const ctx = makeContext({ snapshot: running(), answers: { 'GET /tasks/t1/diff': { files: [] } } });
    ctx.store.patch('activity', { files: { t1: [{ path: 'backend/src/checkout.ts', at: 100 }] } });
    const onOpenStudio = vi.fn();
    const { q } = mount(ctx, { mode: 'window', onOpenStudio });
    vi.advanceTimersByTime(2400);
    q<HTMLButtonElement>('.nt-ticker').click();
    expect(onOpenStudio).toHaveBeenCalledWith({ task_id: 't1', panel: 'diff', path: 'backend/src/checkout.ts' });
    expect(ctx.store.select('ui').drawer).toBeNull();
  });

  it('reads the line counts again after a write, at most once a second', async () => {
    const ctx = makeContext({ snapshot: running(), answers: { 'GET /tasks/t1/diff': { files: [] } } });
    ctx.store.patch('activity', { files: { t1: [{ path: 'a.ts', at: ctx.clock.now }] } });
    mount(ctx);
    await flushPromises();
    expect(ctx.transport.to('GET', '/tasks/t1/diff')).toHaveLength(1);
    ctx.clock.now += 100;
    ctx.store.patch('activity', { files: { t1: [{ path: 'a.ts', at: ctx.clock.now }] } });
    await flushPromises();
    expect(ctx.transport.to('GET', '/tasks/t1/diff')).toHaveLength(1);
    ctx.clock.now += 1000;
    vi.advanceTimersByTime(1000);
    await flushPromises();
    expect(ctx.transport.to('GET', '/tasks/t1/diff')).toHaveLength(2);
    // Fresh now: no further read.
    ctx.clock.now += 5000;
    ctx.store.patch('ui', { staleStats: {} });
    await flushPromises();
    expect(ctx.transport.to('GET', '/tasks/t1/diff')).toHaveLength(2);
  });

  it('backs off for 30 s after a failed read', async () => {
    const ctx = makeContext({
      snapshot: running(),
      answers: {
        'GET /tasks/t1/diff': () => {
          throw new Error('no');
        },
      },
    });
    mount(ctx);
    await flushPromises();
    expect(ctx.transport.to('GET', '/tasks/t1/diff')).toHaveLength(1);
    ctx.clock.now += 5000;
    ctx.store.patch('ui', { staleStats: { t1: 1 } });
    await flushPromises();
    expect(ctx.transport.to('GET', '/tasks/t1/diff')).toHaveLength(1);
    expect(ctx.toasts).toEqual([]);
  });

  it('click on the pill opens the card', () => {
    const ctx = makeContext();
    const { handle, q } = mount(ctx);
    vi.advanceTimersByTime(2400);
    q<HTMLButtonElement>('.nt-compact-open').click();
    expect(handle.el.dataset.state).toBe('expanded');
  });
});

describe('mounted Notch: the expanded card', () => {
  it('shows the header, the active task banner with checks, and the footer; no routing badge', async () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    ctx.store.patch('system', { connection: 'live' });
    const { q, handle } = mount(ctx);
    await flushPromises();
    expect(q('.nt-project').textContent).toBe('shop');
    expect(q('.nt-conn').textContent).toBe('Connected');
    expect(q('.nt-dot').dataset.tone).toBe('good');
    expect(handle.el.querySelector('.nt-routing')).toBeNull();
    expect(ctx.transport.to('GET', '/models')).toHaveLength(0);
    expect(q('.nt-studio').getAttribute('aria-label')).toBe('Open this in Studio (Space)');
    expect(q('.nt-banner').hidden).toBe(false);
    expect(q('.nt-banner-status').textContent).toBe('Running');
    expect(q('.nt-banner-tag').textContent).toBe('api');
    expect(q('.nt-meta-checks').textContent).toBe('No checks run yet');
    expect(q('.nt-banner').classList.contains('nt-banner-slim')).toBe(true);
    expect(q('.nt-mute').getAttribute('aria-pressed')).toBe('false');
    ctx.store.patch('system', { connection: 'reconnecting' });
    expect(q('.nt-conn').textContent).toBe('Reconnecting…');
    expect(q('.nt-dot').dataset.tone).toBe('warn');
  });

  it('"Open this in Studio" in the page selects the task and opens the approval, then folds', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { handle, q } = mount(ctx);
    q<HTMLButtonElement>('.nt-studio').click();
    expect(ctx.store.select('ui').selectedTaskId).toBe('task_00000000000000000000api001');
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'approval', id: 'apr_000000000000000000000ap01' });
    expect(handle.state()).toMatchObject({ state: 'compact', folded: true, pinned: true });
  });

  it('"Open this in Studio" calls the shell when it is given one', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const onOpenStudio = vi.fn();
    const { q } = mount(ctx, { mode: 'window', onOpenStudio });
    q<HTMLButtonElement>('[aria-label="Next waiting item"]').click();
    q<HTMLButtonElement>('.nt-studio').click();
    expect(onOpenStudio).toHaveBeenCalledWith({ task_id: 'task_00000000000000000000api001' });
    expect(ctx.store.select('ui').modal).toBeNull();
  });

  it('Space on the card opens the Studio; Space on a button belongs to the button; Esc folds', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const onOpenStudio = vi.fn();
    const { handle, q } = mount(ctx, { onOpenStudio });
    const card = q('.nt-expanded');
    key(q('.fake-btn'), ' ');
    expect(onOpenStudio).not.toHaveBeenCalled();
    key(card, ' ', { repeat: true });
    expect(onOpenStudio).not.toHaveBeenCalled();
    const e = key(card, ' ');
    expect(e.defaultPrevented).toBe(true);
    expect(onOpenStudio).toHaveBeenCalledWith({
      task_id: 'task_00000000000000000000api001',
      approval_id: 'apr_000000000000000000000ap01',
    });
    handle.open(true);
    expect(document.activeElement).toBe(card);
    key(card, 'Escape');
    expect(handle.state()).toMatchObject({ state: 'compact', folded: true });
    expect(document.activeElement).toBe(q('.nt-compact-open'));
  });

  it('Esc already handled by a card inside is left alone', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { handle, q } = mount(ctx);
    const btn = q('.fake-btn');
    btn.addEventListener('keydown', (e) => e.preventDefault());
    key(btn, 'Escape');
    expect(handle.el.dataset.state).toBe('expanded');
  });

  it('the footer mutes, opens settings and the Studio', () => {
    const ctx = makeContext();
    const { handle, q } = mount(ctx);
    handle.open();
    const mute = q<HTMLButtonElement>('.nt-mute');
    mute.click();
    expect(ctx.store.select('prefs').muted).toBe(true);
    expect(mute.getAttribute('aria-pressed')).toBe('true');
    expect(mute.textContent).toBe('Muted');
    const [settings, , studio] = [...handle.el.querySelectorAll<HTMLButtonElement>('.nt-foot-btn')];
    expect(settings?.textContent).toBe('Settings');
    expect(studio?.textContent).toBe('Open Studio');
    settings?.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings' });
    handle.open();
    studio?.click();
    expect(handle.el.dataset.state).toBe('compact');
  });

  it('in the notch window Settings names its drawer for the Studio (deep review R7)', () => {
    const ctx = makeContext();
    const onOpenStudio = vi.fn();
    const { handle } = mount(ctx, { mode: 'window', onOpenStudio });
    handle.open();
    const [settings] = [...handle.el.querySelectorAll<HTMLButtonElement>('.nt-foot-btn')];
    settings?.click();
    expect(onOpenStudio).toHaveBeenLastCalledWith({ panel: 'settings' });
    expect(ctx.store.select('ui').drawer).toBeNull();
  });

  it('the banner opens the task inspector', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { q } = mount(ctx);
    q<HTMLButtonElement>('.nt-banner-summary').click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: 'task_00000000000000000000api001' });
    expect(ctx.store.select('ui').selectedTaskId).toBe('task_00000000000000000000api001');
  });

  it('says so when nothing needs the human', () => {
    const ctx = makeContext();
    const { handle, q } = mount(ctx);
    handle.open();
    expect(q('.nt-empty').hidden).toBe(false);
    expect(q('.nt-pager').hidden).toBe(true);
    expect(q('.nt-banner').hidden).toBe(true);
  });

  it('keeps the card while the pointer is on it and collapses 15 s after it leaves', () => {
    const ctx = makeContext();
    const { handle } = mount(ctx);
    handle.el.dispatchEvent(new Event('pointerenter'));
    handle.open();
    vi.advanceTimersByTime(3600_000);
    expect(handle.el.dataset.state).toBe('expanded');
    handle.el.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(15_000);
    expect(handle.el.dataset.state).toBe('compact');
  });

  it('follows the notch timings in the preferences', () => {
    const ctx = makeContext();
    const { handle } = mount(ctx);
    ctx.store.patch('prefs', { notchAutoCollapseS: 3, notchHideS: 5 });
    handle.open();
    vi.advanceTimersByTime(3000);
    expect(handle.el.dataset.state).toBe('compact');
    vi.advanceTimersByTime(5000);
    expect(handle.el.dataset.state).toBe('hidden');
  });
});

describe('mounted Notch: geometry, window mode and reduced motion', () => {
  it('animates the card to its content height and reports the rectangle in window mode', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const rects: IslandRect[] = [];
    const { handle, frames } = mount(ctx, { mode: 'window', onRect: (r) => rects.push(r) }, { height: 230 });
    expect(document.documentElement.classList.contains('nt-transparent')).toBe(true);
    expect(handle.el.classList.contains('nt-island-window')).toBe(true);
    const before = rects.length;
    frames.flush();
    expect(rects.length).toBeGreaterThan(before);
    const last = rects.at(-1);
    expect(last?.width).toBe(400);
    expect(last?.height).toBe(231);
    expect(last?.y).toBe(0);
    // A change of state changes the rectangle.
    handle.state();
    (handle.el.querySelector('.nt-studio') as HTMLButtonElement).click();
    frames.flush();
    expect(rects.at(-1)).toMatchObject({ width: 200, height: 32 });
    handle.destroy();
    expect(document.documentElement.classList.contains('nt-transparent')).toBe(false);
  });

  it('never grows past the window in window mode', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { frames, handle } = mount(ctx, { mode: 'window' }, { height: 900 });
    frames.flush();
    expect(handle.el.style.getPropertyValue('--nt-h')).toBe(`${WINDOW_MAX_HEIGHT}px`);
    expect((handle.el.querySelector('.nt-expanded') as HTMLElement).style.getPropertyValue('--nt-max-h')).toBe(
      `${WINDOW_MAX_HEIGHT}px`,
    );
  });

  it('jumps without animation frames when motion is reduced', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    ctx.store.patch('prefs', { motion: 'reduce' });
    const { frames, handle } = mount(ctx, {}, { height: 210 });
    expect(frames.queue.size).toBe(0);
    expect(handle.el.style.getPropertyValue('--nt-h')).toBe('211px');
    expect(handle.el.style.getPropertyValue('--nt-w')).toBe('400px');
  });

  it('runs no frame loop while idle', () => {
    const ctx = makeContext();
    const { frames } = mount(ctx);
    frames.flush();
    vi.advanceTimersByTime(2400);
    frames.flush();
    expect(frames.queue.size).toBe(0);
    ctx.store.patch('activity', { pulses: [{ id: 1, agentKey: 'a', taskId: 't', kind: 'read', born: 0 }] });
    expect(frames.queue.size).toBe(0);
  });
});

describe('mounted Notch: cleanup', () => {
  it('destroy undoes subscriptions, timers, frames, listeners and the element', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { handle, container, calls, frames } = mount(ctx);
    handle.destroy();
    expect(handle.el.isConnected).toBe(false);
    expect(container.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.queue.size).toBe(0);
    expect(calls.destroyed).toEqual(expect.arrayContaining(['approval', 'prompt', 'mascot']));
    const before = JSON.stringify(calls);
    ctx.board(makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_new' })] }));
    ctx.store.patch('activity', { reactions: [{ id: 99, kind: 'approval', at: 0 }] });
    ctx.store.patch('prefs', { muted: true });
    expect(JSON.stringify(calls)).toBe(before);
    handle.destroy();
  });

  it('a page’s pill cleans up the same way, without a card to destroy', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    const { handle, container, calls } = mount(ctx, { mode: 'in-page' });
    handle.destroy();
    expect(handle.el.isConnected).toBe(false);
    expect(container.children).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(calls.destroyed).not.toContain('prompt');
  });
});

describe('mounted Notch: hostile strings render as text', () => {
  it('shows names from agents and repositories as text, with visible escapes where a human decides', () => {
    const name = `${HOSTILE}${BIDI}${ZW}${LONG}`;
    const ctx = makeContext({
      snapshot: makeSnapshot({
        project: { ...makeSnapshot().project, name },
        tasks: [
          makeTask({
            task_id: 't1',
            status: 'RUNNING',
            plan_key: `k${BIDI}${ZW}`,
            summary: name,
            agent_key: name,
          }),
        ],
        runs: { t1: makeRun({ task_id: 't1', branch_ref: `friday/${BIDI}x${ZW}` }) },
        approvals: [makeApproval({ task_id: 't1', target: name })],
      }),
    });
    ctx.store.patch('activity', { files: { t1: [{ path: `src/${HOSTILE}${ZW}.ts`, at: 1 }] } });
    const { handle, q } = mount(ctx);
    expect(handle.el.querySelector('img')).toBeNull();
    expect(handle.el.querySelector('script')).toBeNull();
    expect(q('.nt-project').textContent?.startsWith(HOSTILE)).toBe(true);
    expect(q('.nt-project').textContent).not.toContain(BIDI);
    expect(q('.nt-banner-tag').textContent).toBe('k⟨U+202E⟩⟨U+200B⟩');
    expect(q('.nt-meta-branch').textContent).toBe('friday/⟨U+202E⟩x⟨U+200B⟩');
    expect((q('.nt-banner-summary').textContent ?? '').length).toBeLessThanOrEqual(140);
    expect(q('.nt-banner-summary').textContent).toContain(HOSTILE);
    // The pill: folded, so the ticker shows once nothing waits.
    ctx.board({ ...(ctx.store.select('board') as UiSnapshot), approvals: [] });
    expect(handle.el.dataset.state).toBe('compact');
    expect(q('.nt-ticker-file').textContent).toBe(`${HOSTILE}⟨U+200B⟩.ts`);
    expect(q('.nt-ticker').title).toBe(`src/${HOSTILE}⟨U+200B⟩.ts`);
    expect(q('.nt-tag').textContent).toBe('k⟨U+202E⟩⟨U+200B⟩');
    expect(handle.el.querySelector('img')).toBeNull();
  });

  it('a hostile goal in the celebration and a hostile project in the greeting stay text', () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        project: { ...makeSnapshot().project, name: HOSTILE },
        goals: [makeGoal({ status: 'COMPLETED', request: `${HOSTILE}${BIDI}${LONG}`, completed_at: T0 })],
      }),
    });
    const { handle, q } = mount(ctx);
    expect(q('.nt-greet-sub').textContent).toBe(`${HOSTILE} · 0 running`);
    vi.advanceTimersByTime(2400);
    ctx.store.patch('activity', { reactions: [{ id: 1, kind: 'goal-completed', at: 0 }] });
    expect(q('.nt-greet-sub').textContent?.startsWith(HOSTILE)).toBe(true);
    expect(q('.nt-greet-sub').textContent).not.toContain(BIDI);
    expect((q('.nt-greet-sub').textContent ?? '').length).toBeLessThanOrEqual(90);
    expect(handle.el.querySelector('img')).toBeNull();
  });
});
