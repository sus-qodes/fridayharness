import { describe, expect, it } from 'vitest';
import {
  bezierPoint,
  curveBetween,
  PULSE_LIFE_MS,
  PULSE_TRAVEL_MS,
  pulseColor,
  pulseState,
  readPalette,
} from './edges.js';
import { gridOffset } from './grid.js';
import {
  anyOutside,
  type Camera,
  CameraTween,
  centreOn,
  clampZoom,
  easeOutCubic,
  FIT_PADDING,
  fitBounds,
  fullyVisible,
  gridOpacity,
  gridSpacing,
  intersects,
  lerpCamera,
  MAX_ZOOM,
  MIN_ZOOM,
  miniProjection,
  miniToWorld,
  pan,
  sanitizeCamera,
  screenToWorld,
  visibleWorld,
  wheelFactor,
  worldToMini,
  worldToScreen,
  zoomAt,
  zoomBy,
} from './viewport.js';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('transforms', () => {
  const cam: Camera = { x: 120, y: -40, zoom: 1.5 };

  it('round-trips world and screen', () => {
    const p = { x: 33, y: -7 };
    const s = worldToScreen(cam, p);
    expect(s).toEqual({ x: 33 * 1.5 + 120, y: -7 * 1.5 - 40 });
    const back = screenToWorld(cam, s);
    close(back.x, p.x);
    close(back.y, p.y);
  });

  it('pans by screen pixels', () => {
    expect(pan(cam, 10, -5)).toEqual({ x: 130, y: -45, zoom: 1.5 });
  });
});

describe('cursor-centred zoom', () => {
  it('keeps the world point under the cursor fixed', () => {
    const cases: [Camera, number, { x: number; y: number }][] = [
      [{ x: 0, y: 0, zoom: 1 }, 1.7, { x: 400, y: 300 }],
      [{ x: -250, y: 80, zoom: 0.6 }, 0.3, { x: 13, y: 700 }],
      [{ x: 50, y: 50, zoom: 1.9 }, 2, { x: 999, y: 1 }],
    ];
    for (const [cam, zoom, cursor] of cases) {
      const before = screenToWorld(cam, cursor);
      const next = zoomAt(cam, zoom, cursor);
      const after = screenToWorld(next, cursor);
      close(before.x, after.x, 1e-6);
      close(before.y, after.y, 1e-6);
    }
  });

  it('clamps the zoom to 0.25–2.0 and still keeps the point', () => {
    const cam = { x: 10, y: 20, zoom: 1 };
    const cursor = { x: 300, y: 200 };
    const big = zoomAt(cam, 10, cursor);
    expect(big.zoom).toBe(MAX_ZOOM);
    const small = zoomBy(cam, 0.01, cursor);
    expect(small.zoom).toBe(MIN_ZOOM);
    const w = screenToWorld(small, cursor);
    const w0 = screenToWorld(cam, cursor);
    close(w.x, w0.x, 1e-6);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('turns wheel deltas into gentle factors, stronger for a pinch', () => {
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(3, 1, false)).toBeCloseTo(wheelFactor(48, 0, false));
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false));
    expect(wheelFactor(-1e6, 0, true)).toBeCloseTo(Math.exp(0.5));
  });
});

