import { afterEach, describe, expect, it, vi } from 'vitest';
import { readPalette } from './edges.js';
import { Minimap, miniColor } from './minimap.js';
import { worldToMini } from './viewport.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function box(el: Element): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    width: 200,
    height: 130,
    right: 200,
    bottom: 130,
    toJSON: () => ({}),
  } as DOMRect);
}

describe('minimap', () => {
  const palette = readPalette(null);

  it('colours goals white, pods violet and tasks by status', () => {
    expect(miniColor({ kind: 'goal' }, palette)).toBe('#ffffff');
    expect(miniColor({ kind: 'pod' }, palette)).toBe('#a855f7');
    expect(miniColor({ kind: 'task', status: 'COMPLETED' }, palette)).toBe('#10b981');
    expect(miniColor({ kind: 'task', status: 'RUNNING' }, palette)).toBe('#38bdf8');
    expect(miniColor({ kind: 'task', status: 'WAITING' }, palette)).toBe('#f59e0b');
    expect(miniColor({ kind: 'task', status: 'WHATEVER' }, palette)).toBe(palette.slate);
  });

  it('jumps to a pressed point and drags the frame from where it was grabbed', () => {
    const onMove = vi.fn();
    const m = new Minimap({ onMove, onNudge: vi.fn(), palette: () => palette });
    document.body.append(m.el);
    const canvas = m.el.querySelector('canvas') as HTMLCanvasElement;
    box(canvas);
    const view = { x: 0, y: 0, w: 1000, h: 600 };
    m.draw([{ kind: 'goal', rect: { x: 0, y: 0, w: 340, h: 150 } }], { x: 0, y: 0, w: 2000, h: 1000 }, view);
    const p = m.projection;
    // Outside the frame: the view centres on the pressed point.
    const far = worldToMini(p, { x: 1800, y: 900 });
    m.el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: far.x, clientY: far.y }));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0]?.[0].x).toBeCloseTo(1800, 0);
    m.el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    // Inside the frame: dragging moves it by the drag, keeping the grab offset.
    onMove.mockClear();
    const inside = worldToMini(p, { x: 100, y: 100 });
    m.el.dispatchEvent(
      new PointerEvent('pointerdown', { button: 0, pointerId: 2, clientX: inside.x, clientY: inside.y }),
    );
    expect(onMove).not.toHaveBeenCalled();
    const moved = worldToMini(p, { x: 300, y: 100 });
    m.el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: moved.x, clientY: moved.y }));
    const centre = onMove.mock.calls[0]?.[0];
    expect(centre.x).toBeCloseTo(500 + 200, 0);
    expect(centre.y).toBeCloseTo(300, 0);
    m.el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
    m.el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 2, clientX: 0, clientY: 0 }));
    expect(onMove).toHaveBeenCalledTimes(1);
    m.destroy();
    expect(m.el.isConnected).toBe(false);
  });

  it('moves the view with the arrow keys', () => {
    const onNudge = vi.fn();
    const m = new Minimap({ onMove: vi.fn(), onNudge, palette: () => palette });
    m.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    m.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    m.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(onNudge.mock.calls).toEqual([
      [0.2, 0],
      [0, -0.2],
    ]);
    expect(m.el.tabIndex).toBe(0);
    expect(m.el.getAttribute('aria-label')).toContain('arrow keys');
  });
});
