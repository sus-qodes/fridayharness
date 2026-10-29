/**
 * Banners under the header (plan §7.1). Friday reads config.yaml again when it changes and applies
 * what it can (plan M11.2), so the config banner shows only when something still waits: it names
 * the changed keys that need a restart ("config.yaml changed: daemon.port needs a restart to
 * apply."), with how to restart from where the person is (the desktop app restarts from the banner
 * or the tray; a browser tab stops Friday in Settings and opens it again from its shortcut), or it
 * says the file as it stands could not be read and that the settings in force are unchanged.
 * "This page is older than Friday; reload it" shows while the snapshot's `ui_api` is not this
 * bundle's; and the slot of the getting-started checklist, shown until it is dismissed (and again
 * if the setting brings it back).
 */
import type { ConfigChanges, UiSnapshot } from '@friday/protocol';
import { STALE_PAGE_MESSAGE } from '../sync/sync-engine.js';
import { button, h } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { type AppContext, type Component, openDrawer } from './context.js';
import { UI_API } from './version.js';

/** How to restart from the desktop app: the button beside this, or the tray. */
export const RESTART_HINT_DESKTOP = 'Restart Friday here, or from the tray.';
/** How to restart from a browser tab, which cannot start Friday itself. */
export const RESTART_HINT_BROWSER =
  'From a browser: stop Friday in Settings → Friday, then open it again from its shortcut or the desktop app.';
/** The file as it stands could not be read; what follows is the daemon's reason. */
export const CONFIG_ERROR_MESSAGE = 'config.yaml could not be read, so Friday keeps the settings it had:';

/** The changed keys of config.yaml that keep their start values until Friday restarts. */
export function configRestartKeys(board: UiSnapshot | null): string[] {
  return board?.config?.changes?.restart_needed ?? [];
}

/** Why config.yaml as it stands could not be read, or null. */
export function configError(board: UiSnapshot | null): string | null {
  return board?.config?.changes?.error ?? null;
}

/** Whether the config banner has something to say: a key that needs a restart, or a file that could not be read. */
export function configChanged(board: UiSnapshot | null): boolean {
  return configRestartKeys(board).length > 0 || configError(board) !== null;
}

/** "a", "a and b", "a, b and c". */
function listKeys(keys: string[]): string {
  if (keys.length <= 1) return keys.join('');
  return `${keys.slice(0, -1).join(', ')} and ${keys[keys.length - 1]}`;
}

/**
 * The banner's sentence for what changed: the keys applied, when any, then the keys that need a
 * restart; or why the file could not be read.
 */
export function configBannerText(changes: ConfigChanges): string {
  if (changes.error !== null) return `${CONFIG_ERROR_MESSAGE} ${changes.error}`;
  const restart = changes.restart_needed;
  if (!restart.length) return '';
  const applied = changes.applied.length ? `${listKeys(changes.applied)} applied; ` : '';
  return `config.yaml changed: ${applied}${listKeys(restart)} ${restart.length === 1 ? 'needs' : 'need'} a restart to apply.`;
}

/** The daemon speaks another interface API than this page. */
export function pageIsStale(board: UiSnapshot | null): boolean {
  return !!board && board.ui_api !== UI_API;
}

