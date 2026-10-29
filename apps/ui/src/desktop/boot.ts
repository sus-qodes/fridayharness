/**
 * The desktop windows' entry (plan §8): placeholder until the Tauri transport lands; the Studio
 * and Notch windows boot here with the desktop shell as their only client of the daemon.
 */
import { h, replace } from '../ui/dom.js';

function notYet(root: HTMLElement, what: string): void {
  replace(
    root,
    h(
      'main',
      { class: 'sh-login' },
      h('h1', null, 'Friday'),
      h('p', null, `${what} is not available in this build yet.`),
    ),
  );
}

export async function bootDesktopStudio(root: HTMLElement): Promise<void> {
  notYet(root, 'The desktop Studio');
}

export async function bootDesktopNotch(root: HTMLElement): Promise<void> {
  notYet(root, 'The desktop Notch');
}
