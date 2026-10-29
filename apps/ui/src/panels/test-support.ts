/**
 * Helpers for the panels' unit tests (never imported by page code): hostile strings, a microtask
 * flush, and finding controls by their text.
 */

/** Markup that must stay text. */
export const HOSTILE = '<img src=x onerror=alert(1)>';
/** A right-to-left override that would reorder what follows it. */
export const BIDI = 'invoice‮txt.exe';
/** A zero-width space hiding inside a word. */
export const ZW = 'pay​pal';
/** A 5000-character line. */
export const LONG = 'L'.repeat(5000);

/** Lets pending promise callbacks run (fake answers resolve in microtasks). */
export async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

export function buttons(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll('button'));
}

/** The first button whose text (or aria-label) matches. */
export function buttonBy(root: ParentNode, text: string | RegExp): HTMLButtonElement {
  const found = buttons(root).find((b) => {
    const label = `${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`.trim();
    return typeof text === 'string' ? label.includes(text) : text.test(label);
  });
  if (!found) throw new Error(`no button matches ${String(text)}`);
  return found;
}

/** The control a `<label>` with this text names. */
export function controlBy<T extends HTMLElement = HTMLInputElement>(root: ParentNode, label: string): T {
  const l = Array.from(root.querySelectorAll('label')).find((x) => x.textContent?.trim() === label);
  const id = l?.getAttribute('for');
  const el = id ? (root.querySelector(`#${id}`) as T | null) : null;
  if (!el) throw new Error(`no control labelled ${label}`);
  return el;
}

export function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function choose(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function check(el: HTMLInputElement, on: boolean): void {
  el.checked = on;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
