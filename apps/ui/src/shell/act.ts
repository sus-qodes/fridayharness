/**
 * `AppContext.act` (plan §7.1): every user action that calls the daemon runs through here, so a
 * failure always shows what was attempted plus Friday's error code and message, and a success
 * shows a short confirmation when the caller gives one. It never throws.
 */
import { DIALOG_CANCELLED } from '../platform/desktop-platform.js';
import { ApiError, OfflineError } from '../platform/transport.js';
import { cleanText, truncate } from '../ui/format.js';
import type { AppContext, Toast } from './context.js';

/** What a failed action says when the daemon could not be reached at all. */
export const OFFLINE_DETAIL = 'Friday is not reachable';

const DETAIL_MAX = 400;

/**
 * The person closed the desktop shell's own confirmation with Cancel (`confirm_and_send`, and the
 * shell's dialogs): nothing was done and nothing went wrong, so no toast says "error".
 */
export function isCancelled(e: unknown): boolean {
  return e instanceof ApiError && e.code === DIALOG_CANCELLED;
}

/**
 * Friday's refusals name the terminal command for what they suggest, in brackets: `Reject it
 * ("friday plan reject") and ask for a new one ("friday goal replan").` The sentence stands without
 * them, and the interface has a button for each (2026-11-17): the brackets are left out. A command
 * that is part of the sentence itself stays.
 */
export function withoutCommands(text: string): string {
  return text.replace(/\s*\("friday [^"\n]{0,200}"\)/g, '');
}

/**
 * The second line of an error toast: what went wrong, then Friday's code for it in brackets. The
 * code led the line ("COS-2002: approval is already granted"), so a person read the code first
 * (2026-11-17); it stays, last, for whoever reports the error.
 */
export function errorDetail(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.code ? ` (${cleanText(e.code)})` : '';
    return `${truncate(withoutCommands(cleanText(e.message)), DETAIL_MAX - Array.from(code).length)}${code}`;
  }
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
      if (!isCancelled(e)) toast({ kind: 'error', text: label, detail: errorDetail(e) });
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
