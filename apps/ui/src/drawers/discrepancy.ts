/**
 * The diff drawer's discrepancy banner (plan §7.4, handoff Part 05 §3): paths the agent's completion
 * claim lists that Friday did not see change, and changes Friday saw that the claim does not list.
 * Friday "saw" a path when its hooks observed it (`run.observed_paths`) or the task diff contains
 * it. Pure; no DOM.
 */
import { normalizePath } from './glob.js';

export interface Discrepancies {
  claimedNotSeen: string[];
  seenNotClaimed: string[];
}

/** The claim's `changed_paths`; null when the run has no claim yet. */
export function claimedPaths(claim: unknown): string[] | null {
  if (!claim || typeof claim !== 'object') return null;
  const paths = (claim as { changed_paths?: unknown }).changed_paths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/** Null when there is no claim to compare with. */
export function discrepancies(
  claim: unknown,
  observed: readonly string[],
  diffPaths: readonly string[] = [],
): Discrepancies | null {
  const claimed = claimedPaths(claim);
  if (claimed === null) return null;
  const claimedSet = new Set(claimed.map(normalizePath));
  const seen = new Set([...observed, ...diffPaths].map(normalizePath).filter(Boolean));
  return {
    claimedNotSeen: [...claimedSet].filter((p) => p && !seen.has(p)).sort(),
    seenNotClaimed: [...seen].filter((p) => !claimedSet.has(p)).sort(),
  };
}

export function hasDiscrepancy(d: Discrepancies | null): boolean {
  return !!d && (d.claimedNotSeen.length > 0 || d.seenNotClaimed.length > 0);
}
