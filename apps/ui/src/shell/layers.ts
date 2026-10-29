/**
 * The shell's layers (plan §7.4, FD-16): drawers, modals and confirm dialogs. `Esc` closes the
 * topmost layer only, whichever scope receives it; each layer keeps `Tab` inside itself, a modal
 * also pulls stray focus back, and closing a layer returns focus to where it was before.
 *
 * Every layer pushes its own keyboard scope when it opens, so scopes that content pushes later
 * (a dialog's own `Esc` or `Enter`) still come first; any layer's `Esc` closes the highest-ranked
 * layer, so a drawer opened under a modal never takes `Esc` from it.
 */
import type { Keyboard } from '../ui/keys.js';

/** Stacking order: a higher rank is drawn above and takes `Esc` first. */
export const RANK = { drawer: 1, modal: 2, confirm: 3 } as const;

export interface Layer {
  /** The layer's dialog element (focus stays inside it). */
  readonly el: HTMLElement;
  readonly rank: number;
  /** Closes the layer the way its owner does (a modal clears `ui.modal`, a confirm answers false). */
  close(): void;
}

interface Entry {
  layer: Layer;
  order: number;
  returnTo: Element | null;
  popScope: () => void;
  onKey: (e: KeyboardEvent) => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The elements of `root` that `Tab` reaches, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hidden && !el.closest('[hidden]'),
  );
}

/** Focuses without scrolling the page (falls back for engines without the option). */
export function focusQuietly(el: HTMLElement): void {
  try {
    el.focus({ preventScroll: true });
  } catch {
    el.focus();
  }
}

export class LayerStack {
  readonly #entries: Entry[] = [];
  #order = 0;
  readonly #doc: Document;

  constructor(
    private readonly keys: Keyboard,
    doc: Document = document,
  ) {
    this.#doc = doc;
  }

  /** The number of open layers. */
  get size(): number {
    return this.#entries.length;
  }

  /** The layer drawn on top: the highest rank, the newest among equals. */
  top(): Layer | null {
    return this.#topEntry()?.layer ?? null;
  }

  /** True while a modal or a confirm dialog is open (keys below it are held back). */
  modalOpen(): boolean {
    return this.#entries.some((e) => e.layer.rank >= RANK.modal);
  }

  /** Closes the topmost layer; false when none is open. */
  closeTop(): boolean {
    const top = this.#topEntry();
    if (!top) return false;
    top.layer.close();
    return true;
  }

  /**
   * Registers an open layer and focuses it (`initialFocus`, else the layer element itself, which
   * should carry `tabIndex = -1`). Returns the function that removes it and restores focus.
   */
  open(layer: Layer, initialFocus?: HTMLElement | null): () => void {
    const active = this.#doc.activeElement;
    const stack = this;
    const popScope = this.keys.push({
      name: `layer-${layer.rank}`,
      get exclusive() {
        return stack.modalOpen();
      },
      bindings: [
        {
          key: 'Escape',
          inFields: true,
          description: 'Close the topmost panel',
          run: () => {
            stack.closeTop();
          },
        },
      ],
    });
    const onKey = (e: KeyboardEvent) => this.#trapTab(layer.el, e);
    layer.el.addEventListener('keydown', onKey);
    const entry: Entry = {
      layer,
      order: ++this.#order,
      returnTo: active && active !== this.#doc.body ? active : null,
      popScope,
      onKey,
    };
    this.#entries.push(entry);
    if (this.#entries.length === 1) this.#doc.addEventListener('focusin', this.#onFocusIn);
    focusQuietly(initialFocus ?? layer.el);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.#remove(entry);
    };
  }

  #topEntry(): Entry | null {
    let top: Entry | null = null;
    for (const e of this.#entries) {
      if (!top || e.layer.rank > top.layer.rank || (e.layer.rank === top.layer.rank && e.order > top.order)) top = e;
    }
    return top;
  }

  #remove(entry: Entry): void {
    const i = this.#entries.indexOf(entry);
    if (i < 0) return;
    const wasTop = this.#topEntry() === entry;
    this.#entries.splice(i, 1);
    entry.popScope();
    entry.layer.el.removeEventListener('keydown', entry.onKey);
    if (!this.#entries.length) this.#doc.removeEventListener('focusin', this.#onFocusIn);
    if (!wasTop) return;
    const back = entry.returnTo;
    const next = this.#topEntry();
    if (back instanceof HTMLElement && back.isConnected && (!next || next.layer.el.contains(back))) {
      focusQuietly(back);
    } else if (next) {
      focusQuietly(next.layer.el);
    }
  }

  /** `Tab` and `Shift+Tab` wrap around inside the layer. */
  #trapTab(root: HTMLElement, e: KeyboardEvent): void {
    if (e.key !== 'Tab' || e.ctrlKey || e.altKey || e.metaKey) return;
    const top = this.#topEntry();
    if (!top || top.layer.el !== root) return;
    const list = focusables(root);
    if (!list.length) {
      e.preventDefault();
      focusQuietly(root);
      return;
    }
    const first = list[0] as HTMLElement;
    const last = list[list.length - 1] as HTMLElement;
    const active = this.#doc.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      focusQuietly(last);
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      focusQuietly(first);
    }
  }

  /** Focus that leaves an open modal goes back into it (drawers do not hold the page). */
  readonly #onFocusIn = (e: FocusEvent): void => {
    const top = this.#topEntry();
    if (!top || top.layer.rank < RANK.modal) return;
    const target = e.target;
    if (target instanceof Node && top.layer.el.contains(target)) return;
    focusQuietly(top.layer.el);
  };
}
