/**
 * Building blocks the panels share: labelled fields, list editors, copyable commands, links that
 * open another drawer or modal, the planner's state in interface words, and error reading.
 * Every daemon string becomes a text node (plan FD-20); agent-written text that a human decides
 * on goes through `visible()` (plan §6.2).
 */
import type { BrainStatusView } from '@friday/protocol';
import { hasHidden, visible } from '../model/text.js';
import { ApiError } from '../platform/transport.js';
import type { AppContext } from '../shell/context.js';
import { button, type Child, h, type Props } from '../ui/dom.js';
import { cleanText, truncate } from '../ui/format.js';
import { s } from '../ui/svg.js';

let counter = 0;

/** A unique element id for label `for` and `aria-describedby`. */
export function uid(prefix = 'pn'): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

export interface Field {
  el: HTMLElement;
  control: HTMLElement;
  error: HTMLElement;
  setError(message: string | null): void;
}

/** A label, its control, an optional hint and an error line (hidden while empty). */
export function field(label: string, control: HTMLElement, opts: { hint?: string; class?: string } = {}): Field {
  const id = control.id || uid('pn-f');
  control.id = id;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const error = h('div', { class: 'field-error', id: errorId, hidden: true, role: 'alert' });
  const hint = opts.hint ? h('div', { class: 'field-hint', id: hintId }, opts.hint) : null;
  control.setAttribute('aria-describedby', [hint ? hintId : '', errorId].filter(Boolean).join(' '));
  const el = h(
    'div',
    { class: ['field', opts.class] },
    h('label', { class: 'field-label', for: id }, label),
    control,
    hint,
    error,
  );
  return {
    el,
    control,
    error,
    setError(message) {
      error.hidden = !message;
      error.textContent = message ?? '';
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
  };
}

/** A group of controls with one caption (a fieldset), for checkbox lists and segmented choices. */
export function group(legend: string, ...children: Child[]): HTMLFieldSetElement {
  return h('fieldset', { class: 'pn-group' }, h('legend', { class: 'field-label' }, legend), ...children);
}

export function input(props: Props & { value?: string } = {}): HTMLInputElement {
  return h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: false, ...props });
}

export function textarea(props: Props & { value?: string } = {}): HTMLTextAreaElement {
  const el = h('textarea', { class: 'textarea', ...props });
  if (props.value !== undefined) el.value = props.value;
  return el;
}

export interface Option<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export function select<T extends string>(
  options: readonly Option<T>[],
  value: T,
  onChange: (value: T) => void,
  props: Props = {},
): HTMLSelectElement {
  const el = h(
    'select',
    { class: 'select', ...props },
    options.map((o) => {
      const opt = h('option', { value: o.value }, o.label);
      if (o.disabled) opt.disabled = true;
      return opt;
    }),
  );
  el.value = value;
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

/** Exclusive choices as pressed buttons (`.segmented`), reachable by Tab, chosen by click or Enter. */
export function segmented<T extends string>(
  label: string,
  options: readonly Option<T>[],
  value: T,
  onChange: (value: T) => void,
): HTMLElement {
  const buttons: HTMLButtonElement[] = options.map((o) =>
    button(
      o.label,
      () => {
        for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === o.value));
        onChange(o.value);
      },
      { class: 'pn-seg', aria: { pressed: o.value === value }, dataset: { value: o.value }, disabled: !!o.disabled },
    ),
  );
  return h('div', { class: 'segmented', role: 'group', aria: { label } }, buttons);
}

export function checkbox(
  label: Child,
  checked: boolean,
  onChange: (checked: boolean) => void,
  props: Props = {},
): HTMLLabelElement {
  const box = h('input', { type: 'checkbox', checked, ...props });
  box.addEventListener('change', () => onChange(box.checked));
  return h('label', { class: 'check' }, box, h('span', null, label));
}

