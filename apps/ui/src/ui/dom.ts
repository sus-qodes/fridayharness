/**
 * DOM builders. Every element of the interface is made here, and every string becomes a text node:
 * no HTML parsing anywhere (plan FD-20). Text that agents and repositories write (summaries,
 * messages, file names, diffs) is shown, never interpreted.
 */

export type Child = Node | string | number | null | undefined | false | readonly Child[];

type Handler<E extends Event> = (event: E) => void;
type Handlers = { [K in keyof HTMLElementEventMap]?: Handler<HTMLElementEventMap[K]> };

export interface Props {
  class?: string | readonly (string | false | null | undefined)[];
  id?: string;
  role?: string;
  title?: string;
  type?: string;
  name?: string;
  value?: string;
  placeholder?: string;
  tabIndex?: number;
  disabled?: boolean;
  checked?: boolean;
  hidden?: boolean;
  draggable?: boolean;
  autocomplete?: string;
  spellcheck?: boolean;
  for?: string;
  rows?: number;
  min?: string;
  max?: string;
  step?: string;
  maxLength?: number;
  dataset?: Record<string, string>;
  aria?: Record<string, string | number | boolean>;
  /** Other attributes; event-handler attributes (`on…`) and URL attributes are refused. */
  attrs?: Record<string, string>;
  style?: Partial<Record<StyleKey, string>>;
  on?: Handlers;
  ref?: (el: HTMLElement) => void;
}

type StyleKey = Extract<
  {
    [K in keyof CSSStyleDeclaration]: CSSStyleDeclaration[K] extends string ? K : never;
  }[keyof CSSStyleDeclaration],
  string
>;

const REFUSED_ATTRIBUTES = /^(on|srcdoc$|formaction$|action$|href$|src$|xlink:href$)/i;

export function className(value: Props['class']): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.filter(Boolean).join(' ');
}

/** Appends children: strings and numbers become text nodes, arrays are flattened, falsy values skipped. */
export function append(parent: Node, ...children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, ...(child as Child[]));
    else if (typeof child === 'string' || typeof child === 'number')
      parent.appendChild(document.createTextNode(String(child)));
    else parent.appendChild(child as Node);
  }
}

export function applyProps(el: HTMLElement, props: Props | null | undefined): void {
  if (!props) return;
  const cls = className(props.class);
  if (cls) el.className = cls;
  if (props.id !== undefined) el.id = props.id;
  if (props.role !== undefined) el.setAttribute('role', props.role);
  if (props.title !== undefined) el.title = props.title;
  if (props.type !== undefined) el.setAttribute('type', props.type);
  if (props.name !== undefined) el.setAttribute('name', props.name);
  if (props.placeholder !== undefined) el.setAttribute('placeholder', props.placeholder);
  if (props.autocomplete !== undefined) el.setAttribute('autocomplete', props.autocomplete);
  if (props.for !== undefined) el.setAttribute('for', props.for);
  if (props.min !== undefined) el.setAttribute('min', props.min);
  if (props.max !== undefined) el.setAttribute('max', props.max);
  if (props.step !== undefined) el.setAttribute('step', props.step);
  if (props.rows !== undefined) el.setAttribute('rows', String(props.rows));
  if (props.maxLength !== undefined) el.setAttribute('maxlength', String(props.maxLength));
  if (props.tabIndex !== undefined) el.tabIndex = props.tabIndex;
  if (props.hidden !== undefined) el.hidden = props.hidden;
  if (props.draggable !== undefined) el.draggable = props.draggable;
  if (props.spellcheck !== undefined) el.spellcheck = props.spellcheck;
  if (props.disabled !== undefined) (el as HTMLButtonElement).disabled = props.disabled;
  if (props.checked !== undefined) (el as HTMLInputElement).checked = props.checked;
  if (props.value !== undefined) (el as HTMLInputElement).value = props.value;
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) el.dataset[k] = v;
  if (props.aria) for (const [k, v] of Object.entries(props.aria)) el.setAttribute(`aria-${k}`, String(v));
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (REFUSED_ATTRIBUTES.test(k)) throw new Error(`attribute ${k} is not allowed`);
      el.setAttribute(k, v);
    }
  }
  if (props.style) for (const [k, v] of Object.entries(props.style)) setStyle(el, k as StyleKey, v);
  if (props.on) {
    for (const [event, handler] of Object.entries(props.on)) {
      if (handler) el.addEventListener(event, handler as EventListener);
    }
  }
  props.ref?.(el);
}

function setStyle(el: HTMLElement, key: StyleKey, value: string | undefined): void {
  if (value === undefined) return;
  if (key.startsWith('--')) el.style.setProperty(key, value);
  else (el.style as unknown as Record<string, string>)[key] = value;
}

/** Creates an element: `h('button', {class: 'btn', on: {click}}, 'Approve')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, ...children);
  return el;
}

/** Replaces an element's children. */
export function replace(el: Node, ...children: Child[]): void {
  (el as ParentNode).replaceChildren();
  append(el, ...children);
}

/** Sets text, only when it changed (cheap re-renders). */
export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function toggleClass(el: Element, name: string, on: boolean): void {
  el.classList.toggle(name, on);
}

/** A custom property such as `--x`, set only when it changed. */
export function setVar(el: HTMLElement, name: `--${string}`, value: string): void {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/** A button that is always `type="button"` and has an accessible name. */
export function button(
  label: Child,
  onClick: (event: MouseEvent) => void,
  props: Props & { ariaLabel?: string } = {},
): HTMLButtonElement {
  const { ariaLabel, ...rest } = props;
  const el = h('button', { type: 'button', ...rest, class: className(rest.class) || 'btn' }, label);
  if (ariaLabel) el.setAttribute('aria-label', ariaLabel);
  el.addEventListener('click', onClick);
  return el;
}
