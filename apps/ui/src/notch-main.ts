/**
 * The Notch window of the desktop shell (plan FD-03, §8.1). Opened in a browser it only points to
 * the Studio, which draws the Notch inside its own page there.
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/forms.css';
import './styles/shell.css';
import './styles/governance.css';
import './styles/dock.css';
import './styles/notch.css';
import './styles/mascot.css';
import { h, replace } from './ui/dom.js';

const root = document.getElementById('app');
if (root) {
  if ('__TAURI_INTERNALS__' in window) {
    void import('./desktop/boot.js').then((m) => m.bootDesktopNotch(root));
  } else {
    replace(
      root,
      h(
        'main',
        { class: 'sh-login' },
        h('h1', null, 'Friday'),
        h('p', null, "This page is the desktop app's Notch window. In a browser, the Notch is part of the Studio."),
        h('p', null, 'Open the Studio from this address without "notch.html".'),
      ),
    );
  }
}