/** A text button that opens another place (a drawer, a modal, a section). */
export function linkButton(label: string, onClick: () => void, ariaLabel?: string): HTMLButtonElement {
  return button(label, () => onClick(), { class: 'btn btn-ghost pn-link', ...(ariaLabel ? { ariaLabel } : {}) });
}

export function section(title: string, ...children: Child[]): HTMLElement {
  return h('section', { class: 'pn-section' }, h('h3', { class: 'section-title' }, title), ...children);
}

export function note(...children: Child[]): HTMLElement {
  return h('p', { class: 'pn-note muted' }, ...children);
}

/**
 * A fold (`<details>`), closed unless `open` says otherwise, for what a person seldom needs: the
 * Notch timings under "Advanced", a dialog's host options under "Options", the plan editor's JSON
 * tools under "More" (review §4). What is inside stays in the page, so a test or a screen reader
 * finds it; a browser shows it once the summary is clicked.
 */
export function fold(
  summary: string,
  opts: { open?: boolean; class?: string } = {},
  ...children: Child[]
): HTMLDetailsElement {
  const el = h(
    'details',
    { class: ['pn-fold', opts.class] },
    h('summary', { class: 'pn-fold-summary' }, summary),
    ...children,
  );
  if (opts.open) el.open = true;
  return el;
}

export function badge(
  text: string,
  tone: 'good' | 'info' | 'warn' | 'danger' | 'muted' | 'strong',
  title?: string,
): HTMLElement {
  return h('span', { class: `badge badge-${tone}`, ...(title ? { title } : {}) }, text);
}

/**
 * Agent- or repository-written text a human decides on: wrapped, monospaced, in full, with hidden
 * characters as visible marks and a warning when there are any (plan FD-28).
 */
export function agentText(text: string, tag: 'div' | 'pre' | 'code' = 'div'): HTMLElement {
  const box = h(tag, { class: 'agent-text' }, visible(text));
  if (!hasHidden(text)) return box;
  return h(
    'div',
    { class: 'pn-agent' },
    box,
    h('div', { class: 'hidden-warning' }, 'This text holds hidden characters, shown as ⟨U+…⟩ marks.'),
  );
}

/** A file, branch or glob name in one line: visible marks, monospaced. */
export function pathText(path: string, cls?: string): HTMLElement {
  return h('span', { class: ['mono', 'pn-path', cls], title: visible(path) }, visible(path));
}

/** A copy icon (two sheets), drawn here because the shared set has none. */
export function copyIcon(size = 14): SVGSVGElement {
  return s(
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
      class: 'icon',
      'aria-hidden': 'true',
    },
    s('path', { d: 'M9 9h11v11H9z' }),
    s('path', { d: 'M5 15H4V4h11v1' }),
  );
}

/** A summary or a log line: escape sequences removed, shortened. */
export function plain(text: string | null | undefined, max = 400): string {
  return truncate(cleanText(text ?? ''), max);
}

/**
 * A command a human copies into a terminal, with a copy button. A command with hidden characters
 * is shown with its marks and cannot be copied.
 */
export function copyLine(ctx: AppContext, command: string, what = 'command'): HTMLElement {
  const hidden = hasHidden(command);
  const copy = button(
    copyIcon(),
    () => {
      void ctx.platform
        .copy(command)
        .then((ok) =>
          ctx.toast(
            ok
              ? { kind: 'success', text: `Copied the ${what}` }
              : { kind: 'warn', text: 'This page may not copy; select the text and copy it' },
          ),
        );
    },
    { class: 'btn btn-icon pn-copy', ariaLabel: `Copy the ${what}`, title: `Copy the ${what}`, disabled: hidden },
  );
  return h(
    'div',
    { class: 'pn-cmd' },
    h('code', { class: 'agent-text pn-cmd-text' }, visible(command)),
    copy,
    hidden ? h('div', { class: 'hidden-warning' }, 'Hidden characters: not copied.') : null,
  );
}

