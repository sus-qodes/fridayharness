import { describe, expect, it } from 'vitest';
import {
  assignLayers,
  boundsOf,
  columnHeight,
  columnX,
  LAYOUT,
  type LayoutInput,
  type LayoutItem,
  layout,
  orderColumns,
  pitch,
} from './layout.js';

const item = (id: string, deps: string[] = [], h = 120, w = 300): LayoutItem => ({ id, w, h, deps });
const goal = (id = 'g'): LayoutItem => ({ id, w: 340, h: 150, deps: [] });

describe('assignLayers', () => {
  it('puts tasks without dependencies in layer 1 under a goal, and 0 without one', () => {
    expect([...assignLayers([item('a'), item('b')], true)]).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
    expect(assignLayers([item('a')], false).get('a')).toBe(0);
  });

  it('ranks a task one past its highest dependency', () => {
    const layers = assignLayers([item('d', ['b', 'c']), item('a'), item('b', ['a']), item('c', ['a', 'b'])], true);
    expect(layers.get('a')).toBe(1);
    expect(layers.get('b')).toBe(2);
    expect(layers.get('c')).toBe(3);
    expect(layers.get('d')).toBe(4);
  });

  it('ignores dependencies outside the group and on itself', () => {
    const layers = assignLayers([item('a', ['elsewhere', 'a']), item('b', ['a'])], true);
    expect(layers.get('a')).toBe(1);
    expect(layers.get('b')).toBe(2);
  });

  it('tolerates cycles', () => {
    const layers = assignLayers([item('a', ['c']), item('b', ['a']), item('c', ['b'])], true);
    expect(layers.size).toBe(3);
    for (const v of layers.values()) expect(Number.isFinite(v)).toBe(true);
    // Ranking starts at a: the edge c → a closes the cycle and is ignored.
    expect(layers.get('a')).toBe(3);
    expect(layers.get('c')).toBe(2);
    expect(layers.get('b')).toBe(1);
    expect(assignLayers([item('x', ['x'])], false).get('x')).toBe(0);
  });

  it('keeps pinned items in layer 0', () => {
    const layers = assignLayers([{ ...item('bar'), pinned: true }, item('a', ['bar'])], true);
    expect(layers.get('bar')).toBe(0);
    expect(layers.get('a')).toBe(1);
  });
});

describe('orderColumns (barycentre)', () => {
  it('keeps the first column and orders later ones by their dependencies', () => {
    const cols = orderColumns([[goal()], [item('a'), item('b')], [item('x', ['b']), item('y', ['a'])]]);
    expect(cols.map((c) => c.map((i) => i.id))).toEqual([['g'], ['a', 'b'], ['y', 'x']]);
  });

  it('uses the mean of several dependencies and breaks ties by input order', () => {
    const cols = orderColumns([
      [item('a'), item('b'), item('c')],
      [item('p', ['b', 'c']), item('q', ['a', 'c']), item('r', ['a', 'c'])],
    ]);
    expect(cols[1]?.map((i) => i.id)).toEqual(['q', 'r', 'p']);
  });
});

describe('pitch and columns', () => {
  it('spaces sibling tops ΔY apart, more for a tall card', () => {
    expect(pitch(100)).toBe(LAYOUT.DY);
    expect(pitch(144)).toBe(160);
    expect(pitch(200)).toBe(200 + LAYOUT.GAP);
    expect(columnHeight([])).toBe(0);
    expect(columnHeight([{ h: 100 }, { h: 100 }])).toBe(160 + 100);
  });

  it('centres layers ΔX apart', () => {
    expect(columnX(0, 340)).toBe(0);
    expect(columnX(1, 300) - columnX(0, 300)).toBe(LAYOUT.DX);
    expect(columnX(1, 300) + 150).toBe(LAYOUT.COL0 + LAYOUT.DX);
  });
});

