/**
 * The mascot's design grid and colour helpers, shared by the character and its outfits. Pure.
 */

/** The design grid the mascot is drawn on (scaled to the canvas). */
export const DESIGN = 96;
/** Head size (design px) and the head's centre at rest. */
export const R = 24;
export const CX = 48;
export const CY = 57;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb`, `#rrggbb` or `rgb(a)(…)` to RGB; null when it is none of these. */
export function parseColor(value: string): Rgb | null {
  const v = value.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m?.[1]) {
    const [r, g, b] = m[1].split('').map((c) => Number.parseInt(c + c, 16));
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
  }
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m?.[1]) {
    const n = Number.parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (m) {
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    if ([r, g, b].every((x) => Number.isFinite(x) && x >= 0 && x <= 255)) return { r, g, b };
  }
  return null;
}

export function rgbString(c: Rgb, alpha = 1): string {
  const r = Math.round(Math.min(255, Math.max(0, Number.isFinite(c.r) ? c.r : 0)));
  const g = Math.round(Math.min(255, Math.max(0, Number.isFinite(c.g) ? c.g : 0)));
  const b = Math.round(Math.min(255, Math.max(0, Number.isFinite(c.b) ? c.b : 0)));
  const a = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 1));
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
}

export interface EyeBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FaceLayout {
  /**
   * The face zone's centre and size (design px, before the body transform): where the eyes and
   * the glasses-like outfits live. It moves with the gaze so the eyes stay inside it.
   */
  visor: { x: number; y: number; w: number; h: number; r: number };
  left: EyeBox;
  right: EyeBox;
}

/**
 * Where the eyes sit for a gaze: two points on the face, sliding with the turn. Each eye is at
 * `yaw·½ ± spread` around the head, projected with sin and narrowed by cos as it turns away;
 * pitch (positive downward) moves both up or down.
 */
export function faceLayout(yaw: number, pitch: number): FaceLayout {
  const y = Number.isFinite(yaw) ? yaw : 0;
  const p = Number.isFinite(pitch) ? pitch : 0;
  const visor = { x: CX + y * 1.2, y: CY + R * 0.02, w: R * 1.5, h: R * 1.0, r: R * 0.35 };
  const eye = (side: -1 | 1): EyeBox => {
    const a = y * 0.5 + side * 0.4;
    return {
      x: CX + R * 0.8 * Math.sin(a),
      y: visor.y + R * 0.06 + R * 0.3 * Math.sin(p),
      w: R * 0.3 * Math.max(0.55, Math.cos(a)),
      h: R * 0.46,
    };
  };
  return { visor, left: eye(-1), right: eye(1) };
}
