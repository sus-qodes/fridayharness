/**
 * Blip's eyes (plan §7.9): fourteen LED glyphs lit on the dark visor. Each glyph draws itself
 * centred on `(x, y)` in a `w × h` box with the fill, stroke and glow the caller set; `lid` (0 shut,
 * 1 open) squeezes the glyphs that blink. Pure drawing, no state.
 */

export const EYE_SHAPES = [
  'pill',
  'wide',
  'dot',
  'line',
  'flat',
  'happy',
  'closed',
  'spiral',
  'heart',
  'star',
  'tired',
  'wink',
  'cup',
  'x',
] as const;

export type EyeShape = (typeof EYE_SHAPES)[number];

/** The canvas calls the glyphs use (a subset of `CanvasRenderingContext2D`, so tests can record them). */
export type Pen = Pick<
  CanvasRenderingContext2D,
  | 'beginPath'
  | 'closePath'
  | 'moveTo'
  | 'lineTo'
  | 'arc'
  | 'arcTo'
  | 'quadraticCurveTo'
  | 'bezierCurveTo'
  | 'ellipse'
  | 'fill'
  | 'stroke'
  | 'save'
  | 'restore'
  | 'lineWidth'
  | 'lineCap'
  | 'lineJoin'
>;

export interface EyeGlyph {
  /** Whether a blink squeezes it (arcs, crosses and closed eyes do not blink). */
  readonly blinks: boolean;
  /** `side` is −1 for the left eye and 1 for the right one. */
  draw(g: Pen, x: number, y: number, w: number, h: number, side: -1 | 1, lid: number): void;
}

/** A lid never closes to nothing: a shut LED still shows a thin line. */
export const MIN_LID = 0.12;

function lidOf(lid: number): number {
  return Number.isFinite(lid) ? Math.min(1, Math.max(MIN_LID, lid)) : 1;
}

/** A rounded rectangle path centred on `(x, y)`. */
export function roundRectPath(g: Pen, x: number, y: number, w: number, h: number, r: number): void {
  const hw = Math.max(0, w / 2);
  const hh = Math.max(0, h / 2);
  const rr = Math.max(0, Math.min(r, hw, hh));
  g.moveTo(x - hw + rr, y - hh);
  g.arcTo(x + hw, y - hh, x + hw, y + hh, rr);
  g.arcTo(x + hw, y + hh, x - hw, y + hh, rr);
  g.arcTo(x - hw, y + hh, x - hw, y - hh, rr);
  g.arcTo(x - hw, y - hh, x + hw, y - hh, rr);
  g.closePath();
}

function capsule(g: Pen, x: number, y: number, w: number, h: number): void {
  g.beginPath();
  roundRectPath(g, x, y, w, h, Math.min(w, h) / 2);
  g.fill();
}

/** A capsule whose top is cut by a straight lid from `(inner top)` to `(outer top)`. */
function lidded(g: Pen, x: number, y: number, w: number, h: number, side: -1 | 1, innerTop: number, outerTop: number) {
  const hw = w / 2;
  const bottom = y + h / 2;
  const r = Math.min(hw, h / 2);
  const innerX = x - side * hw;
  const outerX = x + side * hw;
  g.beginPath();
  g.moveTo(innerX, y + innerTop);
  g.lineTo(outerX, y + outerTop);
  g.lineTo(outerX, bottom - r);
  g.arc(x, bottom - r, r, side === 1 ? 0 : Math.PI, side === 1 ? Math.PI : 0, side !== 1);
  g.closePath();
  g.fill();
}

function strokeArc(g: Pen, x: number, y: number, r: number, from: number, to: number, width: number): void {
  g.beginPath();
  g.lineWidth = width;
  g.lineCap = 'round';
  g.arc(x, y, r, from, to, false);
  g.stroke();
}

function starPath(g: Pen, x: number, y: number, outer: number, inner: number, points = 5): void {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) g.moveTo(px, py);
    else g.lineTo(px, py);
  }
  g.closePath();
}

/** A heart centred on `(x, y)`, `s` wide. */
export function heartPath(g: Pen, x: number, y: number, s: number): void {
  const top = y - s * 0.22;
  g.beginPath();
  g.moveTo(x, y + s * 0.42);
  g.bezierCurveTo(x - s * 0.62, y + s * 0.02, x - s * 0.5, top - s * 0.32, x, top + s * 0.02);
  g.bezierCurveTo(x + s * 0.5, top - s * 0.32, x + s * 0.62, y + s * 0.02, x, y + s * 0.42);
  g.closePath();
}

