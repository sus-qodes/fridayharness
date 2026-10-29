/**
 * The canvas auto-layout (handoff Part 03 §4, plan §7.3). Pure: a layered graph layout per group.
 *
 * - Per goal, the goal is layer 0 and a task's layer is 1 + the highest layer of its dependencies
 *   (a task without dependencies in the group is layer 1); a group without a root (the loose
 *   tasks) starts at layer 0. Dependency cycles are tolerated: an edge back into the path being
 *   ranked is ignored.
 * - Within a layer, nodes are ordered by the barycentre of their dependencies' positions in the
 *   earlier layers (input order breaks ties and orders nodes without placed dependencies).
 * - Layer centres are ΔX = 360 px apart; sibling tops ΔY = 160 px apart, more when a card is taller
 *   than ΔY minus the minimum gap (the handoff's own task card, 165 px, does not fit 160).
 * - Groups are stacked vertically with a gap; each column is centred in its group's height.
 * - Agent pods sit on the right flank of their task's group, level with the task; pods without a
 *   task on the board stack in an "Agents" column right of everything.
 * - Positions moved by hand (prefs.positions) override the computed ones.
 */

export const LAYOUT = {
  /** Distance between layer centres. */
  DX: 360,
  /** Distance between sibling card tops (the minimum pitch). */
  DY: 160,
  /** Smallest vertical gap between two cards of a column. */
  GAP: 16,
  /** Vertical gap between two groups. */
  GROUP_GAP: 120,
  /** Gap between a group's right edge and its pods. */
  POD_GAP: 80,
  /** Gap between everything and the idle "Agents" column. */
  AGENTS_GAP: 120,
  /** Height reserved above a labelled group. */
  LABEL_H: 32,
  /** Centre of layer 0 (a 340 px goal card then starts at x = 0). */
  COL0: 170,
} as const;

export interface LayoutItem {
  id: string;
  w: number;
  h: number;
  /** Ids this item depends on; ids outside its group are ignored for ranking. */
  deps: readonly string[];
  /** Placed in layer 0 below the root (a plan review bar). */
  pinned?: boolean;
}

export interface LayoutGroup {
  id: string;
  /** Shown above the group ("Loose tasks"). */
  label?: string;
  /** The goal card (layer 0). */
  root?: LayoutItem;
  items: LayoutItem[];
}

export interface LayoutPod {
  id: string;
  w: number;
  h: number;
  /** The task it works on; null puts it in the "Agents" column. */
  taskId: string | null;
}

