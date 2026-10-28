import { encodeBase32, type Id, type IdPrefix, newId } from '@friday/protocol';

export interface IdGenerator {
  next<P extends IdPrefix>(prefix: P): Id<P>;
}

export const randomIds: IdGenerator = { next: newId };

/**
 * Deterministic ids for tests and replay comparisons: the suffix encodes a counter,
 * so ids are valid, ordered and identical across runs.
 */
export function sequentialIds(start = 1): IdGenerator {
  let n = BigInt(start);
  return {
    next<P extends IdPrefix>(prefix: P): Id<P> {
      const bytes = new Uint8Array(16);
      let v = n;
      for (let i = 15; i >= 0 && v > 0n; i -= 1) {
        bytes[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      n += 1n;
      return `${prefix}_${encodeBase32(bytes)}`;
    },
  };
}
