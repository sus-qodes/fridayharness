import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Menu, mountMenu } from './menu.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

function key(target: Element, k: string): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

let menu: Menu | null = null;

function setup(): { menu: Menu; ran: string[]; outside: HTMLButtonElement } {
  const ran: string[] = [];
  menu = mountMenu({
    label: '…',
    ariaLabel: 'More',
    title: 'More: things',
    items: [
      { id: 'a', label: 'First', run: () => ran.push('a') },
      { id: 'b', label: `Second ${HOSTILE}`, title: 'The second', run: () => ran.push('b') },
      { id: 'c', label: 'Third', run: () => ran.push('c') },
    ],
  });
  const outside = document.createElement('button');
  document.body.append(menu.el, outside);
  return { menu, ran, outside };
}

afterEach(() => {
  menu?.destroy();
  menu = null;
  document.body.replaceChildren();
});

describe('menu', () => {
  it('is a labelled trigger with a hidden menu of items, shown as text', () => {
    const { menu: m } = setup();
    expect(m.trigger.getAttribute('aria-label')).toBe('More');
    expect(m.trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(m.trigger.getAttribute('aria-expanded')).toBe('false');
    expect(m.trigger.getAttribute('aria-controls')).toBe(m.list.id);
    expect(m.list.getAttribute('role')).toBe('menu');
    expect(m.list.hidden).toBe(true);
    expect(m.el.querySelector('img')).toBeNull();
    const items = [...m.list.querySelectorAll('[role="menuitem"]')];
    expect(items.map((i) => i.textContent)).toEqual(['First', `Second ${HOSTILE}`, 'Third']);
    expect((items[1] as HTMLElement).title).toBe('The second');
  });

  it('opens on click with focus on the first item, runs an item and closes, focus back on the trigger', () => {
    const { menu: m, ran } = setup();
    m.trigger.click();
    expect(m.isOpen()).toBe(true);
    expect(m.list.hidden).toBe(false);
    expect(m.trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(m.list.querySelector('[data-item="a"]'));
    (m.list.querySelector('[data-item="b"]') as HTMLButtonElement).click();
    expect(ran).toEqual(['b']);
    expect(m.isOpen()).toBe(false);
    expect(document.activeElement).toBe(m.trigger);
    // A second click on the trigger closes an open menu.
    m.trigger.click();
    m.trigger.click();
    expect(m.isOpen()).toBe(false);
  });

  it('arrows move between the items and wrap; Home and End jump; Esc closes and stops there', () => {
    const { menu: m } = setup();
    m.trigger.focus();
    key(m.trigger, 'ArrowDown');
    expect(m.isOpen()).toBe(true);
    const item = (id: string) => m.list.querySelector(`[data-item="${id}"]`) as HTMLButtonElement;
    expect(document.activeElement).toBe(item('a'));
    key(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement).toBe(item('b'));
    key(document.activeElement as Element, 'End');
    expect(document.activeElement).toBe(item('c'));
    key(document.activeElement as Element, 'ArrowDown');
    expect(document.activeElement).toBe(item('a'));
    key(document.activeElement as Element, 'ArrowUp');
    expect(document.activeElement).toBe(item('c'));
    key(document.activeElement as Element, 'Home');
    expect(document.activeElement).toBe(item('a'));
    const seen = vi.fn();
    window.addEventListener('keydown', seen);
    const esc = key(document.activeElement as Element, 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener('keydown', seen);
    expect(m.isOpen()).toBe(false);
    expect(document.activeElement).toBe(m.trigger);
  });

  it('closes on a click outside and when focus leaves it', () => {
    const { menu: m, outside } = setup();
    m.trigger.click();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(m.isOpen()).toBe(false);
    m.trigger.click();
    // Inside the menu, a press keeps it open.
    m.list.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(m.isOpen()).toBe(true);
    outside.focus();
    m.el.dispatchEvent(new FocusEvent('focusout', { relatedTarget: outside }));
    expect(m.isOpen()).toBe(false);
  });

  it('removes its listeners and element on destroy', () => {
    const { menu: m } = setup();
    m.trigger.click();
    const el = m.el;
    m.destroy();
    menu = null;
    expect(el.isConnected).toBe(false);
    expect(m.isOpen()).toBe(false);
  });
});
