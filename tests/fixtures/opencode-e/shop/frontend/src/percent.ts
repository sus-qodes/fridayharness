/** A fraction as a percentage with at most one decimal: 0.1 gives "10%", 0.125 gives "12.5%", 1 gives "100%". */
export function percentLabel(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}
