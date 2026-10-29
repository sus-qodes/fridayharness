import { describe, expect, it } from 'vitest';
import {
  diffLines,
  type Edit,
  firstChangedLine,
  MAX_DIFF_LINES,
  myers,
  pairRows,
  splitLines,
  toHunks,
} from './diff.js';

/** Applies an edit script to `a`; it must give `b`. */
function apply(a: string[], b: string[], edits: Edit[]): string[] {
  const out: string[] = [];
  let ai = 0;
  let bi = 0;
  for (const e of edits) {
    if (e.op === 'eq') {
      expect(e.a).toBe(ai);
      expect(e.b).toBe(bi);
      expect(a[e.a]).toBe(b[e.b]);
      out.push(a[e.a] as string);
      ai++;
      bi++;
    } else if (e.op === 'del') {
      expect(e.a).toBe(ai);
      ai++;
    } else {
      expect(e.b).toBe(bi);
      out.push(b[e.b] as string);
      bi++;
    }
  }
  expect(ai).toBe(a.length);
  expect(bi).toBe(b.length);
  return out;
}

function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      (dp[i] as number[])[j] =
        a[i - 1] === b[j - 1]
          ? ((dp[i - 1] as number[])[j - 1] as number) + 1
          : Math.max((dp[i - 1] as number[])[j] as number, (dp[i] as number[])[j - 1] as number);
  return (dp[a.length] as number[])[b.length] as number;
}

function cost(edits: Edit[]): number {
  return edits.filter((e) => e.op !== 'eq').length;
}

/** A small deterministic generator (mulberry32). */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe('splitLines', () => {
  it.each([
    [null, []],
    [undefined, []],
    ['', []],
    ['a', ['a']],
    ['a\n', ['a']],
    ['a\n\n', ['a', '']],
    ['a\r\nb\r\n', ['a', 'b']],
    ['\n', ['']],
  ])('%j → %j', (text, lines) => {
    expect(splitLines(text as string | null)).toEqual(lines);
  });
});

describe('myers', () => {
  const cases: [string, string[], string[], number][] = [
    ['identical', ['a', 'b', 'c'], ['a', 'b', 'c'], 0],
    ['insert in the middle', ['a', 'c'], ['a', 'b', 'c'], 1],
    ['insert at the start', ['b', 'c'], ['a', 'b', 'c'], 1],
    ['insert at the end', ['a', 'b'], ['a', 'b', 'c'], 1],
    ['delete', ['a', 'b', 'c'], ['a', 'c'], 1],
    ['change one line', ['a', 'b', 'c'], ['a', 'x', 'c'], 2],
    ['empty old side', [], ['a', 'b'], 2],
    ['empty new side', ['a', 'b'], [], 2],
    ['both empty', [], [], 0],
    ['nothing shared', ['a', 'b'], ['c', 'd', 'e'], 5],
    ['the classic ABCABBA / CBABAC', [...'ABCABBA'], [...'CBABAC'], 5],
    ['repeated lines', ['x', 'x', 'x'], ['x', 'x'], 1],
  ];
  it.each(cases)('%s', (_name, a, b, d) => {
    const edits = myers(a, b);
    expect(apply(a, b, edits)).toEqual(b);
    expect(cost(edits)).toBe(d);
  });

  it('finds a shortest script on random inputs (checked against the LCS)', () => {
    const next = rng(42);
    for (let round = 0; round < 300; round++) {
      const n = Math.floor(next() * 14);
      const m = Math.floor(next() * 14);
      const pick = () => 'abc'[Math.floor(next() * 3)] as string;
      const a = Array.from({ length: n }, pick);
      const b = Array.from({ length: m }, pick);
      const edits = myers(a, b);
      expect(apply(a, b, edits)).toEqual(b);
      expect(cost(edits)).toBe(n + m - 2 * lcs(a, b));
    }
  });

  it('lists the removals of a change before its additions', () => {
    const ops = myers(['a', 'b', 'c'], ['a', 'x', 'y', 'c']).map((e) => e.op);
    expect(ops).toEqual(['eq', 'del', 'ins', 'ins', 'eq']);
  });

  it('stays fast on two files near the cap with scattered changes', () => {
    const a = Array.from({ length: 4990 }, (_, i) => `line ${i}`);
    const b = a.map((l, i) => (i % 97 === 0 ? `${l} changed` : l));
    b.splice(2500, 0, 'inserted');
    const started = performance.now();
    const d = diffLines(a.join('\n'), b.join('\n'));
    expect(performance.now() - started).toBeLessThan(3000);
    expect(d.replaced).toBe(false);
    expect(d.added).toBe(Math.ceil(4990 / 97) + 1);
    expect(d.removed).toBe(Math.ceil(4990 / 97));
  });
});

