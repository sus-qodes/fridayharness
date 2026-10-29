/**
 * `AppContext.act` (plan §7.1): every user action that calls the daemon runs through here, so a
 * failure always shows what was attempted plus Friday's error code and message, and a success
 * shows a short confirmation when the caller gives one. It never throws.
 */
import { ApiError, OfflineError } from '../platform/transport.js';
import { cleanText, truncate } from '../ui/format.js';
import type { AppContext, Toast } from './context.js';

/** What a failed action says when the daemon could not be reached at all. */
export const OFFLINE_DETAIL = 'Friday is not reachable';

const DETAIL_MAX = 400;

/** The second line of an error toast: `<code>: <message>` for Friday's errors. */
export function errorDetail(e: unknown): string {
  if (e instanceof ApiError) return truncate(cleanText(`${e.code}: ${e.message}`), DETAIL_MAX);
  if (e instanceof OfflineError) return OFFLINE_DETAIL;
  if (e instanceof Error && e.message) return truncate(cleanText(e.message), DETAIL_MAX);
  return 'something went wrong';
}

export function makeAct(toast: (t: Toast) => void): AppContext['act'] {
  return async <T>(
    label: string,
    call: () => Promise<T>,
    success?: string | ((r: T) => string),
  ): Promise<T | undefined> => {
    let result: T;
    try {
      result = await call();
    } catch (e) {
      toast({ kind: 'error', text: label, detail: errorDetail(e) });
      return undefined;
    }
    if (success !== undefined) {
      let text: string | null = null;
      try {
        text = typeof success === 'function' ? success(result) : success;
      } catch {
        text = null;
      }
      if (text) toast({ kind: 'success', text });
    }
    return result;
  };
}
