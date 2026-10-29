/**
 * Edges and conduits on the bottom canvas (handoff Part 04 §5, plan §7.3): dependency splines
 * (emerald and solid when satisfied, slate and dashed while blocking), goal links, proposed-plan
 * links, and the conduit from an agent pod to its RUNNING task with travelling pulses coloured by
 * the tool's kind (read violet, write cyan, command amber).
 */
import type { BoardEdge } from '../model/board.js';
import type { Rect } from '../model/layout.js';
import type { Pulse, ToolKind } from '../store/state.js';
import type { Point } from './viewport.js';

/** A cubic Bézier: start, two controls, end. */
export type Curve = [Point, Point, Point, Point];

export const CONTROL_OFFSET = 80;
/** A pulse travels pod → task in this time, then fades at the task. */
export const PULSE_TRAVEL_MS = 1200;
/** Pulses older than this are gone (and pruned from the store). */
export const PULSE_LIFE_MS = 1600;

/**
 * The curve from card `a` to card `b`: right socket to left socket when `b` is to the right,
 * left to right when it is to the left, else bottom to top (or top to bottom).
 */
export function curveBetween(a: Rect, b: Rect): Curve {
  if (b.x >= a.x + a.w) return horizontal({ x: a.x + a.w, y: a.y + a.h / 2 }, { x: b.x, y: b.y + b.h / 2 });
  if (b.x + b.w <= a.x) return horizontal({ x: a.x, y: a.y + a.h / 2 }, { x: b.x + b.w, y: b.y + b.h / 2 });
  const down = b.y >= a.y;
  const p0 = { x: a.x + a.w / 2, y: down ? a.y + a.h : a.y };
  const p3 = { x: b.x + b.w / 2, y: down ? b.y : b.y + b.h };
  const k = down ? CONTROL_OFFSET : -CONTROL_OFFSET;
  return [p0, { x: p0.x, y: p0.y + k }, { x: p3.x, y: p3.y - k }, p3];
}

function horizontal(p0: Point, p3: Point): Curve {
  const k = p3.x >= p0.x ? CONTROL_OFFSET : -CONTROL_OFFSET;
  return [p0, { x: p0.x + k, y: p0.y }, { x: p3.x - k, y: p3.y }, p3];
}

/** C(t) = (1−t)³P0 + 3(1−t)²tP1 + 3(1−t)t²P2 + t³P3. */
export function bezierPoint(c: Curve, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return {
    x: a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x,
    y: a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y,
  };
}

/** Where a pulse is along its conduit (0 at the pod, 1 at the task) and how opaque. */
export function pulseState(age: number, reduced: boolean): { t: number; alpha: number } | null {
  if (age < 0 || age >= PULSE_LIFE_MS) return null;
  if (reduced) return { t: 1, alpha: 1 - age / PULSE_LIFE_MS };
  if (age <= PULSE_TRAVEL_MS) {
    const t = age / PULSE_TRAVEL_MS;
    return { t, alpha: t < 0.1 ? t / 0.1 : 1 };
  }
  return { t: 1, alpha: 1 - (age - PULSE_TRAVEL_MS) / (PULSE_LIFE_MS - PULSE_TRAVEL_MS) };
}

export interface Palette {
  grid: string;
  emerald: string;
  slate: string;
  goalLink: string;
  ghost: string;
  conduit: string;
  assignment: string;
  read: string;
  write: string;
  command: string;
  other: string;
  white: string;
  pod: string;
  status: Record<string, string>;
}

const FALLBACK = {
  grid: '#334155',
  emerald: '#10b981',
  slate: '#64748b',
  violet: '#a855f7',
  neon: '#38bdf8',
  amber: '#f59e0b',
  light: '#e2e8f0',
  white: '#ffffff',
};

const STATUS_TOKENS: Record<string, [string, string]> = {
  PROPOSED: ['--status-proposed', '#475569'],
  READY: ['--status-ready', '#06b6d4'],
  ASSIGNED: ['--status-assigned', '#a855f7'],
  RUNNING: ['--status-running', '#38bdf8'],
  WAITING: ['--status-waiting', '#f59e0b'],
  READY_FOR_VERIFICATION: ['--status-claimed', '#6366f1'],
  VERIFYING: ['--status-verifying', '#a855f7'],
  COMPLETED: ['--status-completed', '#10b981'],
  FAILED: ['--status-failed', '#ef4444'],
  REWORK: ['--status-rework', '#ea580c'],
  // Plan §7.3: an agent lost is amber (the shared token is red).
  HARNESS_LOST: ['--color-amber', '#f59e0b'],
  CANCELLED: ['--status-cancelled', '#64748b'],
  ABANDONED: ['--status-cancelled', '#64748b'],
};

/** Colours from the design tokens (a canvas cannot read `var()`), with the token values as fallback. */
export function readPalette(
  root: Element | null = typeof document !== 'undefined' ? document.documentElement : null,
): Palette {
  let style: CSSStyleDeclaration | null = null;
  try {
    style = root ? getComputedStyle(root) : null;
  } catch {
    style = null;
  }
  const v = (name: string, fallback: string) => style?.getPropertyValue(name).trim() || fallback;
  const status: Record<string, string> = {};
  for (const [s, [token, fb]] of Object.entries(STATUS_TOKENS)) status[s] = v(token, fb);
  return {
    grid: v('--color-grid-dot', FALLBACK.grid),
    emerald: v('--color-emerald', FALLBACK.emerald),
    slate: v('--color-slate-500', FALLBACK.slate),
    goalLink: 'rgba(148, 163, 184, 0.35)',
    ghost: 'rgba(168, 85, 247, 0.55)',
    conduit: 'rgba(56, 189, 248, 0.4)',
    assignment: 'rgba(56, 189, 248, 0.3)',
    read: v('--color-violet', FALLBACK.violet),
    write: v('--color-neon-blue', FALLBACK.neon),
    command: v('--color-amber', FALLBACK.amber),
    other: v('--color-slate-200', FALLBACK.light),
    white: v('--color-white', FALLBACK.white),
    pod: v('--color-violet', FALLBACK.violet),
    status,
  };
}

