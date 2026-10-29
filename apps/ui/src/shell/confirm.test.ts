import { afterEach, describe, expect, it, vi } from 'vitest';
import { button } from '../ui/dom.js';
import { Keyboard } from '../ui/keys.js';
import { armSeconds, type ConfirmHost, createConfirmHost } from './confirm.js';
import { LayerStack } from './layers.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

function setup() {
  const keys = new Keyboard(new EventTarget() as unknown as Window);
  const layers = new LayerStack(keys);
  const host = createConfirmHost(layers);
  document.body.append(host.el);
  const opener = button('Open', () => undefined);
  document.body.append(opener);
  opener.focus();
  return { keys, layers, host, opener };
}

function esc(keys: Keyboard): void {
  keys.handle(new KeyboardEvent('keydown', { key: 'Escape' }));
}

let current: ConfirmHost | null = null;

afterEach(() => {
  current?.destroy();
  current = null;
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('confirm dialog', () => {
  it('asks, with focus on Cancel, and answers true on confirm', async () => {
    const { host, opener } = setup();
    current = host;
    const p = host.confirm({ title: 'Stop Friday?', body: 'Agents stop.', confirmLabel: 'Stop Friday', danger: true });
    const dialog = host.el.querySelector('[role="alertdialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('sh-confirm-danger')).toBe(true);
    const ok = host.el.querySelector<HTMLButtonElement>('.sh-confirm-ok');
    const cancel = host.el.querySelector<HTMLButtonElement>('.sh-confirm-cancel');
    expect(ok?.classList.contains('btn-danger')).toBe(true);
    expect(document.activeElement).toBe(cancel);
    ok?.click();
    expect(await p).toBe(true);
    expect(host.open()).toBe(0);
    expect(host.el.childElementCount).toBe(0);
    expect(document.activeElement).toBe(opener);
  });

  it('cancels with Esc and with Cancel', async () => {
    const { host, keys } = setup();
    current = host;
    const a = host.confirm({ title: 'A', body: 'x', confirmLabel: 'Go' });
    esc(keys);
    expect(await a).toBe(false);
    const b = host.confirm({ title: 'B', body: 'x', confirmLabel: 'Go', cancelLabel: 'Keep it' });
    const cancel = host.el.querySelector<HTMLButtonElement>('.sh-confirm-cancel');
    expect(cancel?.textContent).toBe('Keep it');
    cancel?.click();
    expect(await b).toBe(false);
  });

  it('arms the confirm button only after its countdown', async () => {
    vi.useFakeTimers();
    const { host } = setup();
    current = host;
    const p = host.confirm({
      title: 'Halt',
      body: ['one', 'two'],
      confirmLabel: 'Halt now',
      danger: true,
      armAfterS: 3,
    });
    const ok = host.el.querySelector('.sh-confirm-ok') as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    expect(ok.textContent).toBe('Halt now (3)');
    ok.dispatchEvent(new MouseEvent('click'));
    vi.advanceTimersByTime(1000);
    expect(ok.textContent).toBe('Halt now (2)');
    expect(ok.getAttribute('aria-label')).toBe('Halt now: ready in 2 s');
    vi.advanceTimersByTime(1999);
    expect(ok.disabled).toBe(true);
    vi.advanceTimersByTime(1);
    expect(ok.disabled).toBe(false);
    expect(ok.textContent).toBe('Halt now');
    expect(host.open()).toBe(1);
    ok.click();
    expect(await p).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps Tab inside the dialog', () => {
    const { host } = setup();
    current = host;
    void host.confirm({ title: 'T', body: 'x', confirmLabel: 'Go' });
    const ok = host.el.querySelector('.sh-confirm-ok') as HTMLButtonElement;
    const cancel = host.el.querySelector('.sh-confirm-cancel') as HTMLButtonElement;
    ok.focus();
    ok.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    expect(document.activeElement).toBe(cancel);
    cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
    expect(document.activeElement).toBe(ok);
  });

  it('answers false for every open dialog when destroyed', async () => {
    const { host } = setup();
    const a = host.confirm({ title: 'A', body: 'x', confirmLabel: 'Go' });
    const b = host.confirm({ title: 'B', body: 'x', confirmLabel: 'Go' });
    host.destroy();
    expect(await a).toBe(false);
    expect(await b).toBe(false);
  });

  it('shows hostile text as text', () => {
    const { host } = setup();
    current = host;
    void host.confirm({
      title: `${HOSTILE}‮`,
      body: [`${HOSTILE}​${'x'.repeat(5000)}`],
      confirmLabel: HOSTILE,
    });
    expect(host.el.querySelector('img')).toBeNull();
    expect(host.el.querySelector('.sh-confirm-title')?.textContent).toBe(HOSTILE);
    const line = host.el.querySelector('.sh-confirm-line')?.textContent ?? '';
    expect(line.startsWith(HOSTILE)).toBe(true);
    expect(Array.from(line).length).toBeLessThanOrEqual(2000);
  });

  it('reads the countdown length safely', () => {
    expect(armSeconds({})).toBe(0);
    expect(armSeconds({ armAfterS: 0 })).toBe(0);
    expect(armSeconds({ armAfterS: -2 })).toBe(0);
    expect(armSeconds({ armAfterS: Number.NaN })).toBe(0);
    expect(armSeconds({ armAfterS: 2.2 })).toBe(3);
    expect(armSeconds({ armAfterS: 1e9 })).toBe(60);
  });
});
