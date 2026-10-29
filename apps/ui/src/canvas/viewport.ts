/**
 * Viewport math (handoff Part 03 §2, plan §7.3). Pure. The camera is the translation (x, y) in
 * screen pixels and the zoom S: screen = world · S + T, world = (screen − T) / S.
 */
import type { Rect } from '../model/layout.js';

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
/** Fitting never magnifies past 100 %: a small board is shown at its real size. */
export const FIT_MAX_ZOOM = 1;
export const FIT_PADDING = 80;
/** One step of the toolbar and the + and − keys. */
export const ZOOM_STEP = 1.2;
export const FIT_DURATION_MS = 420;

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function clampZoom(z: number): number {
  return Number.isFinite(z) ? clamp(z, MIN_ZOOM, MAX_ZOOM) : 1;
}

/** A camera from untrusted input (a saved preference): finite numbers, zoom in range. */
export function sanitizeCamera(c: Partial<Camera> | null | undefined): Camera {
  const x = typeof c?.x === 'number' && Number.isFinite(c.x) ? c.x : 0;
  const y = typeof c?.y === 'number' && Number.isFinite(c.y) ? c.y : 0;
  const zoom = typeof c?.zoom === 'number' ? clampZoom(c.zoom) : 1;
  return { x, y, zoom };
}

export function worldToScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y };
}

export function screenToWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom };
}

/**
 * Zooms to `zoom` (clamped) keeping the world point under `cursor` (screen coordinates) fixed:
 * T_new = cursor − (cursor − T_old) · S_new / S_old.
 */
export function zoomAt(cam: Camera, zoom: number, cursor: Point): Camera {
  const next = clampZoom(zoom);
  const k = next / cam.zoom;
  return { x: cursor.x - (cursor.x - cam.x) * k, y: cursor.y - (cursor.y - cam.y) * k, zoom: next };
}

/** Zooms by a factor around a screen point. */
export function zoomBy(cam: Camera, factor: number, cursor: Point): Camera {
  return zoomAt(cam, cam.zoom * factor, cursor);
}

export function pan(cam: Camera, dx: number, dy: number): Camera {
  return { x: cam.x + dx, y: cam.y + dy, zoom: cam.zoom };
}

/** The zoom factor of one wheel event: lines and pages count as pixels; a pinch (ctrl) is stronger. */
export function wheelFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const k = pinch ? 0.01 : 0.0015;
  return Math.exp(clamp(-px * k, -0.5, 0.5));
}