/** A pulse's colour by tool kind. */
export function pulseColor(kind: ToolKind, p: Palette): string {
  if (kind === 'read' || kind === 'search') return p.read;
  if (kind === 'write') return p.write;
  if (kind === 'command') return p.command;
  return p.other;
}

function strokeCurve(g: CanvasRenderingContext2D, c: Curve): void {
  g.beginPath();
  g.moveTo(c[0].x, c[0].y);
  g.bezierCurveTo(c[1].x, c[1].y, c[2].x, c[2].y, c[3].x, c[3].y);
  g.stroke();
}

function arrow(g: CanvasRenderingContext2D, c: Curve, size: number): void {
  const tip = c[3];
  const from = c[2];
  const ang = Math.atan2(tip.y - from.y, tip.x - from.x);
  g.beginPath();
  g.moveTo(tip.x, tip.y);
  g.lineTo(tip.x - size * Math.cos(ang - 0.45), tip.y - size * Math.sin(ang - 0.45));
  g.lineTo(tip.x - size * Math.cos(ang + 0.45), tip.y - size * Math.sin(ang + 0.45));
  g.closePath();
  g.fill();
}

/**
 * Draws every edge in world coordinates (the caller set the camera transform). Line widths stay at
 * least one screen pixel at any zoom.
 */
export function drawEdges(
  g: CanvasRenderingContext2D,
  edges: readonly BoardEdge[],
  rects: ReadonlyMap<string, Rect>,
  p: Palette,
  zoom: number,
): void {
  const px = 1 / zoom;
  for (const e of edges) {
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    if (!a || !b) continue;
    const c = curveBetween(a, b);
    g.save();
    switch (e.kind) {
      case 'dependency':
        if (e.satisfied) {
          g.strokeStyle = p.emerald;
          g.fillStyle = p.emerald;
          g.lineWidth = Math.max(2, px);
          g.setLineDash([]);
          strokeCurve(g, c);
          arrow(g, c, 8);
        } else {
          g.strokeStyle = p.slate;
          g.fillStyle = p.slate;
          g.lineWidth = Math.max(1.5, px);
          g.setLineDash([6, 4]);
          strokeCurve(g, c);
          g.setLineDash([]);
          arrow(g, c, 7);
        }
        break;
      case 'goal':
        g.strokeStyle = p.goalLink;
        g.lineWidth = Math.max(1.5, px);
        strokeCurve(g, c);
        break;
      case 'ghost':
        g.strokeStyle = p.ghost;
        g.lineWidth = Math.max(1.5, px);
        g.setLineDash([4, 4]);
        strokeCurve(g, c);
        break;
      case 'assignment':
        g.strokeStyle = p.assignment;
        g.lineWidth = Math.max(1.5, px);
        g.setLineDash([3, 5]);
        strokeCurve(g, c);
        break;
      case 'conduit':
        g.strokeStyle = p.conduit;
        g.lineWidth = Math.max(3, px);
        g.shadowColor = p.write;
        g.shadowBlur = 8;
        strokeCurve(g, c);
        break;
    }
    g.restore();
  }
}

/** The conduit curve of each pod → task edge, by `agentKey|taskId`. */
export function conduitCurves(
  edges: readonly BoardEdge[],
  rects: ReadonlyMap<string, Rect>,
  agentOfPod: (podId: string) => string | null,
): Map<string, Curve> {
  const out = new Map<string, Curve>();
  for (const e of edges) {
    if (e.kind !== 'conduit' && e.kind !== 'assignment') continue;
    const a = rects.get(e.from);
    const b = rects.get(e.to);
    const key = agentOfPod(e.from);
    if (!a || !b || !key) continue;
    out.set(`${key}|${e.to}`, curveBetween(a, b));
  }
  return out;
}

/** Draws live pulses; returns how many are still alive (the loop keeps running while any is). */
export function drawPulses(
  g: CanvasRenderingContext2D | null,
  pulses: readonly Pulse[],
  curves: ReadonlyMap<string, Curve>,
  p: Palette,
  now: number,
  zoom: number,
  reduced: boolean,
): number {
  let alive = 0;
  const r = Math.max(4, 2 / zoom);
  for (const pulse of pulses) {
    const curve = curves.get(`${pulse.agentKey}|${pulse.taskId}`);
    if (!curve) continue;
    const st = pulseState(now - pulse.born, reduced);
    if (!st) continue;
    alive += 1;
    if (!g) continue;
    const pt = bezierPoint(curve, st.t);
    const color = pulseColor(pulse.kind, p);
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, st.alpha));
    g.fillStyle = color;
    g.shadowColor = color;
    g.shadowBlur = 10;
    g.beginPath();
    g.arc(pt.x, pt.y, r, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  return alive;
}
