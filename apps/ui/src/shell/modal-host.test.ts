/**
 * A dialog whose content holds unsaved work is asked before it closes (`beforeClose`): for the close
 * button, for Esc and for the content's own Cancel. A content without one closes as before.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { h } from '../ui/dom.js';
import { openModal } from './context.js';
import { LayerStack } from './layers.js';
import { mountModalHost } from './modal-host.js';

const settle = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.replaceChildren();
});

/** A host with one dialog kind whose content answers `beforeClose` from `answers`, in order. */
function setup(answers: (boolean | Promise<boolean> | Error)[] | null) {
  const ctx = makeContext();
  const layers = new LayerStack(ctx.keys);
  const modals = mountModalHost(ctx, layers);
  document.body.append(modals.el);
  let asked = 0;
  let closeFromContent: () => void = () => undefined;
  ctx.registry.modal('feedback', (_c, _r, close) => {
    closeFromContent = close;
    return {
      el: h('div', { class: 'content' }),
      title: 'A form',
      destroy() {},
      ...(answers
        ? {
            beforeClose: () => {
              asked += 1;
              const next = answers.shift();
              if (next instanceof Error) throw next;
              return next ?? true;
            },
          }
        : {}),
    };
  });
  openModal(ctx, { kind: 'feedback' });
  const closeButton = () => modals.el.querySelector<HTMLButtonElement>('.sh-modal-close');
  return {
    ctx,
    modals,
    layers,
    asked: () => asked,
    closeButton,
    closeFromContent: () => closeFromContent(),
    open: () => ctx.store.select('ui').modal !== null,
  };
}

describe('closing a dialog', () => {
  it('closes at once when its content has nothing to ask', () => {
    const s = setup(null);
    expect(s.open()).toBe(true);
    s.closeButton()?.click();
    expect(s.open()).toBe(false);
    s.modals.destroy();
  });

  it('asks its content first: staying keeps it open, with everything in it', async () => {
    const s = setup([false, false, true]);
    s.closeButton()?.click();
    await settle();
    expect(s.asked()).toBe(1);
    expect(s.open()).toBe(true);
    expect(s.modals.el.querySelector('.content')).not.toBeNull();
    // Esc is the same question.
    s.layers.closeTop();
    await settle();
    expect(s.asked()).toBe(2);
    expect(s.open()).toBe(true);
    // So is the content's own Cancel; this time the person leaves.
    s.closeFromContent();
    await settle();
    expect(s.asked()).toBe(3);
    expect(s.open()).toBe(false);
    s.modals.destroy();
  });

  it('asks once while an answer is awaited, and closes when the question itself fails', async () => {
    let answer: (ok: boolean) => void = () => undefined;
    const pending = new Promise<boolean>((resolve) => {
      answer = resolve;
    });
    const s = setup([pending]);
    s.closeButton()?.click();
    s.closeButton()?.click();
    s.layers.closeTop();
    await settle();
    expect(s.asked()).toBe(1);
    expect(s.open()).toBe(true);
    answer(true);
    await settle();
    expect(s.open()).toBe(false);
    s.modals.destroy();

    // A content whose question throws must not keep its dialog on screen.
    const broken = setup([new Error('boom')]);
    broken.closeButton()?.click();
    await settle();
    expect(broken.open()).toBe(false);
    broken.modals.destroy();
  });

  it('does not ask a dialog that another one replaces', async () => {
    const s = setup([false]);
    s.ctx.registry.modal('halt', () => ({ el: h('div', { class: 'other' }), title: 'Other', destroy() {} }));
    openModal(s.ctx, { kind: 'halt' });
    await settle();
    expect(s.asked()).toBe(0);
    expect(s.modals.el.querySelector('.other')).not.toBeNull();
    s.modals.destroy();
  });
});
