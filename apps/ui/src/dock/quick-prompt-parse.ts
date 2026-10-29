/**
 * The goal line's rules (plan FD-14 as amended by the product review, M9k.7). The desktop Notch's
 * line creates goals and nothing else: the nine command words it once understood (pause, resume,
 * halt, status, approve, deny, open, start, goal) are buttons in the same card or one click away,
 * and a product whose point is "no terminal" carries no second command language (review §4, owner
 * decision 4). The status sentence those commands produced lives on in the header's Running count
 * tooltip and the tray's tooltip: `statusSentence` in `notch/derive.ts`, beside the list it counts.
 *
 * Pure: no DOM.
 */
import { GOAL_LIMITS } from '../panels/new-goal.js';

export type GoalLine =
  | { kind: 'empty' }
  /** A goal to offer: "Create a goal: <text>? Press Enter". */
  | { kind: 'goal'; text: string }
  | { kind: 'invalid'; message: string };

export const EMPTY_HINT = 'Type what you want done, then press Enter.';

/** One line of the goal field: trimmed, and within the length a goal's request may have. */
export function goalLine(input: string): GoalLine {
  const text = input.trim();
  if (!text) return { kind: 'empty' };
  const n = Array.from(text).length;
  if (n < GOAL_LIMITS.requestMin) {
    return { kind: 'invalid', message: `Describe the goal in at least ${GOAL_LIMITS.requestMin} characters.` };
  }
  if (n > GOAL_LIMITS.requestMax) {
    return {
      kind: 'invalid',
      message: `A goal is at most ${GOAL_LIMITS.requestMax} characters here; New goal in the Studio takes the rest.`,
    };
  }
  return { kind: 'goal', text };
}
