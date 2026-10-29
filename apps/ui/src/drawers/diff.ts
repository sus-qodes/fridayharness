/**
 * The line diff of the diff drawer (plan §7.4, FD-11): the daemon sends both sides of every changed
 * file and the page computes the lines that differ. Myers' O(ND) algorithm in its linear-space form
 * (the middle snake, split recursively), bounded: a side of more than `MAX_DIFF_LINES` lines is
 * shown as a whole-file replacement instead. Pure; no DOM.
 */

export const MAX_DIFF_LINES = 5000;
export const DEFAULT_CONTEXT = 3;

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number on the old side; null for an added line. */
  oldNo: number | null;
  /** 1-based line number on the new side; null for a removed line. */
  newNo: number | null;
  text: string;
  /** The last line of a side that does not end in a newline (git's "\ No newline at end of file"). */
  noNewline?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface LineDiff {
  /** Every line of both sides in order: unchanged, removed and added. */
  lines: DiffLine[];
  /** The changed regions with `context` unchanged lines around them. */
  hunks: Hunk[];
  added: number;
  removed: number;
  /** A side was over the bound: everything old is removed and everything new added. */
  replaced: boolean;
  identical: boolean;
}

/** One step of an edit script: an unchanged line, a removed old line or an added new line. */
export type Edit = { op: 'eq'; a: number; b: number } | { op: 'del'; a: number } | { op: 'ins'; b: number };

/**
 * A text's lines: split at `\n`, a trailing `\r` dropped from each line, and no empty last line
 * for a final newline (`endsInNewline` says whether there was one). `null` (no such side: an added
 * or deleted file) has no lines.
 */
export function splitLines(text: string | null | undefined): string[] {
  if (text === null || text === undefined || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Whether a text ends in a newline; its `splitLines` look the same either way. */
export function endsInNewline(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.endsWith('\n');
}

/**
 * The lines as the diff compares them. A last line without a final newline is not the same line as
 * that text with one: git counts adding or removing the final newline as a change of the last line.
 * No line holds `\n`, so the marked key cannot equal a real line.
 */
function compareKeys(lines: readonly string[], finalNewline: boolean): readonly string[] {
  if (finalNewline || lines.length === 0) return lines;
  const keys = [...lines];
  keys[keys.length - 1] = `${keys[keys.length - 1]}\n`;
  return keys;
}

/** Maps equal lines to equal integers, so the algorithm compares numbers. */
function intern(a: readonly string[], b: readonly string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const map = (lines: readonly string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      let id = ids.get(line);
      if (id === undefined) {
        id = ids.size;
        ids.set(line, id);
      }
      out[i] = id;
    }
    return out;
  };
  return [map(a), map(b)];
}

/**
 * The middle snake of `a[aLo, aHi)` against `b[bLo, bHi)`: a point where a shortest edit path
 * crosses, found by searching forward and backward at once (Myers 1986, §4b). Returns the absolute
 * split point, or null when the ranges share nothing.
 */
function bisect(
  a: Int32Array,
  b: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): [number, number] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD;
  const size = 2 * maxD + 2;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[offset + 1] = 0;
  v2[offset + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = offset + k1;
      let x1: number;
      if (k1 === -d || (k1 !== d && (v1[k1o - 1] as number) < (v1[k1o + 1] as number))) x1 = v1[k1o + 1] as number;
      else x1 = (v1[k1o - 1] as number) + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = offset + delta - k1;
        if (k2o >= 0 && k2o < size && v2[k2o] !== -1) {
          const x2 = n - (v2[k2o] as number);
          if (x1 >= x2) return [aLo + x1, bLo + y1];
        }
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = offset + k2;
      let x2: number;
      if (k2 === -d || (k2 !== d && (v2[k2o - 1] as number) < (v2[k2o + 1] as number))) x2 = v2[k2o + 1] as number;
      else x2 = (v2[k2o - 1] as number) + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aLo + n - x2 - 1] === b[bLo + m - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = offset + delta - k2;
        if (k1o >= 0 && k1o < size && v1[k1o] !== -1) {
          const x1 = v1[k1o] as number;
          const y1 = offset + x1 - k1o;
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

function diffRange(
  a: Int32Array,
  b: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  out: Edit[],
): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
    out.push({ op: 'eq', a: aLo, b: bLo });
    aLo++;
    bLo++;
  }
  let suffix = 0;
  while (aLo < aHi - suffix && bLo < bHi - suffix && a[aHi - 1 - suffix] === b[bHi - 1 - suffix]) suffix++;
  const aEnd = aHi - suffix;
  const bEnd = bHi - suffix;
  if (aLo === aEnd) {
    for (let j = bLo; j < bEnd; j++) out.push({ op: 'ins', b: j });
  } else if (bLo === bEnd) {
    for (let i = aLo; i < aEnd; i++) out.push({ op: 'del', a: i });
  } else {
    const split = bisect(a, b, aLo, aEnd, bLo, bEnd);
    // A split at either end would recurse on the same range: treat it as sharing nothing.
    if (!split || (split[0] === aLo && split[1] === bLo) || (split[0] === aEnd && split[1] === bEnd)) {
      for (let i = aLo; i < aEnd; i++) out.push({ op: 'del', a: i });
      for (let j = bLo; j < bEnd; j++) out.push({ op: 'ins', b: j });
    } else {
      diffRange(a, b, aLo, split[0], bLo, split[1], out);
      diffRange(a, b, split[0], aEnd, split[1], bEnd, out);
    }
  }
  for (let k = 0; k < suffix; k++) out.push({ op: 'eq', a: aEnd + k, b: bEnd + k });
}

/** A shortest edit script turning `a` into `b` (removals of a change before its additions). */
export function myers(a: readonly string[], b: readonly string[]): Edit[] {
  const [ia, ib] = intern(a, b);
  const out: Edit[] = [];
  diffRange(ia, ib, 0, ia.length, 0, ib.length, out);
  return normalizeOrder(out);
}

/** Within each run of changes, removals come first: the classic reading order of a diff. */
function normalizeOrder(edits: Edit[]): Edit[] {
  const out: Edit[] = [];
  let dels: Edit[] = [];
  let ins: Edit[] = [];
  const flush = () => {
    out.push(...dels, ...ins);
    dels = [];
    ins = [];
  };
  for (const e of edits) {
    if (e.op === 'eq') {
      flush();
      out.push(e);
    } else if (e.op === 'del') dels.push(e);
    else ins.push(e);
  }
  flush();
  return out;
}

/** The changed regions of `lines` with `context` unchanged lines around each; touching regions merge. */
export function toHunks(lines: readonly DiffLine[], context = DEFAULT_CONTEXT): Hunk[] {
  const ranges: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as DiffLine).kind === 'context') continue;
    const start = Math.max(0, i - context);
    const end = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  const hunks: Hunk[] = [];
  let cursor = 0;
  let oldSeen = 0;
  let newSeen = 0;
  for (const [start, end] of ranges) {
    for (; cursor < start; cursor++) {
      const l = lines[cursor] as DiffLine;
      if (l.kind !== 'add') oldSeen++;
      if (l.kind !== 'del') newSeen++;
    }
    const slice = lines.slice(start, end + 1);
    const oldLines = slice.filter((l) => l.kind !== 'add').length;
    const newLines = slice.filter((l) => l.kind !== 'del').length;
    hunks.push({
      oldStart: oldLines > 0 ? oldSeen + 1 : oldSeen,
      oldLines,
      newStart: newLines > 0 ? newSeen + 1 : newSeen,
      newLines,
      lines: slice,
    });
  }
  return hunks;
}

