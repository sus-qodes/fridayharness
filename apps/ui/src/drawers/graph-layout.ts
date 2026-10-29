/**
 * The code graph drawer's layout (plan §7.4, handoff Part 05 §4): the 2-hop neighbourhood of one
 * file in layers around it — the files that import it on the left, the files it imports on the
 * right, the files two steps away in an outer layer — and the colour of each node: in a write scope
 * of a running task (blue), a shared contract (violet), a test (green). Pure; no DOM.
 */
import type { GraphQuery } from '../api/client.js';
import { matchesAny, normalizePath } from './glob.js';

export type GraphRole = 'center' | 'consumer' | 'dependency' | 'test' | 'far';
export type GraphTone = 'test' | 'contract' | 'scope' | 'plain';

export interface LaidNode {
  path: string;
  role: GraphRole;
  /** Layer from the centre: -1 consumers and tests, 0 the file, 1 dependencies, 2 two steps away. */
  layer: -1 | 0 | 1 | 2;
  x: number;
  y: number;
  tone: GraphTone;
  /** In the write scope of a running task (also outlined when another colour wins). */
  inScope: boolean;
  contract: boolean;
  test: boolean;
}

export interface LaidEdge {
  from: string;
  to: string;
  kind: string;
}

export interface GraphLayout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  width: number;
  height: number;
  /** Files of a layer not drawn because the layer is full, by layer. */
  hidden: Record<-1 | 1 | 2, number>;
  /** Column headings with their x. */
  columns: { layer: -1 | 0 | 1 | 2; x: number; label: string }[];
}

export interface LayoutOptions {
  /** Write scopes of running tasks. */
  scopes: readonly string[];
  /** Paths the graph marks as shared contracts. */
  contracts: ReadonlySet<string>;
  /** Most nodes drawn per layer (default 24). */
  perLayer?: number;
}

export const NODE_W = 168;
export const NODE_H = 28;
export const COLUMN_GAP = 64;
export const ROW_GAP = 12;
const PAD = 24;
const HEADING = 28;

const TEST_PATH = /(^|\/)(test|tests|__tests__)\//;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;

/** The code graph's own test rule (`@friday/code-graph`). */
export function isTestPath(path: string): boolean {
  const p = normalizePath(path);
  return TEST_PATH.test(p) || TEST_NAME.test(p);
}

export function classify(
  path: string,
  opts: Pick<LayoutOptions, 'scopes' | 'contracts'>,
  extra: { test?: boolean; contract?: boolean } = {},
): Pick<LaidNode, 'tone' | 'inScope' | 'contract' | 'test'> {
  const test = extra.test || isTestPath(path);
  const contract = extra.contract || opts.contracts.has(normalizePath(path));
  const inScope = matchesAny(path, opts.scopes);
  const tone: GraphTone = test ? 'test' : contract ? 'contract' : inScope ? 'scope' : 'plain';
  return { tone, inScope, contract, test };
}