export interface LayoutInput {
  groups: LayoutGroup[];
  pods: LayoutPod[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutLabel {
  id: string;
  text: string;
  x: number;
  y: number;
}

export interface Layout {
  rects: Map<string, Rect>;
  labels: LayoutLabel[];
  /** The box around every card; null when there is none. */
  bounds: Rect | null;
  /** The layer of every group item and root (pods have none). */
  layers: Map<string, number>;
}

export type Positions = Record<string, { x: number; y: number }>;

/**
 * Layers of a group's items: pinned items and the root are 0; others are `base` when they have no
 * dependency in the group, else 1 + the highest layer of those dependencies.
 */
export function assignLayers(items: readonly LayoutItem[], hasRoot: boolean): Map<string, number> {
  const base = hasRoot ? 1 : 0;
  const byId = new Map(items.map((i) => [i.id, i]));
  const layers = new Map<string, number>();
  const state = new Map<string, 'visiting' | 'done'>();

  const rank = (item: LayoutItem): number => {
    const known = layers.get(item.id);
    if (known !== undefined) return known;
    if (item.pinned) {
      layers.set(item.id, 0);
      return 0;
    }
    state.set(item.id, 'visiting');
    let layer = base;
    for (const d of item.deps) {
      const dep = byId.get(d);
      if (!dep || dep.pinned || d === item.id) continue;
      if (state.get(d) === 'visiting') continue; // a cycle: this edge does not rank
      layer = Math.max(layer, rank(dep) + 1);
    }
    state.set(item.id, 'done');
    layers.set(item.id, layer);
    return layer;
  };
  for (const item of items) rank(item);
  return layers;
}

/**
 * Orders each column by the barycentre of its items' dependencies in earlier columns (positions
 * normalised to 0..1 so columns of different sizes compare). Column 0 keeps its order.
 */
export function orderColumns(columns: readonly LayoutItem[][]): LayoutItem[][] {
  const pos = new Map<string, number>();
  const out: LayoutItem[][] = [];
  columns.forEach((col, c) => {
    let ordered = [...col];
    if (c > 0) {
      const keyed = col.map((item, i) => {
        const preds = item.deps.map((d) => pos.get(d)).filter((p): p is number => p !== undefined);
        const bc = preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : (i + 0.5) / col.length;
        return { item, bc, i };
      });
      keyed.sort((a, b) => a.bc - b.bc || a.i - b.i);
      ordered = keyed.map((k) => k.item);
    }
    ordered.forEach((item, i) => {
      pos.set(item.id, (i + 0.5) / ordered.length);
    });
    out.push(ordered);
  });
  return out;
}

/** The vertical distance from one card's top to the next card's top. */
export function pitch(h: number): number {
  return Math.max(LAYOUT.DY, h + LAYOUT.GAP);
}

export function columnHeight(col: readonly { h: number }[]): number {
  if (!col.length) return 0;
  let total = 0;
  for (let i = 0; i < col.length - 1; i++) total += pitch((col[i] as { h: number }).h);
  return total + (col[col.length - 1] as { h: number }).h;
}

/** The x of a card of width `w` centred on layer `layer`. */
export function columnX(layer: number, w: number): number {
  return Math.round(LAYOUT.COL0 + layer * LAYOUT.DX - w / 2);
}

export function layout(input: LayoutInput, positions: Positions = {}): Layout {
  const rects = new Map<string, Rect>();
  const labels: LayoutLabel[] = [];
  const layers = new Map<string, number>();
  const groupOfItem = new Map<string, string>();
  let cursor = 0;

  const podsByGroup = new Map<string, LayoutPod[]>();
  const idle: LayoutPod[] = [];
  for (const g of input.groups) for (const item of g.items) if (!item.pinned) groupOfItem.set(item.id, g.id);
  for (const pod of input.pods) {
    const g = pod.taskId ? groupOfItem.get(pod.taskId) : undefined;
    if (g === undefined) idle.push(pod);
    else podsByGroup.set(g, [...(podsByGroup.get(g) ?? []), pod]);
  }

  for (const group of input.groups) {
    if (!group.root && !group.items.length) continue;
    if (group.label) {
      labels.push({ id: `label:${group.id}`, text: group.label, x: 0, y: cursor });
      cursor += LAYOUT.LABEL_H;
    }
    const top = cursor;
    const hasRoot = !!group.root;
    const items = hasRoot ? group.items : group.items.filter((i) => !i.pinned);
    const itemLayers = assignLayers(items, hasRoot);
    const columns: LayoutItem[][] = [];
    if (group.root) {
      layers.set(group.root.id, 0);
      columns[0] = [group.root];
    }
    for (const item of items) {
      const layer = itemLayers.get(item.id) ?? 0;
      layers.set(item.id, layer);
      const col = columns[layer] ?? [];
      col.push(item);
      columns[layer] = col;
    }
    const dense = columns.map((c) => c ?? []);
    const ordered = orderColumns(dense);
    const groupH = Math.max(0, ...ordered.map(columnHeight));
    let right = 0;
    ordered.forEach((col, c) => {
      let y = top + (groupH - columnHeight(col)) / 2;
      for (const item of col) {
        const x = columnX(c, item.w);
        rects.set(item.id, { x, y: Math.round(y), w: item.w, h: item.h });
        right = Math.max(right, x + item.w);
        y += pitch(item.h);
      }
    });

    // Pods of this group: on its right flank, level with their task, never overlapping.
    let bottom = top + groupH;
    const pods = podsByGroup.get(group.id) ?? [];
    if (pods.length) {
      const x = right + LAYOUT.POD_GAP;
      const wanted = pods.map((pod, i) => {
        const t = rects.get(pod.taskId as string) as Rect;
        return { pod, i, y: t.y + (t.h - pod.h) / 2 };
      });
      wanted.sort((a, b) => a.y - b.y || a.i - b.i);
      let next = top;
      for (const w of wanted) {
        const y = Math.round(Math.max(w.y, next, top));
        rects.set(w.pod.id, { x, y, w: w.pod.w, h: w.pod.h });
        next = y + w.pod.h + LAYOUT.GAP;
        bottom = Math.max(bottom, y + w.pod.h);
      }
    }
    cursor = bottom + LAYOUT.GROUP_GAP;
  }

  // Idle pods: a column right of everything.
  if (idle.length) {
    let maxRight = 0;
    for (const r of rects.values()) maxRight = Math.max(maxRight, r.x + r.w);
    const x = rects.size ? maxRight + LAYOUT.AGENTS_GAP : 0;
    labels.push({ id: 'label:agents', text: 'Agents', x, y: 0 });
    let y = LAYOUT.LABEL_H;
    for (const pod of idle) {
      rects.set(pod.id, { x, y, w: pod.w, h: pod.h });
      y += pod.h + LAYOUT.GAP;
    }
  }

  // Hand-moved cards keep their place.
  for (const [id, p] of Object.entries(positions)) {
    const r = rects.get(id);
    if (!r || !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    rects.set(id, { ...r, x: p.x, y: p.y });
  }

  return { rects, labels, bounds: boundsOf(rects.values()), layers };
}

export function boundsOf(list: Iterable<Rect>): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const r of list) {
    any = true;
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return any ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : null;
}
