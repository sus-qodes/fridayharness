/**
 * Banners under the header (plan §7.1): "config.yaml changed; restart Friday to apply" while the
 * snapshot's config hashes differ, "This page is older than Friday; reload it" while the snapshot's
 * `ui_api` is not this bundle's, and the slot of the getting-started checklist, shown until it is
 * dismissed (and again if the setting brings it back).
 */
import type { UiSnapshot } from '@friday/protocol';
import { STALE_PAGE_MESSAGE } from '../sync/sync-engine.js';
import { button, h } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import type { AppContext, Component } from './context.js';
import { UI_API } from './version.js';

export const CONFIG_CHANGED_MESSAGE = 'config.yaml changed; restart Friday to apply.';

/** The project's `config.yaml` was edited after Friday read it (it is read only at start). */
export function configChanged(board: UiSnapshot | null): boolean {
  if (!board?.config) return false;
  const { loaded_hash, current_hash } = board.config;
  return current_hash !== null && current_hash !== undefined && current_hash !== loaded_hash;
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
  const config = h(
    'div',
    { class: 'sh-banner sh-banner-warn', role: 'status', hidden: true },
    h('span', { class: 'sh-banner-icon' }, icon('gear', 15)),
    h('span', { class: 'sh-banner-text' }, CONFIG_CHANGED_MESSAGE),
    openConfig,
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
    config.hidden = !configChanged(board);
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
