import type { FridayError } from '@friday/protocol';

export type Result<T> = { ok: true; value: T } | { ok: false; error: FridayError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const err = <T = never>(error: FridayError): Result<T> => ({ ok: false, error });

/** Returns the value or throws the error. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}
