/**
 * Tests only: a 2D context that records every call and property set, so drawing code can be
 * checked without a canvas implementation (happy-dom has none).
 */
import type { Ctx2D } from './character.js';

export interface Recorded {
  calls: { name: string; args: unknown[] }[];
  sets: { name: string; value: unknown }[];
}

export function recordingContext(): { g: Ctx2D; log: Recorded } {
  const log: Recorded = { calls: [], sets: [] };
  const values: Record<string, unknown> = {};
  const gradient = () => ({
    addColorStop: (...args: unknown[]) => {
      log.calls.push({ name: 'addColorStop', args });
    },
  });
  const proxy = new Proxy(values, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return (...args: unknown[]) => {
          log.calls.push({ name: prop, args });
          return gradient();
        };
      }
      return (...args: unknown[]) => {
        log.calls.push({ name: prop, args });
      };
    },
    set(target, prop, value) {
      if (typeof prop !== 'string') return false;
      target[prop] = value;
      log.sets.push({ name: prop, value });
      return true;
    },
  });
  return { g: proxy as unknown as Ctx2D, log };
}

/** Every number passed to the context, and every number set on it. */
export function numbersOf(log: Recorded): number[] {
  const out: number[] = [];
  for (const c of log.calls) for (const a of c.args) if (typeof a === 'number') out.push(a);
  for (const s of log.sets) if (typeof s.value === 'number') out.push(s.value);
  return out;
}
