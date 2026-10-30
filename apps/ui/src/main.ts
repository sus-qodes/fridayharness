/**
 * The Studio page (plan FD-03): in a browser tab it signs in by the one-time link and draws the
 * Notch in the page; in the desktop shell the desktop entry takes over.
 */
import './styles/tokens.css';
import './styles/base.css';
import './styles/forms.css';
import './styles/shell.css';
import './styles/canvas.css';
import './styles/nodes.css';
import './styles/drawers.css';
import './styles/governance.css';
import './styles/dock.css';
import './styles/panels.css';
import './styles/notch.css';
import './styles/mascot.css';
import './styles/tour.css';
import './styles/hub.css';
import { studioAreas } from './areas.js';
import { initAudio } from './audio/index.js';
import { bootBrowser } from './shell/app.js';

const root = document.getElementById('app');
if (root) {
  if ('__TAURI_INTERNALS__' in window) {
    // The desktop Studio window: no login, no in-page Notch, no sounds (plan §7.8).
    void import('./desktop/boot.js').then((m) => m.bootDesktopStudio(root));
  } else {
    // In a browser the audio starts on the first gesture (plan §7.10).
    initAudio();
    void bootBrowser(root, studioAreas());
  }
}
