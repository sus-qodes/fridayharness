/**
 * The screens shown instead of the Studio (plan §7.1, FD-05): no session in this tab, a link that
 * was already used or has expired, a leftover service worker that was removed, Friday not
 * reachable, Friday stopped, and a session that ended. Each says what to do next in plain words;
 * every one mentions that a session lasts at most 12 hours. Nothing here calls the daemon.
 */
import { visible } from '../model/text.js';
import { UNREACHABLE_MESSAGE } from '../sync/sync-engine.js';
import { button, h } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import type { Component } from './context.js';
import { productMark } from './mark.js';

export type LoginReason =
  | 'no-session'
  | 'used-link'
  | 'sw-removed'
  | 'unreachable'
  | 'stopped'
  | 'signed-out'
  | 'error';

export const NO_SESSION_MESSAGE = 'Open Friday from its shortcut or the desktop app, or run friday ui in the project.';
export const USED_LINK_MESSAGE = 'This link was already used or has expired; open Friday again.';
export const SW_REMOVED_MESSAGE = 'Friday removed a leftover service worker for this address; open Friday again.';
export const STOPPED_MESSAGE = 'Friday stopped. Open it again from its shortcut or the desktop app.';
export const SESSION_ENDED_MESSAGE =
  'Your session ended: Friday restarted, you logged out, or 12 hours passed. Open Friday again from its shortcut or the desktop app.';
export const SESSION_NOTE =
  'A sign-in link works once, for one minute. The session it starts lasts at most 12 hours and ends when Friday restarts or you log out; each tab signs in with its own link.';

export interface LoginCopy {
  title: string;
  message: string;
  /** A command to type, shown monospaced (only for "no session"). */
  command: string | null;
}

/** What a screen says (pure; the tests read it). */
export function loginCopy(reason: LoginReason): LoginCopy {
  switch (reason) {
    case 'no-session':
      return { title: 'Sign in to Friday', message: NO_SESSION_MESSAGE, command: 'friday ui' };
    case 'used-link':
      return { title: 'This link cannot be used', message: USED_LINK_MESSAGE, command: null };
    case 'sw-removed':
      return { title: 'Friday cleaned up this address', message: SW_REMOVED_MESSAGE, command: null };
    case 'unreachable':
      return { title: 'Friday is not reachable', message: `${UNREACHABLE_MESSAGE}.`, command: null };
    case 'stopped':
      return { title: 'Friday stopped', message: STOPPED_MESSAGE, command: null };
    case 'signed-out':
      return { title: 'Your session ended', message: SESSION_ENDED_MESSAGE, command: null };
    default:
      return {
        title: 'Friday could not start this page',
        message: 'Open Friday again from its shortcut or the desktop app.',
        command: null,
      };
  }
}

export interface LoginScreenOptions {
  /** The project, when this page knows it (shown with hidden characters made visible). */
  projectName?: string | null;
  /** A second line: the error code and message of what failed. */
  detail?: string | null;
  /** Offers a button (Reload, Try again). */
  action?: { label: string; run: () => void } | null;
}

export function loginScreen(reason: LoginReason, opts: LoginScreenOptions = {}): Component {
  const copy = loginCopy(reason);
  const project = opts.projectName ? visible(truncate(cleanText(String(opts.projectName)), 120)) : null;
  const detail = opts.detail ? truncate(cleanText(String(opts.detail)), 400) : null;
  const message =
    copy.command !== null
      ? h(
          'p',
          { class: 'sh-login-message' },
          'Open Friday from its shortcut or the desktop app, or run ',
          h('code', { class: 'sh-login-command' }, copy.command),
          ' in the project',
          project ? [' ', h('strong', { class: 'sh-login-project' }, project)] : null,
          '.',
        )
      : h('p', { class: 'sh-login-message' }, copy.message);
  const card = h(
    'section',
    {
      class: ['sh-login-card', 'glass-panel'],
      role: reason === 'no-session' ? 'region' : 'alert',
      aria: { labelledby: 'sh-login-title' },
      dataset: { reason },
    },
    h(
      'div',
      { class: 'sh-login-brand' },
      productMark(40, 'sh-login-mark'),
      h('span', { class: 'sh-login-name' }, 'Friday'),
    ),
    h('h1', { class: 'sh-login-title', id: 'sh-login-title' }, copy.title),
    project && copy.command === null
      ? h('p', { class: 'sh-login-for muted' }, 'Project ', h('strong', null, project))
      : null,
    message,
    detail ? h('p', { class: 'sh-login-detail mono' }, detail) : null,
    opts.action
      ? button(opts.action.label, () => opts.action?.run(), { class: 'btn btn-primary sh-login-action' })
      : null,
    h('p', { class: 'sh-login-note muted' }, SESSION_NOTE),
  );
  const el = h('main', { class: 'sh-login' }, card);
  return {
    el,
    destroy() {
      el.remove();
    },
  };
}
