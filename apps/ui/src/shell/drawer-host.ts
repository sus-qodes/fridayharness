/**
 * The drawer host (plan §7.4, handoff Part 05 §1): renders the drawer named by `store.ui.drawer`
 * from the factory an area registered (`ctx.registry.drawers`) in a slide-over: on the right,
 * 540 px wide; the terminal at the bottom, its height from `prefs.terminalHeight`. A title, a close
 * button, `Esc` (the topmost layer only) and `Tab` kept inside while focus is in it; the Studio
 * stays usable beside it. Closing returns focus where it was. An unknown kind closes at once.
 * A drawer opened from a dialog (`request.back`) has a Back button that opens the dialog again.
 */
import { button, h, setVar } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { type AppContext, type Component, closeDrawer, type DrawerKind, type DrawerRequest } from './context.js';
import { type LayerStack, RANK } from './layers.js';

/** Drawers that open at the bottom of the window instead of the right. */
export const BOTTOM_DRAWERS: ReadonlySet<DrawerKind> = new Set<DrawerKind>(['terminal']);
export const TERMINAL_MIN = 300;
export const TERMINAL_MAX = 600;
export const TERMINAL_DEFAULT = 320;

export function terminalHeight(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : TERMINAL_DEFAULT;
  return Math.round(Math.min(TERMINAL_MAX, Math.max(TERMINAL_MIN, n)));
}

export interface DrawerHost extends Component {
  current(): DrawerRequest | null;
}

let counter = 0;

export function mountDrawerHost(ctx: AppContext, layers: LayerStack): DrawerHost {
  const el = h('div', { class: 'sh-drawer-host' });
  let shown: { request: DrawerRequest; content: Component; panel: HTMLElement; removeLayer: () => void } | null = null;
  let destroyed = false;
  let syncing = false;

  function teardown(): void {
    const s = shown;
    if (!s) return;
    shown = null;
    s.removeLayer();
    try {
      s.content.destroy();
    } catch {
      // A content that fails to clean up must not keep the drawer on screen.
    }
    s.panel.remove();
  }

  function closeFor(request: DrawerRequest): void {
    if (ctx.store.select('ui').drawer === request) closeDrawer(ctx);
  }

  /** Closes the drawer and opens the dialog it came from, in one change. */
  function backFor(request: DrawerRequest): void {
    if (!request.back || ctx.store.select('ui').drawer !== request) return;
    ctx.store.patch('ui', { drawer: null, modal: { ...request.back.modal } });
  }

  function applyHeight(): void {
    if (shown && BOTTOM_DRAWERS.has(shown.request.kind)) {
      setVar(shown.panel, '--sh-term-h', `${terminalHeight(ctx.store.select('prefs').terminalHeight)}px`);
    }
  }

  function show(request: DrawerRequest): void {
    const factory = ctx.registry.drawers.get(request.kind);
    if (!factory) {
      closeDrawer(ctx);
      return;
    }
    const bottom = BOTTOM_DRAWERS.has(request.kind);
    const uid = ++counter;
    const titleId = `sh-drawer-title-${uid}`;
    const title = h('h2', { class: 'sh-drawer-title', id: titleId });
    const body = h('div', { class: 'sh-drawer-body scroll' });
    const closeBtn = button(icon('close', 16), () => closeFor(request), {
      class: 'btn btn-ghost btn-icon sh-drawer-close',
      ariaLabel: 'Close the panel',
      title: 'Close (Esc)',
    });
    const backBtn = request.back
      ? button(truncate(cleanText(request.back.label), 60), () => backFor(request), {
          class: 'btn btn-ghost sh-drawer-back',
        })
      : null;
    const panel = h(
      'section',
      {
        class: ['sh-drawer', 'glass-panel', bottom ? 'sh-drawer-bottom' : 'sh-drawer-right'],
        role: 'dialog',
        tabIndex: -1,
        aria: { labelledby: titleId },
        dataset: { kind: request.kind },
      },
      h('header', { class: 'sh-drawer-head' }, backBtn, title, closeBtn),
      body,
    );
    el.append(panel);
    const removeLayer = layers.open({ el: panel, rank: RANK.drawer, close: () => closeFor(request) });
    let content: Component & { title: string };
    try {
      content = factory(ctx, request);
    } catch (e) {
      removeLayer();
      panel.remove();
      ctx.toast({ kind: 'error', text: 'This panel could not open', detail: cleanText((e as Error)?.message ?? '') });
      closeDrawer(ctx);
      return;
    }
    shown = { request, content, panel, removeLayer };
    if (ctx.store.select('ui').drawer !== request) return;
    title.textContent = truncate(cleanText(content.title || 'Friday'), 160);
    body.append(content.el);
    applyHeight();
  }

  function sync(): void {
    if (destroyed || syncing) return;
    syncing = true;
    try {
      for (let guard = 0; guard < 8; guard++) {
        const request = ctx.store.select('ui').drawer;
        if (shown && shown.request === request) return;
        if (!shown && !request) return;
        teardown();
        if (request) show(request);
      }
    } finally {
      syncing = false;
    }
  }

  const unsubscribeUi = ctx.store.subscribe('ui', (next, prev) => {
    if (next.drawer !== prev.drawer) sync();
  });
  const unsubscribePrefs = ctx.store.subscribe('prefs', (next, prev) => {
    if (next.terminalHeight !== prev.terminalHeight) applyHeight();
  });
  sync();

  return {
    el,
    current: () => shown?.request ?? null,
    destroy() {
      destroyed = true;
      unsubscribeUi();
      unsubscribePrefs();
      teardown();
      el.remove();
    },
  };
}
