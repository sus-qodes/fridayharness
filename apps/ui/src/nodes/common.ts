/**
 * What every canvas card shares: the view contract the stage drives, pills and badges, action
 * buttons that show their call is running, and the few icons `ui/svg.ts` does not have.
 */
import { button, type Child, h } from '../ui/dom.js';
import { type IconName, icon, s } from '../ui/svg.js';

/** A card the stage places and updates; `update` re-renders only when what it shows changed. */
export interface NodeView<M> {
  readonly el: HTMLElement;
  update(model: M): void;
  /** The card moved: decision controls arm again (plan FD-28). */
  moved?(): void;
  destroy(): void;
}

export type Tone = 'good' | 'info' | 'warn' | 'danger' | 'muted' | 'strong';

export function badge(text: string, tone: Tone, title?: string): HTMLElement {
  return h('span', { class: `badge badge-${tone}`, ...(title ? { title } : {}) }, text);
}

export function pill(text: Child, cls = '', title?: string): HTMLElement {
  return h('span', { class: ['pill', 'nd-pill', cls], ...(title ? { title } : {}) }, text);
}

/** Up to `max` pills, then "+N". */
export function pills(values: readonly string[], max: number, make: (v: string) => HTMLElement): HTMLElement[] {
  const out = values.slice(0, max).map(make);
  if (values.length > max) out.push(pill(`+${values.length - max}`, 'nd-pill-more', values.slice(max).join('\n')));
  return out;
}

export type LocalIcon = 'lock' | 'unlink' | 'spinner' | 'layers';

const LOCAL: Record<LocalIcon, string[]> = {
  lock: ['M6 11h12v10H6z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  unlink: [
    'M9 15l-2 2a3 3 0 0 1-4-4l2-2',
    'M15 9l2-2a3 3 0 0 1 4 4l-2 2',
    'M8 4v2',
    'M4 8h2',
    'M16 20v-2',
    'M20 16h-2',
  ],
  spinner: ['M12 3a9 9 0 1 0 9 9'],
  layers: ['M12 3l9 5l-9 5l-9-5z', 'M3 13l9 5l9-5'],
};

/** An icon from the shared set or one drawn here. */
export function nodeIcon(name: IconName | LocalIcon, size = 14, label?: string): SVGSVGElement {
  if (!(name in LOCAL)) return icon(name as IconName, size, label);
  const el = s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.8,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: `icon nd-icon-${name}`,
    },
    ...LOCAL[name as LocalIcon].map((d) => s('path', { d })),
  );
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
    el.prepend(s('title', {}, label));
  } else el.setAttribute('aria-hidden', 'true');
  return el;
}

/**
 * A card action: an icon and a short label; while its call runs the button is disabled and says
 * so, and it comes back when the call settles.
 */
export function actionButton(
  label: string,
  iconName: IconName | LocalIcon,
  run: () => unknown,
  opts: { cls?: string; busyLabel?: string; title?: string; action?: string } = {},
): HTMLButtonElement {
  const text = h('span', { class: 'nd-act-label' }, label);
  const b = button(
    [nodeIcon(iconName, 13), text],
    (event) => {
      event.stopPropagation();
      if (b.disabled) return;
      const result = run();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        b.disabled = true;
        b.setAttribute('aria-busy', 'true');
        if (opts.busyLabel) text.textContent = opts.busyLabel;
        const settle = () => {
          b.disabled = false;
          b.removeAttribute('aria-busy');
          text.textContent = label;
        };
        (result as Promise<unknown>).then(settle, settle);
      }
    },
    {
      class: ['btn', 'btn-ghost', 'nd-act', opts.cls],
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.action ? { dataset: { action: opts.action } } : {}),
    },
  );
  return b;
}

/** A stable string of what a card shows, so updates that change nothing do no DOM work. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}

/** Sets a card's world position and size (the stage's layout decides them). */
export function place(el: HTMLElement, r: { x: number; y: number; w: number; h: number }): void {
  const t = `translate(${r.x}px, ${r.y}px)`;
  if (el.style.transform !== t) el.style.transform = t;
  const w = `${r.w}px`;
  const hh = `${r.h}px`;
  if (el.style.width !== w) el.style.width = w;
  if (el.style.height !== hh) el.style.height = hh;
}

/** True when the event started on a control inside the card (its own click handling applies). */
export function fromControl(event: Event): boolean {
  const t = event.target as Element | null;
  return !!t?.closest?.('button, a, input, textarea, select, [role="menu"], [role="menuitem"]');
}