describe('fit', () => {
  const size = { width: 1200, height: 800 };

  it('shows the bounds whole with 80 px padding, centred', () => {
    const bounds = { x: 100, y: 50, w: 2000, h: 600 };
    const cam = fitBounds(bounds, size);
    const a = worldToScreen(cam, { x: bounds.x, y: bounds.y });
    const b = worldToScreen(cam, { x: bounds.x + bounds.w, y: bounds.y + bounds.h });
    expect(a.x).toBeGreaterThanOrEqual(FIT_PADDING - 1e-6);
    expect(b.x).toBeLessThanOrEqual(size.width - FIT_PADDING + 1e-6);
    expect(a.y).toBeGreaterThanOrEqual(FIT_PADDING - 1e-6);
    expect(b.y).toBeLessThanOrEqual(size.height - FIT_PADDING + 1e-6);
    close((a.x + b.x) / 2, size.width / 2, 1e-6);
    close((a.y + b.y) / 2, size.height / 2, 1e-6);
    // The width is the limiting side: it touches the padding exactly.
    close(a.x, FIT_PADDING, 1e-6);
    expect(fullyVisible(cam, bounds, size, FIT_PADDING - 1)).toBe(true);
  });

  it('never magnifies a small board past 100 % and never zooms out past 25 %', () => {
    expect(fitBounds({ x: 0, y: 0, w: 100, h: 50 }, size).zoom).toBe(1);
    expect(fitBounds({ x: 0, y: 0, w: 100_000, h: 50 }, size).zoom).toBe(MIN_ZOOM);
  });

  it('falls back to the origin without bounds or size', () => {
    expect(fitBounds(null, size)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(fitBounds({ x: 0, y: 0, w: 10, h: 10 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('centres on a point and reports the visible world', () => {
    const cam = centreOn({ x: 0, y: 0, zoom: 0.5 }, { x: 1000, y: 500 }, size);
    const c = screenToWorld(cam, { x: 600, y: 400 });
    close(c.x, 1000);
    close(c.y, 500);
    const v = visibleWorld(cam, size);
    expect(v.w).toBe(2400);
    expect(v.h).toBe(1600);
    expect(intersects(v, { x: 1000, y: 500, w: 1, h: 1 })).toBe(true);
    expect(intersects(v, { x: 99_999, y: 0, w: 1, h: 1 })).toBe(false);
  });
});

describe('animated transition', () => {
  const size = { width: 1000, height: 600 };
  const from = { x: 0, y: 0, zoom: 1 };
  const to = { x: -500, y: 200, zoom: 0.5 };

  it('starts at the start, ends at the target, and eases in between', () => {
    const tw = new CameraTween(from, to, 1000, 400, size);
    expect(tw.at(1000)).toEqual(from);
    expect(tw.at(1400)).toEqual(to);
    expect(tw.done(1399)).toBe(false);
    expect(tw.done(1400)).toBe(true);
    const mid = tw.at(1200);
    expect(mid.zoom).toBeLessThan(1);
    expect(mid.zoom).toBeGreaterThan(0.5);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });

  it('a zero duration ends at once', () => {
    const tw = new CameraTween(from, to, 0, 0, size);
    expect(tw.done(0)).toBe(true);
    expect(tw.at(0)).toEqual(to);
  });

  it('interpolates zoom geometrically', () => {
    const mid = lerpCamera({ x: 0, y: 0, zoom: 0.25 }, { x: 0, y: 0, zoom: 1 }, 0.5, size);
    close(mid.zoom, 0.5);
  });
});

describe('grid', () => {
  it('fades dots in with zoom', () => {
    expect(gridOpacity(0.25)).toBeCloseTo(0.15);
    expect(gridOpacity(1.5)).toBeCloseTo(0.45);
    expect(gridOpacity(2)).toBeCloseTo(0.45);
    expect(gridOpacity(0.875)).toBeCloseTo(0.3);
  });

  it('spaces dots 24 px times the zoom, doubling when they would crowd', () => {
    expect(gridSpacing(1)).toBe(24);
    expect(gridSpacing(2)).toBe(48);
    expect(gridSpacing(0.25)).toBe(12);
    expect(gridSpacing(0.3)).toBeCloseTo(14.4);
    expect(gridOffset(-5, 24)).toBe(19);
    expect(gridOffset(50, 24)).toBe(2);
  });
});

describe('minimap projection', () => {
  it('fits the bounds plus a 150 px margin into 200×130 and maps back', () => {
    const bounds = { x: 0, y: 0, w: 1700, h: 700 };
    const p = miniProjection(bounds);
    expect(p.scale).toBeCloseTo(Math.min(200 / 2000, 130 / 1000));
    // The width limits: the margin corner touches the left edge, and the height is centred.
    const corner = worldToMini(p, { x: -150, y: -150 });
    expect(corner.x).toBeCloseTo(0);
    expect(corner.y).toBeCloseTo((130 - 1000 * 0.1) / 2);
    const back = miniToWorld(p, worldToMini(p, { x: 420, y: 17 }));
    close(back.x, 420, 1e-6);
    close(back.y, 17, 1e-6);
    expect(miniProjection(null).scale).toBeGreaterThan(0);
  });
});

describe('a card outside the view (the minimap rule)', () => {
  const size = { width: 1000, height: 600 };
  const cam = { x: 0, y: 0, zoom: 1 };

  it('is false while every card is wholly on the screen, and on a screen without a size', () => {
    const inside = [
      { x: 10, y: 10, w: 300, h: 150 },
      { x: 600, y: 400, w: 300, h: 150 },
    ];
    expect(anyOutside(inside, cam, size)).toBe(false);
    expect(anyOutside([], cam, size)).toBe(false);
    expect(anyOutside([{ x: -5000, y: 0, w: 10, h: 10 }], cam, { width: 0, height: 0 })).toBe(false);
  });

  it('is true as soon as one card crosses an edge, at any zoom', () => {
    expect(
      anyOutside(
        [
          { x: 10, y: 10, w: 300, h: 150 },
          { x: 900, y: 10, w: 300, h: 150 },
        ],
        cam,
        size,
      ),
    ).toBe(true);
    // At half zoom the same card fits; a camera moved away pushes it out again.
    const half = { x: 0, y: 0, zoom: 0.5 };
    expect(anyOutside([{ x: 900, y: 10, w: 300, h: 150 }], half, size)).toBe(false);
    expect(anyOutside([{ x: 900, y: 10, w: 300, h: 150 }], { ...half, x: -800 }, size)).toBe(true);
  });
});

describe('saved cameras are untrusted', () => {
  it('replaces junk with defaults and clamps the zoom', () => {
    expect(sanitizeCamera(null)).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(sanitizeCamera({ x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: 50 })).toEqual({ x: 0, y: 0, zoom: 2 });
    expect(sanitizeCamera({ x: 5, y: 6, zoom: 0.5 })).toEqual({ x: 5, y: 6, zoom: 0.5 });
  });
});

describe('edges', () => {
  it('connects right socket to left socket with 80 px controls', () => {
    const c = curveBetween({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 100, w: 100, h: 50 });
    expect(c).toEqual([
      { x: 100, y: 25 },
      { x: 180, y: 25 },
      { x: 220, y: 125 },
      { x: 300, y: 125 },
    ]);
  });

  it('goes leftwards from a pod on the right flank to its task', () => {
    const c = curveBetween({ x: 800, y: 0, w: 280, h: 150 }, { x: 380, y: 0, w: 300, h: 150 });
    expect(c[0]).toEqual({ x: 800, y: 75 });
    expect(c[3]).toEqual({ x: 680, y: 75 });
    expect(c[1].x).toBe(720);
  });

  it('goes vertically between overlapping columns', () => {
    const c = curveBetween({ x: 0, y: 0, w: 100, h: 50 }, { x: 20, y: 200, w: 100, h: 50 });
    expect(c[0]).toEqual({ x: 50, y: 50 });
    expect(c[3]).toEqual({ x: 70, y: 200 });
  });

  it('evaluates the Bézier at its ends and middle', () => {
    const c = curveBetween({ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 100, w: 100, h: 50 });
    expect(bezierPoint(c, 0)).toEqual(c[0]);
    expect(bezierPoint(c, 1)).toEqual(c[3]);
    const mid = bezierPoint(c, 0.5);
    expect(mid.x).toBeCloseTo(200);
    expect(mid.y).toBeCloseTo(75);
  });

  it('moves pulses along the conduit then fades them; reduced motion only fades', () => {
    expect(pulseState(-1, false)).toBeNull();
    expect(pulseState(PULSE_LIFE_MS, false)).toBeNull();
    expect(pulseState(PULSE_TRAVEL_MS / 2, false)).toEqual({ t: 0.5, alpha: 1 });
    expect(pulseState(PULSE_TRAVEL_MS, false)?.t).toBe(1);
    const fading = pulseState((PULSE_TRAVEL_MS + PULSE_LIFE_MS) / 2, false);
    expect(fading?.t).toBe(1);
    expect(fading?.alpha).toBeCloseTo(0.5);
    const reduced = pulseState(PULSE_LIFE_MS / 2, true);
    expect(reduced).toEqual({ t: 1, alpha: 0.5 });
  });

  it('colours pulses by kind: read violet, write cyan, command amber', () => {
    const p = readPalette(null);
    expect(pulseColor('read', p)).toBe('#a855f7');
    expect(pulseColor('search', p)).toBe('#a855f7');
    expect(pulseColor('write', p)).toBe('#38bdf8');
    expect(pulseColor('command', p)).toBe('#f59e0b');
    expect(pulseColor('mcp', p)).toBe('#e2e8f0');
    expect(p.status.HARNESS_LOST).toBe('#f59e0b');
  });
});