/** The line diff of two texts. */
export function diffLines(
  before: string | null | undefined,
  after: string | null | undefined,
  opts: { context?: number; maxLines?: number } = {},
): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);
  // The index of the line that ends its side without a newline, or -1.
  const openA = endsInNewline(before) ? -1 : a.length - 1;
  const openB = endsInNewline(after) ? -1 : b.length - 1;
  const mark = (line: DiffLine, open: boolean): DiffLine => (open ? { ...line, noNewline: true } : line);
  const max = opts.maxLines ?? MAX_DIFF_LINES;
  const replaced = a.length > max || b.length > max;
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  if (replaced) {
    a.forEach((text, i) => {
      lines.push(mark({ kind: 'del', oldNo: i + 1, newNo: null, text }, i === openA));
    });
    b.forEach((text, j) => {
      lines.push(mark({ kind: 'add', oldNo: null, newNo: j + 1, text }, j === openB));
    });
    removed = a.length;
    added = b.length;
  } else {
    for (const e of myers(compareKeys(a, openA < 0), compareKeys(b, openB < 0))) {
      if (e.op === 'eq')
        lines.push(mark({ kind: 'context', oldNo: e.a + 1, newNo: e.b + 1, text: a[e.a] as string }, e.a === openA));
      else if (e.op === 'del') {
        lines.push(mark({ kind: 'del', oldNo: e.a + 1, newNo: null, text: a[e.a] as string }, e.a === openA));
        removed++;
      } else {
        lines.push(mark({ kind: 'add', oldNo: null, newNo: e.b + 1, text: b[e.b] as string }, e.b === openB));
        added++;
      }
    }
  }
  return {
    lines,
    hunks: toHunks(lines, opts.context ?? DEFAULT_CONTEXT),
    added,
    removed,
    replaced,
    identical: added === 0 && removed === 0,
  };
}

/** One row of the side-by-side view. */
export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

/** Pairs a hunk's lines for the side-by-side view: a run of removals faces the additions after it. */
export function pairRows(lines: readonly DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as DiffLine;
    if (line.kind === 'context') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && (lines[i] as DiffLine).kind === 'del') dels.push(lines[i++] as DiffLine);
    while (i < lines.length && (lines[i] as DiffLine).kind === 'add') adds.push(lines[i++] as DiffLine);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}

/** The first changed line on the new side (where "Open in VS Code" lands), else on the old side. */
export function firstChangedLine(diff: LineDiff): number | undefined {
  const add = diff.lines.find((l) => l.kind === 'add');
  if (add?.newNo) return add.newNo;
  const del = diff.lines.find((l) => l.kind === 'del');
  return del?.oldNo ?? undefined;
}
