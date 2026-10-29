/**
 * The palette's fuzzy scorer (plan §7.6): every character of the query must appear in the text in
 * order (a subsequence, case-insensitive). Matches score more at the start of the text, at the start
 * of a word (after a separator or at a camel-case or letter-to-digit boundary) and when they follow
 * each other; gaps between matches cost a little. The best alignment is found by dynamic
 * programming, so a word start later in the text beats a scattered match early in it.
 *
 * Pure: no DOM, no clock.
 */

export interface FuzzyMatch {
  score: number;
  /** Code-point indices of the matched characters in the text (for highlighting). */
  indices: number[];
}

/** Scores are compared, never shown; the values only need to order matches sensibly. */
export const SCORE = {
  match: 16,
  start: 10,
  word: 8,
  camel: 7,
  consecutive: 8,
  gapStart: 3,
  gapExtension: 1,
} as const;

/** Only the head of a long text is scored (agent text can be thousands of characters). */
export const MAX_TEXT = 200;
export const MAX_QUERY = 64;

const SEPARATOR = /[\s_\-./\\:#()[\]{}'"`,;|@+=<>!?*&^%$~]/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;

const NONE = Number.NEGATIVE_INFINITY;

function boundaryBonus(prev: string | undefined, ch: string): number {
  if (prev === undefined) return SCORE.start;
  if (SEPARATOR.test(prev)) return SEPARATOR.test(ch) ? 0 : SCORE.word;
  if (LOWER.test(prev) && UPPER.test(ch)) return SCORE.camel;
  if (LETTER.test(prev) && DIGIT.test(ch)) return SCORE.camel;
  return 0;
}

/** True when `query` (already lower-cased, as code points) is a subsequence of `text`. */
function isSubsequence(query: string[], text: string[]): boolean {
  let i = 0;
  for (const ch of text) {
    if (ch === query[i]) i += 1;
    if (i === query.length) return true;
  }
  return i === query.length;
}

/**
 * Matches `query` against `text`; null when the query is not a subsequence of the text. Spaces in
 * the query are ignored (so "code graph" matches "Code graph" and "codegraph"). An empty query
 * matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = Array.from(query.replace(/\s+/gu, '').toLowerCase()).slice(0, MAX_QUERY);
  if (q.length === 0) return { score: 0, indices: [] };
  const original = Array.from(text).slice(0, MAX_TEXT);
  const t = original.map((c) => c.toLowerCase());
  const n = t.length;
  const m = q.length;
  if (m > n || !isSubsequence(q, t)) return null;

  const bonus = new Float64Array(n);
  for (let j = 0; j < n; j++) bonus[j] = boundaryBonus(original[j - 1], original[j] as string);

  // score[i][j]: best score with query character i matched at text position j.
  // from[i][j]: the text position query character i - 1 was matched at (-1 for i = 0).
  const score: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(NONE);
    const back = new Int32Array(n).fill(-1);
    const qc = q[i];
    if (i === 0) {
      for (let j = 0; j < n; j++) if (t[j] === qc) row[j] = SCORE.match + (bonus[j] as number);
    } else {
      const prev = score[i - 1] as Float64Array;
      // best[j]: max over k <= j - 2 of prev[k] minus the gap penalty for the j - k - 1 skipped characters.
      let best = NONE;
      let bestAt = -1;
      for (let j = 1; j < n; j++) {
        if (j >= 2) {
          const k = j - 2;
          const opened = (prev[k] as number) - SCORE.gapStart;
          const extended = best - SCORE.gapExtension;
          if (opened >= extended) {
            best = opened;
            bestAt = k;
          } else {
            best = extended;
          }
        }
        if (t[j] !== qc) continue;
        const adjacent = prev[j - 1] as number;
        const viaAdjacent = adjacent === NONE ? NONE : adjacent + SCORE.consecutive;
        const base = SCORE.match + (bonus[j] as number);
        if (viaAdjacent >= best && viaAdjacent !== NONE) {
          row[j] = base + viaAdjacent;
          back[j] = j - 1;
        } else if (best !== NONE) {
          row[j] = base + best;
          back[j] = bestAt;
        }
      }
    }
    score.push(row);
    from.push(back);
  }

  const last = score[m - 1] as Float64Array;
  let end = -1;
  let top = NONE;
  for (let j = 0; j < n; j++) {
    if ((last[j] as number) > top) {
      top = last[j] as number;
      end = j;
    }
  }
  if (end < 0 || top === NONE) return null;

  const indices: number[] = new Array(m);
  let j = end;
  for (let i = m - 1; i >= 0; i--) {
    indices[i] = j;
    j = (from[i] as Int32Array)[j] as number;
  }
  return { score: top, indices };
}

/** The score alone; null when there is no match. */
export function fuzzyScore(query: string, text: string): number | null {
  return fuzzyMatch(query, text)?.score ?? null;
}

/**
 * Splits `text` into runs of matched and unmatched characters for highlighting:
 * `[{text: 'Co', hit: true}, {text: 'de ', hit: false}, …]`.
 */
export function segments(text: string, indices: readonly number[]): { text: string; hit: boolean }[] {
  const chars = Array.from(text);
  const hits = new Set(indices);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const hit = hits.has(i);
    const tail = out[out.length - 1];
    if (tail && tail.hit === hit) tail.text += chars[i];
    else out.push({ text: chars[i] as string, hit });
  }
  return out;
}
