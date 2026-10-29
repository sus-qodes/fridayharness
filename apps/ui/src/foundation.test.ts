import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ObservableStore } from './store/store.js';
import { button, h, replace } from './ui/dom.js';
import { cleanText, duration, shortId, stripEscapes, timeAgo, timeUntil, truncate, usd } from './ui/format.js';
import { Keyboard } from './ui/keys.js';
import { icon, s } from './ui/svg.js';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('rendering rules (plan FD-20, §6)', () => {
  it('no source file parses HTML or runs strings as code', () => {
    const banned = [
      /\.innerHTML\b/,
      /\.outerHTML\b/,
      /insertAdjacentHTML/,
      /document\.write/,
      /\beval\(/,
      /new Function\(/,
      /setAttribute\(\s*['"]on/,
      /setAttribute\(\s*['"]style['"]/,
      /\bfrom ['"]node:/,
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of banned) if (pattern.test(text)) offenders.push(`${path.relative(SRC, file)}: ${pattern}`);
    }
    expect(offenders).toEqual([]);
  });

  it('renders hostile strings as text', () => {
    const hostile = '<img src=x onerror="alert(1)"></script><b>bold</b>';
    const el = h('div', { class: 'card' }, hostile, h('span', null, hostile));
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toBe(hostile + hostile);
    replace(el, 'plain');
    expect(el.textContent).toBe('plain');
  });

  it('refuses event-handler and URL attributes', () => {
    expect(() => h('div', { attrs: { onclick: 'x()' } })).toThrow(/not allowed/);
    expect(() => h('div', { attrs: { href: 'javascript:x' } })).toThrow(/not allowed/);
    expect(() => s('svg', { onload: 'x' })).toThrow(/not allowed/);
  });

  it('makes buttons with type and an accessible name', () => {
    const fn = vi.fn();
    const b = button(icon('close'), fn, { ariaLabel: 'Close', class: 'btn btn-icon' });
    expect(b.getAttribute('type')).toBe('button');
    expect(b.getAttribute('aria-label')).toBe('Close');
    b.click();
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('ObservableStore', () => {
  it('notifies a slice only when its reference changes', () => {
    const store = new ObservableStore({ a: { n: 1 }, b: { n: 1 } });
    const a = vi.fn();
    const b = vi.fn();
    store.subscribe('a', a);
    store.subscribe('b', b);
    store.patch('a', { n: 2 });
    expect(a).toHaveBeenCalledWith({ n: 2 }, { n: 1 });
    expect(b).not.toHaveBeenCalled();
    const same = store.select('a');
    store.setState({ a: same });
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and keeps state frozen', () => {
    const store = new ObservableStore({ x: 1 });
    const fn = vi.fn();
    const off = store.subscribe('x', fn);
    off();
    store.setState({ x: 2 });
    expect(fn).not.toHaveBeenCalled();
    expect(Object.isFrozen(store.getState())).toBe(true);
  });
});

describe('format', () => {
  const now = Date.parse('2026-10-17T10:00:00Z');
  it('describes times and durations', () => {
    expect(timeAgo('2026-10-17T09:59:58Z', now)).toBe('just now');
    expect(timeAgo('2026-10-17T09:55:00Z', now)).toBe('5 min ago');
    expect(timeUntil('2026-10-17T10:00:30Z', now)).toBe('in 30 s');
    expect(timeUntil('2026-10-17T09:00:00Z', now)).toBe('expired');
    expect(duration(850)).toBe('850 ms');
    expect(duration(185_000)).toBe('3m 05s');
    expect(usd(0.009292)).toBe('$0.0093');
    expect(usd(null)).toBe('—');
  });

  it('cleans terminal escapes, control characters and bidi overrides', () => {
    expect(cleanText('\u001b[31mred\u001b[0m\u0007 ok‮!')).toBe('red ok!');
    expect(cleanText('tab\tand\nnewline')).toBe('tab\tand\nnewline');
  });

  it('removes an escape sequence exactly, never the text after it (review M9i)', () => {
    const tail = 'Run the migration on the staging copy\u001b_ and then drop the production orders table';
    expect(cleanText(tail)).toBe('Run the migration on the staging copy and then drop the production orders table');
    expect(cleanText('a\u001bPpayload b')).toBe('apayload b');
    expect(cleanText('title\u001b]0;set title\u0007 shown')).toBe('title shown');
    expect(cleanText('x\u001b]2;t\u001b\\ y')).toBe('x y');
    expect(stripEscapes('keep‮ marks')).toBe('keep‮ marks');
  });

  it('truncates by code points and shortens ids', () => {
    expect(truncate('😀😀😀', 2)).toBe('😀…');
    expect(shortId('task_29jxbk8t7z47244abcdefghij')).toBe('task_29jxbk8t');
  });
});

describe('Keyboard', () => {
  it('lets the newest scope win and respects exclusive scopes and fields', () => {
    const kb = new Keyboard({ addEventListener: () => {}, removeEventListener: () => {} });
    const outer = vi.fn();
    const inner = vi.fn();
    kb.push({
      name: 'outer',
      bindings: [
        { key: 'k', ctrl: true, run: outer },
        { key: 'Escape', run: outer },
      ],
    });
    const pop = kb.push({ name: 'modal', exclusive: true, bindings: [{ key: 'Escape', run: inner }] });
    const esc = new KeyboardEvent('keydown', { key: 'Escape' });
    expect(kb.handle(esc)).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(kb.handle(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))).toBe(false);
    pop();
    expect(kb.handle(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true }))).toBe(true);
    expect(outer).toHaveBeenCalledOnce();
    const input = document.createElement('input');
    document.body.append(input);
    const typed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(typed, 'target', { value: input });
    expect(kb.handle(typed)).toBe(false);
  });
});
