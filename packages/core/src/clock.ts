import { performance } from 'node:perf_hooks';

export interface Clock {
  /** ISO-8601 UTC timestamp. Informational only: event order comes from `sequence`. */
  now(): string;
  /** Milliseconds since the Unix epoch, for lease arithmetic. */
  nowMs(): number;
  /** Monotonic milliseconds, for measuring durations. */
  monotonicMs(): number;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
  nowMs: () => Date.now(),
  monotonicMs: () => performance.now(),
};

/** Adds milliseconds to an ISO timestamp. */
export function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}