/** The world rectangle the screen shows. */
export function visibleWorld(cam: Camera, size: Size): Rect {
  return { x: -cam.x / cam.zoom, y: -cam.y / cam.zoom, w: size.width / cam.zoom, h: size.height / cam.zoom };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

/** The camera that shows `bounds` whole, centred, with `padding` screen pixels around it. */
export function fitBounds(
  bounds: Rect | null,
  size: Size,
  padding = FIT_PADDING,
  maxZoom = FIT_MAX_ZOOM,
  insets: { top: number; bottom: number } = { top: 0, bottom: 0 },
): Camera {
  if (!bounds || size.width <= 0 || size.height <= 0) return { x: 0, y: 0, zoom: 1 };
  // `insets`: rows the overlays keep at the top and bottom (the Notch, the dock).
  const top = Math.max(0, insets.top);
  const bottom = Math.max(0, insets.bottom);
  const availW = Math.max(1, size.width - 2 * padding);
  const availH = Math.max(1, size.height - top - bottom - 2 * padding);
  const raw = Math.min(availW / Math.max(1, bounds.w), availH / Math.max(1, bounds.h));
  const zoom = clamp(raw, MIN_ZOOM, Math.min(MAX_ZOOM, maxZoom));
  const cx = bounds.x + bounds.w / 2;
  const cy = bounds.y + bounds.h / 2;
  const midY = top + (size.height - top - bottom) / 2;
  return { x: size.width / 2 - cx * zoom, y: midY - cy * zoom, zoom };
}

/** The camera that centres world point `p` at the current zoom. */
export function centreOn(cam: Camera, p: Point, size: Size): Camera {
  return { x: size.width / 2 - p.x * cam.zoom, y: size.height / 2 - p.y * cam.zoom, zoom: cam.zoom };
}

/** True when `r` lies wholly inside the screen with `margin` pixels to spare. */
export function fullyVisible(cam: Camera, r: Rect, size: Size, margin = 0): boolean {
  const a = worldToScreen(cam, { x: r.x, y: r.y });
  const b = worldToScreen(cam, { x: r.x + r.w, y: r.y + r.h });
  return a.x >= margin && a.y >= margin && b.x <= size.width - margin && b.y <= size.height - margin;
}

/**
 * True when some rectangle is not wholly on the screen: the minimap's reason to appear (review
 * M9k: on a board that fits, it would show three rectangles in a box). A screen without a size has
 * nothing outside it.
 */
export function anyOutside(rects: Iterable<Rect>, cam: Camera, size: Size): boolean {
  if (size.width <= 0 || size.height <= 0) return false;
  for (const r of rects) if (!fullyVisible(cam, r, size)) return true;
  return false;
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

/**
 * Interpolates two cameras. The zoom moves geometrically and the translation follows the world
 * point at the screen centre, so the view glides instead of swinging.
 */
export function lerpCamera(a: Camera, b: Camera, t: number, size: Size): Camera {
  const k = clamp(t, 0, 1);
  if (k === 0) return a;
  if (k === 1) return b;
  const zoom = a.zoom * (b.zoom / a.zoom) ** k;
  const centre = { x: size.width / 2, y: size.height / 2 };
  const ca = screenToWorld(a, centre);
  const cb = screenToWorld(b, centre);
  const c = { x: ca.x + (cb.x - ca.x) * k, y: ca.y + (cb.y - ca.y) * k };
  return { x: centre.x - c.x * zoom, y: centre.y - c.y * zoom, zoom };
}

/** An animated camera move (the fit transition). `at(now)` gives the camera; `done(now)` ends it. */
export class CameraTween {
  constructor(
    readonly from: Camera,
    readonly to: Camera,
    readonly start: number,
    readonly durationMs: number,
    readonly size: Size,
  ) {}

  progress(now: number): number {
    return this.durationMs <= 0 ? 1 : clamp((now - this.start) / this.durationMs, 0, 1);
  }

  at(now: number): Camera {
    return lerpCamera(this.from, this.to, easeOutCubic(this.progress(now)), this.size);
  }

  done(now: number): boolean {
    return this.progress(now) >= 1;
  }
}

export function sameCamera(a: Camera, b: Camera, eps = 1e-6): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.zoom - b.zoom) < eps;
}

/** Grid dot opacity: 0.15 at S = 0.25 rising to 0.45 at S = 1.5 (Part 03 §2.3). */
export function gridOpacity(zoom: number): number {
  const t = clamp((zoom - 0.25) / (1.5 - 0.25), 0, 1);
  return 0.15 + t * 0.3;
}

/** Grid spacing on screen, doubled until dots are at least `min` pixels apart (fewer dots zoomed out). */
export function gridSpacing(zoom: number, base = 24, min = 12): number {
  let s = base * zoom;
  while (s < min) s *= 2;
  return s;
}

// ---- the minimap (Part 03 §3) ----------------------------------------------------------------

export interface MiniProjection {
  scale: number;
  /** Screen offset of world (0, 0) inside the minimap. */
  ox: number;
  oy: number;
}

export const MINIMAP = { width: 200, height: 130, margin: 150 } as const;

/** Projects the world bounds (plus a 150 px margin) into the minimap, centred. */
export function miniProjection(
  bounds: Rect | null,
  size: Size = { width: MINIMAP.width, height: MINIMAP.height },
): MiniProjection {
  const b = bounds ? inflate(bounds, MINIMAP.margin) : { x: -500, y: -300, w: 1000, h: 600 };
  const scale = Math.min(size.width / Math.max(1, b.w), size.height / Math.max(1, b.h));
  const ox = (size.width - b.w * scale) / 2 - b.x * scale;
  const oy = (size.height - b.h * scale) / 2 - b.y * scale;
  return { scale, ox, oy };
}

export function miniToWorld(p: MiniProjection, pt: Point): Point {
  return { x: (pt.x - p.ox) / p.scale, y: (pt.y - p.oy) / p.scale };
}

export function worldToMini(p: MiniProjection, pt: Point): Point {
  return { x: pt.x * p.scale + p.ox, y: pt.y * p.scale + p.oy };
}