export const EYES: Readonly<Record<EyeShape, EyeGlyph>> = Object.freeze({
  pill: {
    blinks: true,
    draw: (g, x, y, w, h, _side, lid) => capsule(g, x, y, w, h * lidOf(lid)),
  },
  wide: {
    blinks: true,
    draw: (g, x, y, w, h, _side, lid) => capsule(g, x, y, w * 1.28, h * 1.28 * lidOf(lid)),
  },
  dot: {
    blinks: true,
    draw: (g, x, y, w, _h, _side, lid) => {
      const r = w * 0.36;
      g.beginPath();
      g.ellipse(x, y, r, r * lidOf(lid), 0, 0, Math.PI * 2);
      g.fill();
    },
  },
  line: {
    blinks: false,
    draw: (g, x, y, w) => capsule(g, x, y, w * 1.15, Math.max(1, w * 0.26)),
  },
  flat: {
    blinks: true,
    draw: (g, x, y, w, h, side, lid) => {
      const l = lidOf(lid);
      lidded(g, x, y, w, h * l, side, -h * l * 0.05, -h * l * 0.05);
    },
  },
  happy: {
    blinks: false,
    draw: (g, x, y, w, h) => strokeArc(g, x, y + h * 0.22, w * 0.58, Math.PI * 1.12, Math.PI * 1.88, w * 0.34),
  },
  closed: {
    blinks: false,
    draw: (g, x, y, w) => {
      g.beginPath();
      g.lineWidth = Math.max(1, w * 0.26);
      g.lineCap = 'round';
      g.moveTo(x - w * 0.6, y);
      g.quadraticCurveTo(x, y + w * 0.38, x + w * 0.6, y);
      g.stroke();
    },
  },
  spiral: {
    blinks: false,
    draw: (g, x, y, w, _h, side) => {
      g.beginPath();
      g.lineWidth = Math.max(1, w * 0.17);
      g.lineCap = 'round';
      const turns = Math.PI * 3.2;
      for (let a = 0; a <= turns; a += 0.25) {
        const r = w * (0.06 + (a / turns) * 0.58);
        const px = x + Math.cos(a * side) * r;
        const py = y + Math.sin(a * side) * r;
        if (a === 0) g.moveTo(px, py);
        else g.lineTo(px, py);
      }
      g.stroke();
    },
  },
  heart: {
    blinks: false,
    draw: (g, x, y, w) => {
      heartPath(g, x, y, w * 1.45);
      g.fill();
    },
  },
  star: {
    blinks: false,
    draw: (g, x, y, w) => {
      starPath(g, x, y, w * 0.82, w * 0.36);
      g.fill();
    },
  },
  tired: {
    blinks: true,
    draw: (g, x, y, w, h, side, lid) => {
      const l = lidOf(lid);
      lidded(g, x, y + h * 0.08, w, h * 0.84 * l, side, -h * 0.16 * l, h * 0.06 * l);
    },
  },
  wink: {
    blinks: false,
    draw: (g, x, y, w, h, side, lid) => {
      if (side === -1) capsule(g, x, y, w, h * lidOf(lid));
      else strokeArc(g, x, y + h * 0.22, w * 0.58, Math.PI * 1.12, Math.PI * 1.88, w * 0.34);
    },
  },
  cup: {
    blinks: false,
    draw: (g, x, y, w, h) => strokeArc(g, x, y - h * 0.24, w * 0.58, Math.PI * 0.12, Math.PI * 0.88, w * 0.34),
  },
  x: {
    blinks: false,
    draw: (g, x, y, w) => {
      const d = w * 0.55;
      g.beginPath();
      g.lineWidth = Math.max(1, w * 0.3);
      g.lineCap = 'round';
      g.moveTo(x - d, y - d);
      g.lineTo(x + d, y + d);
      g.moveTo(x + d, y - d);
      g.lineTo(x - d, y + d);
      g.stroke();
    },
  },
});

export function isEyeShape(value: unknown): value is EyeShape {
  return typeof value === 'string' && (EYE_SHAPES as readonly string[]).includes(value);
}

/** Draws one eye; an unknown shape falls back to `pill`. */
export function drawEye(g: Pen, shape: EyeShape, x: number, y: number, w: number, h: number, side: -1 | 1, lid = 1) {
  const glyph = EYES[shape] ?? EYES.pill;
  glyph.draw(g, x, y, w, h, side, glyph.blinks ? lid : 1);
}

export { starPath };
