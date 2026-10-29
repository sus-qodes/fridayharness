/**
 * The minimap (handoff Part 03 §3): 200×130 in the lower right, every card a small rectangle
 * coloured by kind and status, the visible screen as a translucent frame. Dragging the frame (or
 * pressing anywhere) moves the view; arrow keys move it by a fifth of the screen.
 */
import type { Rect } from '../model/layout.js';
import { h } from '../ui/dom.js';
import type { Palette } from './edges.js';
import { MINIMAP, type MiniProjection, miniProjection, miniToWorld, type Point, worldToMini } from './viewport.js';

export interface MinimapNode {
  kind: 'goal' | 'task' | 'pod' | 'ghost' | 'planbar';
  status?: string;
  rect: Rect;
}

export function miniColor(n: Pick<MinimapNode, 'kind' | 'status'>, p: Palette): string {
  if (n.kind === 'goal') return p.white;
  if (n.kind === 'pod') return p.pod;
  if (n.kind === 'ghost' || n.kind === 'planbar') return p.slate;
  return (n.status && p.status[n.status]) || p.slate;
}

export interface MinimapOptions {
  /** Centre the view on this world point. */
  onMove(world: Point): void;
  /** Move the view by a fraction of the screen. */
  onNudge(fx: number, fy: number): void;
  palette(): Palette;
}

export class Minimap {
  readonly el: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #opts: MinimapOptions;
  #proj: MiniProjection = miniProjection(null);
  #view: Rect = { x: 0, y: 0, w: 0, h: 0 };
  #grab: Point | null = null;
  #pointer: number | null = null;

  constructor(opts: MinimapOptions) {
    this.#opts = opts;
    this.#canvas = h('canvas', { class: 'cv-minimap-canvas', aria: { hidden: 'true' } });
    this.el = h(
      'div',
      {
        class: ['cv-minimap', 'glass-panel'],
        role: 'group',
        tabIndex: 0,
        aria: { label: 'Minimap: drag the frame, or use the arrow keys, to move the view' },
        on: {
          pointerdown: (e) => this.#down(e),
          pointermove: (e) => this.#move(e),
          pointerup: (e) => this.#up(e),
          pointercancel: (e) => this.#up(e),
          keydown: (e) => this.#key(e),
        },
      },
      this.#canvas,
    );
  }

  /** The current projection (exposed for tests). */
  get projection(): MiniProjection {
    return this.#proj;
  }

  draw(nodes: Iterable<MinimapNode>, bounds: Rect | null, view: Rect): void {
    this.#proj = miniProjection(bounds);
    this.#view = view;
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const w = MINIMAP.width;
    const hh = MINIMAP.height;
    if (this.#canvas.width !== w * dpr) this.#canvas.width = w * dpr;
    if (this.#canvas.height !== hh * dpr) this.#canvas.height = hh * dpr;
    let g: CanvasRenderingContext2D | null = null;
    try {
      g = this.#canvas.getContext('2d');
    } catch {
      g = null;
    }
    if (!g) return;
    const p = this.#opts.palette();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    for (const n of nodes) {
      const a = worldToMini(this.#proj, { x: n.rect.x, y: n.rect.y });
      const rw = Math.max(2, n.rect.w * this.#proj.scale);
      const rh = Math.max(2, n.rect.h * this.#proj.scale);
      g.globalAlpha = n.kind === 'ghost' || n.kind === 'planbar' ? 0.5 : 0.9;
      g.fillStyle = miniColor(n, p);
      g.fillRect(a.x, a.y, rw, rh);
    }
    g.globalAlpha = 1;
    const v0 = worldToMini(this.#proj, { x: view.x, y: view.y });
    const vw = view.w * this.#proj.scale;
    const vh = view.h * this.#proj.scale;
    g.fillStyle = 'rgba(255, 255, 255, 0.06)';
    g.fillRect(v0.x, v0.y, vw, vh);
    g.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    g.lineWidth = 1;
    g.strokeRect(v0.x + 0.5, v0.y + 0.5, Math.max(0, vw - 1), Math.max(0, vh - 1));
  }

  destroy(): void {
    this.el.remove();
  }

  #local(e: PointerEvent): Point {
    const r = this.#canvas.getBoundingClientRect();
    const sx = r.width ? MINIMAP.width / r.width : 1;
    const sy = r.height ? MINIMAP.height / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  }

  #down(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const world = miniToWorld(this.#proj, this.#local(e));
    const v = this.#view;
    const inside = world.x >= v.x && world.x <= v.x + v.w && world.y >= v.y && world.y <= v.y + v.h;
    const centre = { x: v.x + v.w / 2, y: v.y + v.h / 2 };
    this.#grab = inside ? { x: world.x - centre.x, y: world.y - centre.y } : { x: 0, y: 0 };
    this.#pointer = e.pointerId;
    try {
      this.el.setPointerCapture?.(e.pointerId);
    } catch {
      // not capturable here; moves inside the minimap still work
    }
    if (!inside) this.#opts.onMove(world);
  }

  #move(e: PointerEvent): void {
    if (this.#pointer !== e.pointerId || !this.#grab) return;
    const world = miniToWorld(this.#proj, this.#local(e));
    this.#opts.onMove({ x: world.x - this.#grab.x, y: world.y - this.#grab.y });
  }

  #up(e: PointerEvent): void {
    if (this.#pointer !== e.pointerId) return;
    this.#pointer = null;
    this.#grab = null;
    try {
      this.el.releasePointerCapture?.(e.pointerId);
    } catch {
      // nothing was captured
    }
  }

  #key(e: KeyboardEvent): void {
    const step = 0.2;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = map[e.key];
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    this.#opts.onNudge(d[0], d[1]);
  }
}