describe('layout', () => {
  const input: LayoutInput = {
    groups: [
      { id: 'g1', root: goal('g1'), items: [item('a', [], 100), item('b', [], 100), item('c', ['a', 'b'], 100)] },
      { id: 'g2', root: goal('g2'), items: [item('d', [], 100)] },
      { id: 'loose', label: 'Loose tasks', items: [item('l1', [], 100), item('l2', ['l1'], 100)] },
    ],
    pods: [
      { id: 'pod:x', w: 280, h: 150, taskId: 'c' },
      { id: 'pod:y', w: 280, h: 150, taskId: 'a' },
      { id: 'pod:idle', w: 280, h: 150, taskId: null },
      { id: 'pod:gone', w: 280, h: 150, taskId: 'not-on-board' },
    ],
  };
  const lay = layout(input);
  const r = (id: string) => lay.rects.get(id) as { x: number; y: number; w: number; h: number };

  it('places layers ΔX apart and siblings ΔY apart', () => {
    expect(r('g1').x).toBe(0);
    expect(r('a').x).toBe(columnX(1, 300));
    expect(r('c').x - r('a').x).toBe(LAYOUT.DX);
    expect(r('b').y - r('a').y).toBe(LAYOUT.DY);
    expect(lay.layers.get('g1')).toBe(0);
    expect(lay.layers.get('c')).toBe(2);
  });

  it('centres each column in its group', () => {
    const groupH = 160 + 100; // the a/b column is the tallest
    expect(r('a').y).toBe(0);
    expect(r('g1').y).toBe(Math.round((groupH - 150) / 2));
    expect(r('c').y).toBe(Math.round((groupH - 100) / 2));
  });

  it('stacks goals vertically with a gap, then the loose group under its label', () => {
    const g1Bottom = Math.max(r('b').y + r('b').h, r('pod:x').y + r('pod:x').h, r('pod:y').y + r('pod:y').h);
    expect(r('g2').y).toBeGreaterThanOrEqual(g1Bottom + LAYOUT.GROUP_GAP);
    const loose = lay.labels.find((l) => l.text === 'Loose tasks');
    expect(loose).toBeDefined();
    expect(r('l1').y).toBeGreaterThanOrEqual((loose?.y ?? 0) + LAYOUT.LABEL_H);
    expect(r('l1').x).toBe(columnX(0, 300));
    expect(r('l2').x).toBe(columnX(1, 300));
  });

  it('puts pods on the right flank beside their task without overlapping', () => {
    const right = Math.max(r('g1').x + r('g1').w, r('c').x + r('c').w);
    expect(r('pod:x').x).toBe(right + LAYOUT.POD_GAP);
    expect(r('pod:y').x).toBe(r('pod:x').x);
    const [first, second] = [r('pod:y'), r('pod:x')].sort((p, q) => p.y - q.y);
    if (!first || !second) throw new Error('pods missing');
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.h + LAYOUT.GAP);
  });

  it('stacks pods without a task on the board in an Agents column right of everything', () => {
    let maxRight = 0;
    for (const [id, rect] of lay.rects)
      if (id !== 'pod:idle' && id !== 'pod:gone') maxRight = Math.max(maxRight, rect.x + rect.w);
    expect(r('pod:idle').x).toBe(maxRight + LAYOUT.AGENTS_GAP);
    expect(r('pod:gone').x).toBe(r('pod:idle').x);
    expect(r('pod:gone').y).toBe(r('pod:idle').y + 150 + LAYOUT.GAP);
    expect(lay.labels.some((l) => l.text === 'Agents' && l.x === r('pod:idle').x)).toBe(true);
  });

  it('lets hand-moved positions win, ignoring junk', () => {
    const moved = layout(input, {
      a: { x: 999, y: -40 },
      ghost: { x: 1, y: 1 },
      b: { x: Number.NaN, y: 3 },
    });
    expect(moved.rects.get('a')).toMatchObject({ x: 999, y: -40, w: 300, h: 100 });
    expect(moved.rects.get('b')).toEqual(r('b'));
    expect(moved.rects.has('ghost')).toBe(false);
    expect(moved.bounds?.x).toBe(0);
  });

  it('places a pinned review bar under the goal in layer 0', () => {
    const lay2 = layout({
      groups: [{ id: 'g', root: goal(), items: [{ ...item('bar', [], 80, 340), pinned: true }, item('t')] }],
      pods: [],
    });
    expect(lay2.rects.get('bar')?.x).toBe(0);
    expect(lay2.rects.get('bar')?.y).toBe((lay2.rects.get('g')?.y ?? 0) + pitch(150));
    expect(lay2.layers.get('bar')).toBe(0);
  });

  it('lays out a cyclic group without throwing', () => {
    const cyc = layout({ groups: [{ id: 'g', root: goal(), items: [item('a', ['b']), item('b', ['a'])] }], pods: [] });
    expect(cyc.rects.size).toBe(3);
  });

  it('gives no bounds for an empty board', () => {
    const none = layout({ groups: [], pods: [] });
    expect(none.rects.size).toBe(0);
    expect(none.bounds).toBeNull();
    expect(boundsOf([])).toBeNull();
    const idleOnly = layout({ groups: [], pods: [{ id: 'p', w: 280, h: 150, taskId: null }] });
    expect(idleOnly.rects.get('p')).toEqual({ x: 0, y: LAYOUT.LABEL_H, w: 280, h: 150 });
  });

  it('computes bounds around every card', () => {
    expect(
      boundsOf([
        { x: 10, y: 20, w: 5, h: 5 },
        { x: -5, y: 0, w: 10, h: 40 },
      ]),
    ).toEqual({ x: -5, y: 0, w: 20, h: 40 });
  });
});
