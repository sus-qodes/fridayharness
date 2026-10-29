/**
 * What a live check must have shown, as a verdict (review M8-R07). A live case is a gate: it passes
 * only when every behaviour it names was observed. A case that did not run, because an earlier case
 * of the run failed or the approved turns would not cover it, is incomplete, which is never a pass.
 * The verdict is saved with the run's evidence; the case then fails unless it passed.
 */
export interface Verdict {
  status: 'passed' | 'failed' | 'incomplete';
  /** What was required and not observed. */
  missing: string[];
  /** Why a case did not run. */
  reason?: string;
}

/** The verdict of a case that ran: each requirement, by name, observed or not. */
export function verdict(required: Record<string, boolean>): Verdict {
  const missing = Object.entries(required)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return { status: missing.length ? 'failed' : 'passed', missing };
}

/** The verdict of a case that did not run. */
export function incomplete(reason: string): Verdict {
  return { status: 'incomplete', missing: [], reason };
}

/**
 * The turns a run may still start, and whether a case may start: the owner approves a number of
 * turns for the run, and a case that failed keeps the rest of them unspent.
 */
export class LiveBudget {
  #spent = 0;
  #failed: string | null = null;

  constructor(readonly approved: number) {}

  get spent(): number {
    return this.#spent;
  }

  /** Null when a case needing `turns` may start, else why it may not. */
  refuse(turns: number): string | null {
    if (this.#failed) return `not run: the ${this.#failed} case did not pass, so the rest of the budget is kept`;
    if (this.#spent + turns > this.approved) {
      return `not run: it needs ${turns} turn(s), and ${this.approved - this.#spent} of the ${this.approved} approved are left`;
    }
    return null;
  }

  /** Records a case's turns and outcome. */
  settle(name: string, turns: number, v: Verdict): void {
    this.#spent += turns;
    if (v.status !== 'passed' && !this.#failed) this.#failed = name;
  }
}
