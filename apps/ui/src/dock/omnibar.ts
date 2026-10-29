/**
 * The command palette (`Ctrl+K`, plan §7.6, handoff Part 06 §6.1): a spotlight overlay that
 * searches tasks, goals, agents, files seen in the activity and the registered commands; recent
 * actions first; arrows move, `Enter` runs the highlighted entry, `Esc` closes. Open while
 * `store.ui.paletteOpen` is true.
 */
import type { AppContext, Component } from '../shell/context.js';
import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { segments } from './fuzzy.js';
import {
  collectEntries,
  GROUP_LABEL,
  type PaletteEntry,
  type RankedEntry,
  rankEntries,
  recentIds,
  remember,
} from './palette-model.js';

let counter = 0;

/** Rows moved by PageUp / PageDown. */
const PAGE = 5;

export function mountPalette(ctx: AppContext, container: HTMLElement): Component {
  const uid = ++counter;
  const listId = `dk-pal-list-${uid}`;
  const input = h('input', {
    class: 'dk-pal-input',
    type: 'text',
    role: 'combobox',
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 200,
    placeholder: 'Search tasks, goals, agents, files, or a command…',
    aria: {
      label: 'Search tasks, goals, agents, files and commands',
      expanded: 'true',
      controls: listId,
      autocomplete: 'list',
      haspopup: 'listbox',
    },
  });
  const list = h('div', { class: 'dk-pal-list scroll', id: listId, role: 'listbox', aria: { label: 'Results' } });
  const status = h('div', { class: 'visually-hidden', role: 'status', aria: { live: 'polite' } });
  const panel = h(
    'div',
    { class: 'dk-pal glass-panel', role: 'dialog', aria: { modal: 'true', label: 'Command palette' } },
    h(
      'div',
      { class: 'dk-pal-head' },
      h('span', { class: 'dk-pal-search' }, icon('search', 16)),
      input,
      h('span', { class: 'kbd' }, 'Esc'),
    ),
    list,
    h(
      'div',
      { class: 'dk-pal-foot muted' },
      h('span', null, h('span', { class: 'kbd' }, '↑'), h('span', { class: 'kbd' }, '↓'), ' move'),
      h('span', null, h('span', { class: 'kbd' }, 'Enter'), ' run'),
      h('span', null, h('span', { class: 'kbd' }, 'Esc'), ' close'),
    ),
    status,
  );
  const el = h('div', { class: 'dk-pal-backdrop', hidden: true }, panel);

  let open = false;
  let entries: PaletteEntry[] = [];
  let ranked: RankedEntry[] = [];
  let active = 0;
  let rows: HTMLElement[] = [];
  let returnFocus: HTMLElement | null = null;
  let popOpenScope: (() => void) | null = null;

  function setOpen(next: boolean): void {
    if (ctx.store.select('ui').paletteOpen !== next) ctx.store.patch('ui', { paletteOpen: next });
  }

  function toggle(): void {
    setOpen(!ctx.store.select('ui').paletteOpen);
  }

  function optionId(i: number): string {
    return `dk-pal-${uid}-opt-${i}`;
  }

  function label(r: RankedEntry): HTMLElement {
    const span = h('span', { class: 'dk-pal-label' });
    if (!r.indices.length) span.textContent = r.entry.label;
    else
      for (const seg of segments(r.entry.label, r.indices))
        span.appendChild(seg.hit ? h('mark', { class: 'dk-pal-hit' }, seg.text) : document.createTextNode(seg.text));
    return span;
  }

  function row(r: RankedEntry, i: number, showGroup: boolean): HTMLElement {
    const item = h(
      'div',
      {
        class: ['dk-pal-item', i === active && 'dk-pal-active'],
        id: optionId(i),
        role: 'option',
        aria: { selected: String(i === active) },
        dataset: { entry: r.entry.id },
      },
      h('span', { class: 'dk-pal-icon' }, icon(r.entry.icon, 15)),
      h(
        'span',
        { class: 'dk-pal-text' },
        label(r),
        r.entry.detail ? h('span', { class: 'dk-pal-detail' }, r.entry.detail) : '',
      ),
      showGroup ? h('span', { class: 'dk-pal-group' }, r.recent ? 'Recent' : GROUP_LABEL[r.entry.group]) : '',
    );
    item.addEventListener('pointermove', () => {
      if (active !== i) setActive(i, false);
    });
    item.addEventListener('mousedown', (event) => event.preventDefault()); // keep focus in the input
    item.addEventListener('click', () => void runAt(i));
    return item;
  }

  function renderList(): void {
    const query = input.value.trim();
    ranked = rankEntries(entries, query, recentIds(ctx));
    if (active >= ranked.length) active = Math.max(0, ranked.length - 1);
    rows = [];
    const children: HTMLElement[] = [];
    if (!ranked.length) {
      children.push(h('div', { class: 'empty dk-pal-empty' }, query ? 'Nothing matches.' : 'Nothing to show yet.'));
    } else if (!query) {
      // Grouped: Recent, then each group in order.
      let lastGroup = '';
      ranked.forEach((r, i) => {
        const group = r.recent ? 'Recent' : GROUP_LABEL[r.entry.group];
        if (group !== lastGroup) {
          children.push(h('div', { class: 'dk-pal-heading', role: 'presentation' }, group));
          lastGroup = group;
        }
        const item = row(r, i, false);
        rows.push(item);
        children.push(item);
      });
    } else {
      ranked.forEach((r, i) => {
        const item = row(r, i, true);
        rows.push(item);
        children.push(item);
      });
    }
    replace(list, ...children);
    syncActive();
    status.textContent = query ? `${ranked.length} ${ranked.length === 1 ? 'result' : 'results'}` : '';
  }

  function syncActive(): void {
    rows.forEach((r, i) => {
      const on = i === active;
      r.classList.toggle('dk-pal-active', on);
      r.setAttribute('aria-selected', String(on));
    });
    if (rows[active]) input.setAttribute('aria-activedescendant', optionId(active));
    else input.removeAttribute('aria-activedescendant');
  }

  function setActive(i: number, scroll = true): void {
    if (!ranked.length) return;
    active = Math.min(Math.max(i, 0), ranked.length - 1);
    syncActive();
    if (scroll) rows[active]?.scrollIntoView?.({ block: 'nearest' });
  }

  function move(delta: number): void {
    if (!ranked.length) return;
    const n = ranked.length;
    if (Math.abs(delta) === 1) setActive((active + delta + n) % n);
    else setActive(active + delta);
  }

  async function runAt(i: number): Promise<void> {
    const r = ranked[i];
    if (!r) return;
    setOpen(false);
    remember(ctx, r.entry.id);
    try {
      await r.entry.run(ctx);
    } catch (e) {
      ctx.toast({ kind: 'error', text: r.entry.label, detail: (e as Error).message });
    }
  }

  function show(): void {
    if (open) return;
    open = true;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.value = '';
    active = 0;
    entries = collectEntries(ctx);
    renderList();
    el.hidden = false;
    popOpenScope = ctx.keys.push({
      name: 'palette',
      exclusive: true,
      bindings: [
        { key: 'Escape', inFields: true, run: () => setOpen(false), description: 'Close the palette' },
        { key: 'k', ctrl: true, inFields: true, run: () => setOpen(false), description: 'Close the palette' },
        { key: 'ArrowDown', inFields: true, run: () => move(1) },
        { key: 'ArrowUp', inFields: true, run: () => move(-1) },
        { key: 'PageDown', inFields: true, run: () => move(PAGE) },
        { key: 'PageUp', inFields: true, run: () => move(-PAGE) },
        { key: 'Enter', inFields: true, run: () => void runAt(active), description: 'Run the highlighted entry' },
        // A modal overlay: focus stays in its search field until it closes.
        { key: 'Tab', inFields: true, run: () => input.focus() },
        { key: 'Tab', shift: true, inFields: true, run: () => input.focus() },
      ],
    });
    input.focus();
  }

  function hide(): void {
    if (!open) return;
    open = false;
    el.hidden = true;
    popOpenScope?.();
    popOpenScope = null;
    replace(list);
    rows = [];
    ranked = [];
    entries = [];
    const back = returnFocus;
    returnFocus = null;
    if (back?.isConnected && document.activeElement !== back) back.focus();
  }

  const onInput = () => {
    active = 0;
    renderList();
  };
  const onBackdrop = (event: MouseEvent) => {
    if (event.target === el) setOpen(false);
  };
  input.addEventListener('input', onInput);
  el.addEventListener('mousedown', onBackdrop);

  const popShortcut = ctx.keys.push({
    name: 'palette-shortcut',
    bindings: [{ key: 'k', ctrl: true, inFields: true, run: () => toggle(), description: 'Open the command palette' }],
  });

  const unsubscribe = [
    ctx.store.subscribe('ui', (next, prev) => {
      if (next.paletteOpen === prev.paletteOpen) return;
      if (next.paletteOpen) show();
      else hide();
    }),
    ctx.store.subscribe('board', () => {
      if (!open) return;
      const keep = ranked[active]?.entry.id;
      entries = collectEntries(ctx);
      renderList();
      const at = keep ? ranked.findIndex((r) => r.entry.id === keep) : -1;
      if (at >= 0) setActive(at, false);
    }),
  ];

  container.appendChild(el);
  if (ctx.store.select('ui').paletteOpen) show();

  return {
    el,
    destroy() {
      for (const u of unsubscribe) u();
      popShortcut();
      popOpenScope?.();
      popOpenScope = null;
      input.removeEventListener('input', onInput);
      el.removeEventListener('mousedown', onBackdrop);
      el.remove();
    },
  };
}