describe('myers worst case', () => {
  it('finishes two 5 000-line files with nothing in common', () => {
    const a = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `old ${i}`);
    const b = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `new ${i}`);
    const started = performance.now();
    const d = diffLines(a.join('\n'), b.join('\n'));
    expect(performance.now() - started).toBeLessThan(5000);
    expect(d).toMatchObject({ added: MAX_DIFF_LINES, removed: MAX_DIFF_LINES, replaced: false });
  });

  it('finishes two 5 000-line files that interleave', () => {
    const a = Array.from({ length: MAX_DIFF_LINES }, (_, i) => (i % 2 ? `x${i}` : 'same'));
    const b = Array.from({ length: MAX_DIFF_LINES }, (_, i) => (i % 2 ? 'same' : `y${i}`));
    const started = performance.now();
    const edits = myers(a, b);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(apply(a, b, edits)).toEqual(b);
  });
});

describe('diffLines', () => {
  const ten = Array.from({ length: 10 }, (_, i) => `l${i + 1}`);

  it('numbers lines on both sides and counts them', () => {
    const after = [...ten];
    after[4] = 'changed';
    const d = diffLines(ten.join('\n'), after.join('\n'));
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.identical).toBe(false);
    const del = d.lines.find((l) => l.kind === 'del');
    const add = d.lines.find((l) => l.kind === 'add');
    expect(del).toEqual({ kind: 'del', oldNo: 5, newNo: null, text: 'l5' });
    expect(add).toEqual({ kind: 'add', oldNo: null, newNo: 5, text: 'changed' });
  });

  it('builds a hunk with three lines of context', () => {
    const after = [...ten];
    after[4] = 'changed';
    const [hunk, ...rest] = diffLines(ten.join('\n'), after.join('\n')).hunks;
    expect(rest).toEqual([]);
    expect(hunk).toMatchObject({ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 });
    expect(hunk?.lines.map((l) => l.text)).toEqual(['l2', 'l3', 'l4', 'l5', 'changed', 'l6', 'l7', 'l8']);
  });

  it('keeps distant changes in separate hunks and merges near ones', () => {
    const many = Array.from({ length: 40 }, (_, i) => `l${i + 1}`);
    const far = [...many];
    far[2] = 'x';
    far[30] = 'y';
    expect(diffLines(many.join('\n'), far.join('\n')).hunks).toHaveLength(2);
    const near = [...many];
    near[2] = 'x';
    near[8] = 'y';
    expect(diffLines(many.join('\n'), near.join('\n')).hunks).toHaveLength(1);
  });

  it('handles an added file and a deleted file', () => {
    const added = diffLines(null, 'a\nb\n');
    expect(added).toMatchObject({ added: 2, removed: 0 });
    expect(added.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    const deleted = diffLines('a\nb\n', null);
    expect(deleted).toMatchObject({ added: 0, removed: 2 });
    expect(deleted.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0 });
  });

  it('says when both sides are the same', () => {
    const d = diffLines('a\nb', 'a\nb\n');
    expect(d.identical).toBe(true);
    expect(d.hunks).toEqual([]);
  });

  it('shows a side over the cap as a whole-file replacement', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join('\n');
    const d = diffLines(big, `${big}\nmore`);
    expect(d.replaced).toBe(true);
    expect(d.removed).toBe(MAX_DIFF_LINES + 1);
    expect(d.added).toBe(MAX_DIFF_LINES + 2);
    const small = diffLines('a\nb\nc\nd', 'a\nb', { maxLines: 3 });
    expect(small.replaced).toBe(true);
    expect(small.lines.map((l) => l.kind)).toEqual(['del', 'del', 'del', 'del', 'add', 'add']);
  });

  it('does not replace a file of exactly the cap', () => {
    const exact = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `l${i}`);
    const changed = [...exact];
    changed[100] = 'x';
    const d = diffLines(exact.join('\n'), changed.join('\n'));
    expect(d.replaced).toBe(false);
    expect(d.added).toBe(1);
  });
});

describe('toHunks and pairRows', () => {
  it('returns no hunk for unchanged lines', () => {
    expect(toHunks([{ kind: 'context', oldNo: 1, newNo: 1, text: 'a' }])).toEqual([]);
  });

  it('pairs removals with the additions after them', () => {
    const d = diffLines('a\nb\nc\nd', 'a\nx\ny\nz\nd');
    const rows = pairRows(d.hunks[0]?.lines ?? []);
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['a', 'a'],
      ['b', 'x'],
      ['c', 'y'],
      [null, 'z'],
      ['d', 'd'],
    ]);
  });

  it('finds the first changed line to open the editor at', () => {
    expect(firstChangedLine(diffLines('a\nb\nc', 'a\nb\nX'))).toBe(3);
    expect(firstChangedLine(diffLines('a\nb\nc', 'a\nc'))).toBe(2);
    expect(firstChangedLine(diffLines('a', 'a'))).toBeUndefined();
  });
});
