/**
 * The connection to Friday as people see it (plan §7.1): one pure description of the daemon state
 * (the header's dot reads it) and the connection strip under the header, which says what is
 * happening while the page is not live: reconnect attempts, "Friday is stopping", "not reachable
 * here", a session that ended, and the errors the sync engine reported.
 */
import type { Connection, FridayStore, SystemState } from '../store/state.js';
import { STALE_PAGE_MESSAGE, STOPPING_MESSAGE, UNREACHABLE_MESSAGE } from '../sync/sync-engine.js';
import { button, h, setText } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import type { Component } from './context.js';

/** The header dot's states (plan §7.1), plus a session that ended. */
export type DaemonState = 'connected' | 'reconnecting' | 'offline' | 'stopping' | 'stopped' | 'signed-out';

export interface ConnectionView {
  state: DaemonState;
  /** A word or two for the dot. */
  label: string;
  /** What the strip says; null when it has nothing to say. */
  message: string | null;
  /** A second line (the last error), when it adds something. */
  detail: string | null;
  /** The strip offers "Try again". */
  retry: boolean;
}

/** Reconnect attempts after which a still-failing connection reads as "offline". */
export const OFFLINE_AFTER_ATTEMPTS = 3;

export const SIGNED_OUT_MESSAGE =
  'Your session ended: Friday restarted, you logged out, or 12 hours passed. Open Friday again from its shortcut or the desktop app.';

function detailOf(system: SystemState, except: (string | null)[]): string | null {
  const e = system.lastError;
  if (!e || except.includes(e)) return null;
  return truncate(cleanText(e), 300);
}

export function connectionView(system: SystemState): ConnectionView {
  const c: Connection = system.connection;
  if (c === 'signed-out') {
    return { state: 'signed-out', label: 'Signed out', message: SIGNED_OUT_MESSAGE, detail: null, retry: false };
  }
  if (c === 'stopped') {
    return {
      state: 'stopped',
      label: 'Stopped',
      message:
        system.lastError && system.lastError !== STALE_PAGE_MESSAGE ? cleanText(system.lastError) : UNREACHABLE_MESSAGE,
      detail: null,
      retry: true,
    };
  }
  if (system.lastError === STOPPING_MESSAGE) {
    return { state: 'stopping', label: 'Stopping', message: `${STOPPING_MESSAGE}.`, detail: null, retry: false };
  }
  if (c === 'live') {
    const detail = detailOf(system, [STALE_PAGE_MESSAGE]);
    return {
      state: 'connected',
      label: 'Connected',
      message: detail ? 'Friday is connected, but the last read of the board failed.' : null,
      detail,
      retry: false,
    };
  }
  if (c === 'starting' || c === 'connecting') {
    return { state: 'reconnecting', label: 'Connecting', message: 'Connecting to Friday…', detail: null, retry: false };
  }
  // reconnecting
  const attempt = system.attempts;
  const offline = attempt >= OFFLINE_AFTER_ATTEMPTS;
  return {
    state: offline ? 'offline' : 'reconnecting',
    label: offline ? 'Offline' : 'Reconnecting',
    message: attempt > 0 ? `Reconnecting to Friday (attempt ${attempt})…` : 'Reconnecting to Friday…',
    detail: detailOf(system, [STALE_PAGE_MESSAGE]),
    retry: false,
  };
}

export interface StripOptions {
  /** "Try again" after Friday stopped or was not reachable. */
  onRetry?: () => void;
}

/** The connection strip: hidden while live and well. */
export function mountConnectionStrip(store: FridayStore, opts: StripOptions = {}): Component {
  const text = h('span', { class: 'sh-strip-text' });
  const detail = h('span', { class: 'sh-strip-detail mono' });
  const retry = button('Try again', () => opts.onRetry?.(), { class: 'btn sh-strip-retry' });
  const el = h(
    'div',
    { class: 'sh-strip', role: 'status', aria: { live: 'polite' }, hidden: true },
    h('span', { class: 'sh-strip-dot', aria: { hidden: true } }),
    h('span', { class: 'sh-strip-body' }, text, detail),
    retry,
  );

  function render(system: SystemState): void {
    const v = connectionView(system);
    el.hidden = !v.message;
    el.dataset.state = v.state;
    setText(text, v.message ?? '');
    setText(detail, v.detail ?? '');
    detail.hidden = !v.detail;
    retry.hidden = !(v.retry && opts.onRetry);
  }

  const unsubscribe = store.subscribe('system', (next) => render(next));
  render(store.select('system'));
  return {
    el,
    destroy() {
      unsubscribe();
      el.remove();
    },
  };
}
