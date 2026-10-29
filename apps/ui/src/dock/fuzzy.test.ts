import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyScore, MAX_TEXT, segments } from './fuzzy.js';

function order(query: string, texts: string[]): string[] {
  return texts
    .map((t) => ({ t, s: fuzzyScore(query, t) }))
    .filter((x): x is { t: string; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.t);
}

describe('fuzzyMatch', () => {
  it('matches a subsequence, case-insensitively, and refuses anything else', () => {
    expect(fuzzyMatch('pse', 'Pause')).not.toBeNull();
    expect(fuzzyMatch('PAUSE', 'pause friday')).not.toBeNull();
    expect(fuzzyMatch('pause', 'Prune clean worktrees')).toBeNull();
    expect(fuzzyMatch('ba', 'ab')).toBeNull();
    expect(fuzzyMatch('abc', 'ab')).toBeNull();
  });

  it('matches everything with score 0 for an empty or blank query', () => {
    expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, indices: [] });
    expect(fuzzyMatch('   ', 'anything')).toEqual({ score: 0, indices: [] });
  });

  it('ignores spaces in the query', () => {
    expect(fuzzyMatch('code graph', 'codegraph')).not.toBeNull();
    expect(fuzzyMatch('code graph', 'Code graph')?.indices).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);
  });

  it('returns the indices of the matched characters', () => {
    expect(fuzzyMatch('rf', 'Resume Friday')?.indices).toEqual([0, 7]);
    expect(fuzzyMatch('dock', 'the dock')?.indices).toEqual([4, 5, 6, 7]);
  });

  it('ranks a prefix above a match inside a word', () => {
    expect(order('res', ['Pressure test', 'Resume Friday'])).toEqual(['Resume Friday', 'Pressure test']);
  });

  it('ranks word starts above scattered letters', () => {
    expect(order('cg', ['chunking', 'Code graph'])).toEqual(['Code graph', 'chunking']);
    expect(order('pcw', ['Prune clean worktrees', 'pricewatch'])).toEqual(['Prune clean worktrees', 'pricewatch']);
  });

  it('ranks consecutive characters above the same letters spread out', () => {
    expect(order('graph', ['g-r-a-p-h', 'graph.ts', 'great alpha'])[0]).toBe('graph.ts');
    expect(order('mem', ['Memory bank', 'make every move'])).toEqual(['Memory bank', 'make every move']);
  });

  it('finds the best alignment, not the first one', () => {
    // A greedy match would take the "g" and "r" of "progress"; the word "graph" scores more.
    const m = fuzzyMatch('gra', 'progress graph');
    expect(m?.indices).toEqual([9, 10, 11]);
  });

  it('gives camel-case and digit boundaries a bonus', () => {
    expect(order('ti', ['taskInspector', 'tidy'])[0]).toBe('tidy');
    expect(fuzzyScore('tI', 'taskInspector')).toBeGreaterThan(fuzzyScore('ti', 'tableitem') ?? 0);
    // A digit after a letter starts a "word"; a digit after a digit does not.
    expect(fuzzyScore('2', 'v2')).toBeGreaterThan(fuzzyScore('2', '12') ?? Number.POSITIVE_INFINITY);
  });

  it('scores only the head of a very long text', () => {
    const long = `${'x'.repeat(MAX_TEXT)}needle`;
    expect(fuzzyMatch('needle', long)).toBeNull();
    expect(fuzzyMatch('xx', 'x'.repeat(5000))).not.toBeNull();
  });

  it('counts by code points (no split surrogate pairs)', () => {
    const m = fuzzyMatch('ab', '😀a😀b');
    expect(m?.indices).toEqual([1, 3]);
  });
});

describe('segments', () => {
  it('splits text into matched and unmatched runs', () => {
    expect(segments('Code graph', [0, 1, 5])).toEqual([
      { text: 'Co', hit: true },
      { text: 'de ', hit: false },
      { text: 'g', hit: true },
      { text: 'raph', hit: false },
    ]);
    expect(segments('abc', [])).toEqual([{ text: 'abc', hit: false }]);
    expect(segments('', [])).toEqual([]);
  });
});
