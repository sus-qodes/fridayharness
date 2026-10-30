/**
 * The mascot's thought bubble (plan §7.10 onboarding): a small glass bubble with what Friday
 * "says" — a first-person line and optional actions. Text is typed out (instantly under reduced
 * motion); the caller positions the bubble. Pure DOM, no timers beyond the typing one.
 */
import { button, h } from '../ui/dom.js';

export interface BubbleAction {
  id: string;
  label: string;
  kind?: 'primary' | 'ghost';
}

export interface BubbleMessage {
  /** A short heading above the body (rare; the body is the voice). */
  title?: string;
  /** What Friday says, first person. */
  body: string;
  /** Buttons under the body. */
  actions?: readonly BubbleAction[];
  /** A small muted progress line under the actions (`Step 2 of 6`). */
  meta?: string;
}

export interface BubbleEnv {
  doc: Document;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** True when motion should be instant. */
  reduced(): boolean;
}

export function defaultBubbleEnv(): BubbleEnv {
  const w = typeof window !== 'undefined' ? window : null;
  return {
    doc: document,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    reduced: () => {
      try {
        return Boolean(w?.matchMedia('(prefers-reduced-motion: reduce)')?.matches);
      } catch {
        return false;
      }
    },
  };
}

/** Characters revealed per typing tick. */
const TYPE_CHARS = 2;
/** Milliseconds between typing ticks. */
const TYPE_MS = 24;

export interface BubbleHandle {
  readonly el: HTMLElement;
  /** Shows a message; replaces whatever the bubble said. */
  show(message: BubbleMessage): void;
  /** Empties the bubble and hides it. */
  clear(): void;
  readonly visible: boolean;
  /** True while the typewriter is still revealing the body. */
  readonly typing: boolean;
  /** Listens to every action click for the bubble's lifetime. */
  onAction(listener: (action: BubbleAction) => void): () => void;
  destroy(): void;
}

export function createBubble(env: BubbleEnv = defaultBubbleEnv()): BubbleHandle {
  const listeners = new Set<(action: BubbleAction) => void>();

  const el = env.doc.createElement('div');
  el.className = 'ms-bubble';
  el.setAttribute('role', 'status');
  el.hidden = true;

  const title = h('div', { class: 'ms-bubble-title' });
  const body = h('div', { class: 'ms-bubble-body' });
  const actions = h('div', { class: 'ms-bubble-actions' });
  const meta = h('div', { class: 'ms-bubble-meta' });
  el.append(title, body, actions, meta);

  let timer: unknown = null;
  let full = '';
  let shown = 0;
  let visible = false;

  function stopTyping(): void {
    if (timer !== null) env.clearTimeout(timer);
    timer = null;
  }

  function type(): void {
    timer = null;
    if (shown >= full.length) {
      body.textContent = full;
      return;
    }
    shown = Math.min(full.length, shown + TYPE_CHARS);
    body.textContent = full.slice(0, shown);
    timer = env.setTimeout(type, TYPE_MS);
  }

  function clearActions(): void {
    while (actions.firstChild) actions.firstChild.remove();
  }

  return {
    el,
    get visible() {
      return visible;
    },
    get typing() {
      return timer !== null;
    },
    show(message: BubbleMessage): void {
      stopTyping();
      clearActions();
      title.textContent = message.title ?? '';
      title.hidden = !message.title;
      full = message.body;
      shown = 0;
      meta.textContent = message.meta ?? '';
      meta.hidden = !message.meta;
      for (const action of message.actions ?? []) {
        const b = button(
          action.label,
          () => {
            for (const listener of listeners) listener(action);
          },
          { class: action.kind === 'primary' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost' },
        );
        b.dataset.action = action.id;
        actions.append(b);
      }
      actions.hidden = actions.childElementCount === 0;
      visible = true;
      el.hidden = false;
      if (env.reduced() || full.length <= TYPE_CHARS) {
        shown = full.length;
        body.textContent = full;
      } else {
        body.textContent = '';
        timer = env.setTimeout(type, TYPE_MS);
      }
    },
    clear(): void {
      stopTyping();
      clearActions();
      full = '';
      shown = 0;
      body.textContent = '';
      title.textContent = '';
      meta.textContent = '';
      meta.hidden = true;
      visible = false;
      el.hidden = true;
    },
    onAction(listener: (action: BubbleAction) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy(): void {
      stopTyping();
      listeners.clear();
      el.remove();
    },
  };
}