function configPath(root: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${sep}.friday${sep}config.yaml`;
}

export interface BannerOptions {
  /** The getting-started checklist (an area's component), shown until dismissed. */
  gettingStarted?: (ctx: AppContext) => Component;
  /** Reloads the page (default `location.reload`). */
  reload?: () => void;
}

export function mountBanners(ctx: AppContext, opts: BannerOptions = {}): Component {
  const reload =
    opts.reload ??
    (() => {
      location.reload();
    });
  const openConfig = button(
    [icon('file', 14), 'Open config.yaml'],
    () => {
      const root = ctx.store.select('board')?.project.root;
      if (root) ctx.platform.openInEditor(configPath(root));
    },
    { class: 'btn btn-ghost sh-banner-action' },
  );
  // The way to restart depends on where the page runs: the desktop app can do it; a browser tab
  // can only stop Friday and say where to start it again.
  const desktop = ctx.platform.desktop;
  let restarting = false;
  const restart = desktop
    ? button(
        [icon('rework', 14), 'Restart Friday'],
        async () => {
          if (restarting) return;
          restarting = true;
          restart.disabled = true;
          try {
            // The shell asks natively first; false means the person cancelled, and nothing is said.
            await ctx.act('Restart Friday', () => desktop.restart());
          } finally {
            restarting = false;
            restart.disabled = false;
          }
        },
        { class: 'btn btn-primary sh-banner-action sh-banner-restart' },
      )
    : button('Open Settings', () => openDrawer(ctx, { kind: 'settings', tab: 'friday' }), {
        class: 'btn btn-ghost sh-banner-action sh-banner-settings',
      });
  const configText = h('span', { class: 'sh-banner-config-text' });
  const hint = desktop ? RESTART_HINT_DESKTOP : RESTART_HINT_BROWSER;
  const restartHint = h('span', { class: 'sh-banner-hint muted' }, hint);
  const config = h(
    'div',
    { class: 'sh-banner sh-banner-warn', role: 'status', hidden: true },
    h('span', { class: 'sh-banner-icon' }, icon('gear', 15)),
    h('span', { class: 'sh-banner-text' }, configText, ' ', restartHint),
    openConfig,
    restart,
  );
  const stale = h(
    'div',
    { class: 'sh-banner sh-banner-danger', role: 'alert', hidden: true },
    h('span', { class: 'sh-banner-icon' }, icon('rework', 15)),
    h('span', { class: 'sh-banner-text' }, `${STALE_PAGE_MESSAGE}.`),
    button('Reload', () => reload(), { class: 'btn btn-primary sh-banner-action' }),
  );
  const checklist = opts.gettingStarted ? mountChecklist(ctx, opts.gettingStarted) : null;
  const el = h('div', { class: 'sh-banners' }, stale, config, checklist?.el ?? null);

  function renderBoard(): void {
    const board = ctx.store.select('board');
    const changes = board?.config?.changes;
    config.hidden = !configChanged(board);
    configText.textContent = changes ? configBannerText(changes) : '';
    // A file that could not be read is fixed in the editor; a restart would change nothing.
    const needsRestart = configRestartKeys(board).length > 0 && configError(board) === null;
    restartHint.textContent = needsRestart ? hint : '';
    restartHint.hidden = !needsRestart;
    restart.hidden = !needsRestart;
    openConfig.hidden = !board?.project.root;
    stale.hidden = !pageIsStale(board);
  }

  const unsubscribe = ctx.store.subscribe('board', renderBoard);
  renderBoard();

  return {
    el,
    destroy() {
      unsubscribe();
      checklist?.destroy();
      el.remove();
    },
  };
}

/**
 * The getting-started checklist until it is dismissed (plan §7.1). The shell shows it in the rail,
 * under the decisions, so the Studio keeps its full height.
 */
export function mountChecklist(ctx: AppContext, make: (ctx: AppContext) => Component): Component {
  const slot = h('div', { class: 'sh-banner-slot' });
  let checklist: Component | null = null;

  function render(): void {
    const dismissed = ctx.store.select('prefs').gettingStartedDismissed;
    if (dismissed && checklist) {
      checklist.destroy();
      checklist = null;
    } else if (!dismissed && !checklist) {
      try {
        checklist = make(ctx);
        slot.append(checklist.el);
      } catch {
        checklist = null;
      }
    }
    slot.hidden = !checklist;
  }

  const unsubscribe = ctx.store.subscribe('prefs', (next, prev) => {
    if (next.gettingStartedDismissed !== prev.gettingStartedDismissed) render();
  });
  render();

  return {
    el: slot,
    destroy() {
      unsubscribe();
      checklist?.destroy();
      checklist = null;
      slot.remove();
    },
  };
}
