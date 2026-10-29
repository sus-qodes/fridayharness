/**
 * The shell's confirm dialog (`AppContext.confirm`, plan §6 rule 6): a destructive action asks
 * first. `danger` paints the confirm button red; `armAfterS` keeps it disabled through a visible
 * countdown (the halt dialog's 3 s); `Esc` cancels; focus starts on Cancel, stays inside the dialog
 * and returns where it was. `Enter` only activates the focused button.
 */
import { button, h, setText } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import type { Component, ConfirmOptions } from './context.js';
import { type LayerStack, RANK } from './layers.js';

const TITLE_MAX = 200;
const LINE_MAX = 2000;

export interface ConfirmHost extends Component {
  confirm(o: ConfirmOptions): Promise<boolean>;
  /** The dialogs open now (tests). */
  open(): number;
}

let counter = 0;

/** Whole seconds before the confirm button arms (0 when it is armed at once). */
export function armSeconds(o: Pick<ConfirmOptions, 'armAfterS'>): number {
  const s = o.armAfterS;
  if (s === undefined || !Number.isFinite(s) || s <= 0) return 0;
  return Math.min(60, Math.ceil(s));
}

export function createConfirmHost(layers: LayerStack): ConfirmHost {
  const el = h('div', { class: 'sh-confirm-host' });
  const pending = new Set<(answer: boolean) => void>();

  function confirm(o: ConfirmOptions): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const uid = ++counter;
      const titleId = `sh-confirm-title-${uid}`;
      const bodyId = `sh-confirm-body-${uid}`;
      const lines = (Array.isArray(o.body) ? o.body : [o.body]).map((line) =>
        h('p', { class: 'sh-confirm-line' }, truncate(cleanText(String(line ?? '')), LINE_MAX)),
      );
      const label = truncate(cleanText(o.confirmLabel || 'Confirm'), 80);
      let remaining = armSeconds(o);
      let timer: ReturnType<typeof setTimeout> | null = null;
      let done = false;

      const status = h('span', { class: 'visually-hidden', aria: { live: 'polite' } });
      const confirmBtn = button(label, () => finish(true), {
        class: ['btn', o.danger ? 'btn-danger' : 'btn-primary', 'sh-confirm-ok'],
        disabled: remaining > 0,
      });
      const cancelBtn = button(truncate(cleanText(o.cancelLabel || 'Cancel'), 80), () => finish(false), {
        class: 'btn sh-confirm-cancel',
      });
      const dialog = h(
        'div',
        {
          class: ['sh-confirm', 'glass-panel', o.danger ? 'sh-confirm-danger' : null],
          role: 'alertdialog',
          tabIndex: -1,
          aria: { modal: true, labelledby: titleId, describedby: bodyId },
        },
        h('h2', { class: 'sh-confirm-title', id: titleId }, truncate(cleanText(o.title || 'Are you sure?'), TITLE_MAX)),
        h('div', { class: 'sh-confirm-body', id: bodyId }, lines),
        h('div', { class: 'sh-confirm-actions' }, status, cancelBtn, confirmBtn),
      );
      const backdrop = h('div', { class: 'sh-confirm-backdrop' }, dialog);

      function paint(): void {
        if (remaining > 0) {
          confirmBtn.disabled = true;
          setText(confirmBtn, `${label} (${remaining})`);
          confirmBtn.setAttribute('aria-label', `${label}: ready in ${remaining} s`);
        } else {
          confirmBtn.disabled = false;
          setText(confirmBtn, label);
          confirmBtn.removeAttribute('aria-label');
        }
      }

      function tick(): void {
        timer = null;
        if (done) return;
        remaining -= 1;
        paint();
        if (remaining > 0) timer = setTimeout(tick, 1000);
        else setText(status, `${label} is ready`);
      }

      function finish(answer: boolean): void {
        if (done) return;
        if (answer && remaining > 0) return;
        done = true;
        if (timer) clearTimeout(timer);
        timer = null;
        pending.delete(finish);
        removeLayer();
        backdrop.remove();
        resolve(answer);
      }

      paint();
      el.append(backdrop);
      pending.add(finish);
      const removeLayer = layers.open({ el: dialog, rank: RANK.confirm, close: () => finish(false) }, cancelBtn);
      if (remaining > 0) timer = setTimeout(tick, 1000);
    });
  }

  return {
    el,
    confirm,
    open: () => pending.size,
    destroy() {
      for (const finish of [...pending]) finish(false);
      el.remove();
    },
  };
}
