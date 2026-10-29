/**
 * Building blocks the drawers share: accessible tabs, sections, key–value rows, badges, a meter,
 * loading and error notes, and the path helpers for "Open in VS Code". DOM only through `h()`.
 */
import { statusLook } from '../model/status.js';
import { visible } from '../model/text.js';
import { ApiError } from '../platform/transport.js';
import { type Child, h, setVar } from '../ui/dom.js';

export type Tone = 'good' | 'info' | 'warn' | 'danger' | 'muted' | 'strong';

export function badge(text: string, tone: Tone = 'muted', title?: string): HTMLSpanElement {
  return h('span', { class: `badge badge-${tone}`, ...(title ? { title } : {}) }, text);
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'dr-section' }, h('h3', { class: 'section-title' }, title), ...children);
}

/** A definition list of label → value rows. */
export function facts(rows: [string, Child][]): HTMLDListElement {
  return h(
    'dl',
    { class: 'dr-facts' },
    rows.map(([label, value]) => [h('dt', null, label), h('dd', null, value ?? '—')]),
  );
}

/** A value an agent or a repository wrote that a human acts on (a path, a branch): visible marks, monospaced. */
export function mono(text: string, cls = ''): HTMLElement {
  return h('span', { class: ['dr-mono', cls] }, visible(text));
}

export function statusPill(status: string): HTMLSpanElement {
  const look = statusLook(status);
  const el = h('span', { class: 'dr-status' }, look.label);
  setVar(el, '--dr-status', look.color);
  return el;
}

export function loading(text = 'Loading…'): HTMLElement {
  return h('div', { class: 'dr-loading', role: 'status' }, text);
}

/** An error note: Friday's code and message, never an HTTP text. */
export function errorNote(prefix: string, e: unknown): HTMLElement {
  const code = e instanceof ApiError ? e.code : null;
  const message = e instanceof Error ? e.message : String(e);
  return h('div', { class: 'dr-error', role: 'alert' }, `${prefix}: `, code ? `${code} ` : '', message);
}

export function empty(text: string): HTMLElement {
  return h('div', { class: ['empty', 'dr-empty'] }, text);
}

/** A horizontal meter with an accessible value (0–1). */
export function meter(fraction: number, label: string, tone: Tone = 'info'): HTMLElement {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const fill = h('span', { class: 'dr-meter-fill' });
  const el = h(
    'div',
    {
      class: ['dr-meter', `dr-meter-${tone}`],
      role: 'meter',
      aria: { valuemin: 0, valuemax: 100, valuenow: Math.round(f * 100), label },
      title: label,
    },
    fill,
  );
  setVar(el, '--dr-fill', `${(f * 100).toFixed(1)}%`);
  return el;
}

export interface TabSpec<T extends string> {
  id: T;
  label: string;
}

export interface Tabs<T extends string> {
  readonly el: HTMLElement;
  select(id: T, focus?: boolean): void;
  current(): T;
  setHidden(id: T, hidden: boolean): void;
  button(id: T): HTMLButtonElement | undefined;
}

let tabSeq = 0;

/** An ARIA tab list with a roving tab stop (arrows, Home, End). The caller shows the panels. */
export function tabs<T extends string>(specs: TabSpec<T>[], initial: T, onChange: (id: T) => void): Tabs<T> {
  const base = `dr-tab-${++tabSeq}`;
  let current = specs.some((s) => s.id === initial) ? initial : (specs[0]?.id as T);
  const buttons = new Map<T, HTMLButtonElement>();
  const list = h('div', { class: 'dr-tabs', role: 'tablist' });
  const visibleIds = () => specs.map((s) => s.id).filter((id) => !buttons.get(id)?.hidden);
  const update = () => {
    for (const [id, b] of buttons) {
      const on = id === current;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('dr-tab-on', on);
    }
  };
  const select = (id: T, focus = false) => {
    if (!buttons.has(id)) return;
    const changed = id !== current;
    current = id;
    update();
    if (focus) buttons.get(id)?.focus();
    if (changed) onChange(id);
  };
  for (const spec of specs) {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'dr-tab',
        role: 'tab',
        id: `${base}-${spec.id}`,
        aria: { controls: `${base}-${spec.id}-panel`, selected: false },
        dataset: { tab: spec.id },
        on: {
          click: () => select(spec.id),
          keydown: (e: KeyboardEvent) => {
            const ids = visibleIds();
            const i = ids.indexOf(current);
            let next: T | undefined;
            if (e.key === 'ArrowRight') next = ids[(i + 1) % ids.length];
            else if (e.key === 'ArrowLeft') next = ids[(i - 1 + ids.length) % ids.length];
            else if (e.key === 'Home') next = ids[0];
            else if (e.key === 'End') next = ids[ids.length - 1];
            if (next !== undefined) {
              e.preventDefault();
              select(next, true);
            }
          },
        },
      },
      spec.label,
    );
    buttons.set(spec.id, b);
    list.append(b);
  }
  update();
  return {
    el: list,
    select,
    current: () => current,
    setHidden: (id, hidden) => {
      const b = buttons.get(id);
      if (b) b.hidden = hidden;
      if (hidden && current === id && specs[0]) select(specs[0].id);
    },
    button: (id) => buttons.get(id),
  };
}

/** The panel element a tab controls. */
export function tabPanel(t: Tabs<string>, id: string, ...children: Child[]): HTMLElement {
  const tabId = t.button(id)?.id ?? '';
  return h('div', { class: 'dr-panel', role: 'tabpanel', id: `${tabId}-panel`, aria: { labelledby: tabId } }, children);
}

/** `C:/wt/abc` + `src/a.ts` → `C:/wt/abc/src/a.ts` (forward slashes; VS Code accepts them on Windows). */
export function joinPath(root: string | null | undefined, rel: string): string {
  const r = (root ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const p = rel.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!r) return p;
  return `${r}/${p}`;
}

/** The first 7 characters of a commit. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}