/** An error list beside a form (`role="alert"`, hidden while empty). */
export function errorBox(title: string): { el: HTMLElement; set(errors: readonly string[]): void } {
  const list = h('ul', { class: 'pn-errors-list' });
  const el = h(
    'div',
    { class: 'pn-errors', role: 'alert', hidden: true },
    h('div', { class: 'pn-errors-title' }, title),
    list,
  );
  return {
    el,
    set(errors) {
      el.hidden = errors.length === 0;
      list.replaceChildren(...errors.map((e) => h('li', null, plain(e, 2000))));
    },
  };
}

/** What a failed daemon call said: its code, message and `details.errors` (plan validation). */
export function errorOf(e: unknown): { status: number | null; code: string | null; message: string; errors: string[] } {
  if (e instanceof ApiError) {
    const details = e.details as { errors?: unknown } | undefined;
    const errors = Array.isArray(details?.errors)
      ? details.errors.filter((x): x is string => typeof x === 'string')
      : [];
    return { status: e.status, code: e.code, message: e.message, errors };
  }
  return { status: null, code: null, message: e instanceof Error ? e.message : String(e), errors: [] };
}

/**
 * Runs a user action through `ctx.act` (which shows the toast) and also hands the error to
 * `onError`, so a form can show it beside its fields.
 */
export async function actWithError<T>(
  ctx: AppContext,
  label: string,
  call: () => Promise<T>,
  onError: (e: ReturnType<typeof errorOf>) => void,
  success?: string | ((r: T) => string),
): Promise<T | undefined> {
  return ctx.act(
    label,
    async () => {
      try {
        return await call();
      } catch (e) {
        onError(errorOf(e));
        throw e;
      }
    },
    success,
  );
}

/** The project's root joined with a relative path, with forward slashes. */
export function projectPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${rel}`;
}

export interface PlannerState {
  ready: boolean;
  /** One line for the interface. */
  text: string;
  /** What a human does about it, in interface words. */
  fixes: string[];
}

/**
 * The Master Brain's state in interface words (plan §7.1, §7.7): the daemon's reason is a CLI hint,
 * so the structured fields decide the words, and the reason is kept only when nothing else says why.
 */
export function plannerState(brain: BrainStatusView | null | undefined): PlannerState {
  if (!brain) {
    return { ready: false, text: 'The Master Brain is not running in this Friday.', fixes: [] };
  }
  if (brain.planner_available) {
    return {
      ready: true,
      text: `The Master Brain can plan (${plain(brain.provider, 40)} · ${plain(brain.model, 80)}).`,
      fixes: [],
    };
  }
  const fixes: string[] = [];
  if (brain.remote && brain.key === 'missing') fixes.push('store a provider key');
  if (brain.remote && !brain.approved_here) fixes.push('allow this clone to spend');
  if (brain.remote && !brain.allow_remote) fixes.push("the project's config does not allow remote planning");
  if (fixes.length === 0) {
    const why = brain.reason ? plain(brain.reason, 300) : 'it is not available';
    return { ready: false, text: `The Master Brain cannot plan: ${why}.`, fixes: [] };
  }
  return { ready: false, text: `The Master Brain cannot plan yet: ${fixes.join('; ')}.`, fixes };
}

/** The panel body's frame: a scrolling column. */
export function panel(cls: string, ...children: Child[]): HTMLElement {
  return h('div', { class: ['pn-panel', cls] }, ...children);
}

/** Collects teardown work of a panel. */
export class Teardown {
  readonly #fns: (() => void)[] = [];
  #done = false;

  add(fn: () => void): void {
    if (this.#done) fn();
    else this.#fns.push(fn);
  }

  get done(): boolean {
    return this.#done;
  }

  run(): void {
    if (this.#done) return;
    this.#done = true;
    for (const fn of this.#fns.splice(0).reverse()) {
      try {
        fn();
      } catch {
        // one failing teardown must not keep the others from running
      }
    }
  }
}
