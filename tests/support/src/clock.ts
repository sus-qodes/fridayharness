/** Same shape as the Clock interface that @friday/core will define in M1. */
export interface Clock {
  /** ISO-8601 UTC timestamp. */
  now(): string;
  /** Monotonic milliseconds, for durations and leases. */
  monotonicMs(): number;
}

/** Deterministic clock for lease, heartbeat and timeout tests. */
export class FakeClock implements Clock {
  #epochMs: number;
  #monotonic = 0;

  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.#epochMs = Date.parse(start);
    if (Number.isNaN(this.#epochMs)) throw new Error(`FakeClock: invalid start time ${start}`);
  }

  now(): string {
    return new Date(this.#epochMs).toISOString();
  }

  monotonicMs(): number {
    return this.#monotonic;
  }

  /** Moves both wall-clock and monotonic time forward. */
  advance(ms: number): this {
    if (ms < 0) throw new Error('FakeClock.advance: time cannot go backwards');
    this.#epochMs += ms;
    this.#monotonic += ms;
    return this;
  }

  /** Sets wall-clock time only (monotonic time never jumps). */
  set(iso: string): this {
    const next = Date.parse(iso);
    if (Number.isNaN(next)) throw new Error(`FakeClock.set: invalid time ${iso}`);
    this.#epochMs = next;
    return this;
  }
}
