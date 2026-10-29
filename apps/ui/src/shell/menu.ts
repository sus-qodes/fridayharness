/**
 * A small drop-down menu (the header's More (…) menu; the product review of 2026-10-17 §4): a
 * trigger button and a list of actions under it. Open on click; arrows move between the items,
 * `Home` and `End` jump, `Esc` closes and gives focus back to the trigger, a click or a focus move
 * outside closes it. Choosing an item closes the menu first, so a drawer it opens finds the page
 * as it was. No keyboard scope is pushed: the keys are handled on the menu itself, and `Esc` stops
 * there so the shell's layers never see it.
 */
import { button, type Child, h } from '../ui/dom.js';
import type { Component } from './context.js';
import { focusQuietly } from './layers.js';

export interface MenuItem {
  /** Stable, for tests and `data-item`. */
  id: string;
  label: string;
  title?: string;
  run: () => void;
}

export interface MenuOptions {
  /** What the trigger shows (an icon, a word). */
  label: Child;
  /** The trigger's accessible name. */
  ariaLabel: string;
  /** The trigger's tooltip. */
  title?: string;
  /** Classes added to the trigger. */
  triggerClass?: string;
  items: MenuItem[];
}

export interface Menu extends Component {
  readonly trigger: HTMLButtonElement;
  readonly list: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

let counter = 0;

export function mountMenu(opts: MenuOptions): Menu {
  const listId = `sh-menu-${++counter}`;
  let open = false;

  const items = opts.items.map((item) =>
    button(
      item.label,
      () => {
        close(true);
        item.run();
      },
      {
        class: 'sh-menu-item',
        role: 'menuitem',
        dataset: { item: item.id },
        ...(item.title ? { title: item.title } : {}),
      },
    ),
  );
  const list = h('div', { class: 'sh-menu-list glass-panel', id: listId, role: 'menu', hidden: true }, ...items);
  const trigger = button(opts.label, () => toggle(), {
    class: ['btn', 'btn-ghost', 'sh-menu-trigger', opts.triggerClass],
    ariaLabel: opts.ariaLabel,
    ...(opts.title ? { title: opts.title } : {}),
    aria: { haspopup: 'menu', expanded: 'false', controls: listId },
  });
  const el = h('div', { class: 'sh-menu' }, trigger, list);

  function focusItem(i: number): void {
    const n = items.length;
    if (!n) return;
    focusQuietly(items[((i % n) + n) % n] as HTMLButtonElement);
  }

  function show(): void {
    if (open) return;
    open = true;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    focusItem(0);
  }

  /** Closes; `refocus` puts focus back on the trigger (keyboard use and a chosen item). */
  function close(refocus = false): void {
    if (!open) return;
    open = false;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) focusQuietly(trigger);
  }

  function toggle(): void {
    if (open) close(true);
    else show();
  }

  function onOutside(event: Event): void {
    if (event.target instanceof Node && el.contains(event.target)) return;
    close();
  }

  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && el.contains(next)) return;
    close();
  }

  function onKey(event: KeyboardEvent): void {
    if (!open) {
      // On the closed trigger, ArrowDown opens the menu like a click would.
      if (event.key === 'ArrowDown' && event.target === trigger) {
        event.preventDefault();
        show();
      }
      return;
    }
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      case 'ArrowDown':
        event.preventDefault();
        focusItem(at + 1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(at < 0 ? -1 : at - 1);
        return;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        return;
      case 'End':
        event.preventDefault();
        focusItem(-1);
        return;
      case 'Tab':
        // Focus moves on; the menu does not hold it.
        close();
        return;
      default:
        return;
    }
  }

  el.addEventListener('keydown', onKey);
  el.addEventListener('focusout', onFocusOut);

  return {
    el,
    trigger,
    list,
    open: show,
    close: () => close(),
    isOpen: () => open,
    destroy() {
      close();
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('focusout', onFocusOut);
      el.remove();
    },
  };
}