export function layoutNeighbourhood(q: GraphQuery, opts: LayoutOptions): GraphLayout {
  const perLayer = Math.max(1, opts.perLayer ?? 24);
  const center = normalizePath(q.node?.path ?? '');
  const tests = new Set(q.tests.map(normalizePath));
  const deps = unique(q.dependencies.map((d) => normalizePath(d.to)).filter((p) => p && p !== center));
  const depSet = new Set(deps);
  const consumers = unique(
    q.consumers.map((c) => normalizePath(c.from)).filter((p) => p && p !== center && !depSet.has(p)),
  );
  const near = new Set([...deps, ...consumers, center]);
  const left = [
    ...consumers.filter((p) => !tests.has(p) && !isTestPath(p)),
    ...consumers.filter((p) => tests.has(p) || isTestPath(p)),
    // Tests the graph names that do not import the file directly.
    ...[...tests].filter((p) => !near.has(p)),
  ];
  for (const p of left) near.add(p);
  const far = unique(q.neighbourhood.map((n) => normalizePath(n.path)).filter((p) => p && !near.has(p)));

  const hidden: Record<-1 | 1 | 2, number> = {
    [-1]: Math.max(0, left.length - perLayer),
    1: Math.max(0, deps.length - perLayer),
    2: Math.max(0, far.length - perLayer),
  };
  const drawn = {
    [-1]: left.slice(0, perLayer),
    1: deps.slice(0, perLayer),
    2: far.slice(0, perLayer),
  } as Record<-1 | 1 | 2, string[]>;
  const tallest = Math.max(1, drawn[-1].length, drawn[1].length, drawn[2].length);
  const height = PAD * 2 + HEADING + tallest * NODE_H + (tallest - 1) * ROW_GAP + 24;
  const midY = PAD + HEADING + (tallest * NODE_H + (tallest - 1) * ROW_GAP) / 2;
  const colX = (layer: number) => PAD + (layer + 1) * (NODE_W + COLUMN_GAP);
  const usedLayers = [-1, 0, 1, ...(far.length ? [2] : [])] as (-1 | 0 | 1 | 2)[];
  const width = colX(usedLayers[usedLayers.length - 1] as number) + NODE_W + PAD;

  const nodes: LaidNode[] = [];
  const place = (paths: string[], layer: -1 | 1 | 2) => {
    const total = paths.length * NODE_H + Math.max(0, paths.length - 1) * ROW_GAP;
    const top = midY - total / 2;
    paths.forEach((path, i) => {
      const role: GraphRole =
        layer === 1 ? 'dependency' : layer === 2 ? 'far' : tests.has(path) || isTestPath(path) ? 'test' : 'consumer';
      nodes.push({
        path,
        role,
        layer,
        x: colX(layer),
        y: top + i * (NODE_H + ROW_GAP),
        ...classify(path, opts, { test: tests.has(path) }),
      });
    });
  };
  if (center) {
    nodes.push({
      path: center,
      role: 'center',
      layer: 0,
      x: colX(0),
      y: midY - NODE_H / 2,
      ...classify(center, opts, { contract: Boolean(q.node?.contract) }),
    });
  }
  place(drawn[-1], -1);
  place(drawn[1], 1);
  place(drawn[2], 2);

  const shown = new Set(nodes.map((n) => n.path));
  const edges: LaidEdge[] = [];
  for (const d of q.dependencies) {
    const to = normalizePath(d.to);
    if (shown.has(to) && to !== center) edges.push({ from: center, to, kind: d.kind });
  }
  for (const c of q.consumers) {
    const from = normalizePath(c.from);
    if (shown.has(from) && from !== center && !depSet.has(from)) edges.push({ from, to: center, kind: c.kind });
  }
  for (const t of tests) {
    if (shown.has(t) && !edges.some((e) => e.from === t)) edges.push({ from: t, to: center, kind: 'test' });
  }
  const columns = [
    { layer: -1 as const, x: colX(-1), label: 'Used by' },
    { layer: 0 as const, x: colX(0), label: 'This file' },
    { layer: 1 as const, x: colX(1), label: 'Imports' },
    ...(far.length ? [{ layer: 2 as const, x: colX(2), label: 'Two steps away' }] : []),
  ];
  return { nodes, edges, width, height, hidden, columns };
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}

/** The SVG path of an edge from the right side of one node to the left side of the other. */
export function edgePath(from: LaidNode, to: LaidNode): string {
  const forward = from.x < to.x;
  const x1 = forward ? from.x + NODE_W : from.x;
  const x2 = forward ? to.x : to.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const y2 = to.y + NODE_H / 2;
  const dx = Math.max(24, Math.abs(x2 - x1) / 2) * (forward ? 1 : -1);
  return `M${r(x1)} ${r(y1)} C${r(x1 + dx)} ${r(y1)} ${r(x2 - dx)} ${r(y2)} ${r(x2)} ${r(y2)}`;
}

function r(n: number): string {
  return String(Math.round(n * 10) / 10);
}
