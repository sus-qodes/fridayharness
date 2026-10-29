/**
 * The modal host (plan §7.5–§7.7): renders the modal named by `store.ui.modal` from the factory an
 * area registered (`ctx.registry.modals`) in a centred dialog with its title and a close button,
 * sizes `sm`, `md` and `lg`. `Esc` closes the topmost layer only; focus is trapped inside and
 * returns where it was. An unknown kind closes at once.
 */
import { button, h } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { type AppContext, type Component, closeModal, type ModalRequest } from './context.js';
import { type LayerStack, RANK } from './layers.js';

export interface ModalHost extends Component {
  /** The request shown now (tests). */
  current(): ModalRequest | null;
}

let counter = 0;
const SIZES = new Set(['sm', 'md', 'lg']);

export function mountModalHost(ctx: AppContext, layers: LayerStack): ModalHost {
  const el = h('div', { class: 'sh-modal-host' });
  let shown: { request: ModalRequest; content: Component; backdrop: HTMLElement; removeLayer: () => void } | null =
    null;
  let destroyed = false;

  function teardown(): void {
    const s = shown;
    if (!s) return;
    shown = null;
    s.removeLayer();
    try {
      s.content.destroy();
    } catch {
      // A content that fails to clean up must not keep the dialog on screen.
    }
    s.backdrop.remove();
  }

  /** Closes the modal shown for `request`, and only that one (a stale `close` does nothing). */
  function closeFor(request: ModalRequest): void {
    if (ctx.store.select('ui').modal === request) closeModal(ctx);
  }

  function show(request: ModalRequest): void {
    const factory = ctx.registry.modals.get(request.kind);
    if (!factory) {
      closeModal(ctx);
      return;
    }
    const uid = ++counter;
    const titleId = `sh-modal-title-${uid}`;
    const title = h('h2', { class: 'sh-modal-title', id: titleId });
    const body = h('div', { class: 'sh-modal-body scroll' });
    const closeBtn = button(icon('close', 16), () => closeFor(request), {
      class: 'btn btn-ghost btn-icon sh-modal-close',
      ariaLabel: 'Close',
      title: 'Close (Esc)',
    });
    const dialog = h(
      'div',
      {
        class: ['sh-modal', 'glass-panel'],
        role: 'dialog',
        tabIndex: -1,
        aria: { modal: true, labelledby: titleId },
        dataset: { kind: request.kind },
      },
      h('header', { class: 'sh-modal-head' }, title, closeBtn),
      body,
    );
    const backdrop = h('div', { class: 'sh-modal-backdrop' }, dialog);
    el.append(backdrop);
    // The layer comes first, so the keyboard scopes the content pushes are newer and come first.
    const removeLayer = layers.open({ el: dialog, rank: RANK.modal, close: () => closeFor(request) });
    let content: Component & { title: string; size?: 'sm' | 'md' | 'lg' };
    try {
      content = factory(ctx, request, () => closeFor(request));
    } catch (e) {
      removeLayer();
      backdrop.remove();
      ctx.toast({ kind: 'error', text: 'This panel could not open', detail: cleanText((e as Error)?.message ?? '') });
      closeModal(ctx);
      return;
    }
    shown = { request, content, backdrop, removeLayer };
    // The factory may have closed or replaced its own modal while it was built: `sync` loops on.
    if (ctx.store.select('ui').modal !== request) return;
    title.textContent = truncate(cleanText(content.title || 'Friday'), 160);
    dialog.classList.add(`sh-modal-${SIZES.has(content.size ?? 'md') ? (content.size ?? 'md') : 'md'}`);
    body.append(content.el);
  }

  let syncing = false;
  function sync(): void {
    if (destroyed || syncing) return;
    syncing = true;
    try {
      // Loops while a factory changes the request it was built for, until the shown one is current.
      for (let guard = 0; guard < 8; guard++) {
        const request = ctx.store.select('ui').modal;
        if (shown && shown.request === request) return;
        if (!shown && !request) return;
        teardown();
        if (request) show(request);
      }
    } finally {
      syncing = false;
    }
  }

  const unsubscribe = ctx.store.subscribe('ui', (next, prev) => {
    if (next.modal !== prev.modal) sync();
  });
  sync();

  return {
    el,
    current: () => shown?.request ?? null,
    destroy() {
      destroyed = true;
      unsubscribe();
      teardown();
      el.remove();
    },
  };
}
