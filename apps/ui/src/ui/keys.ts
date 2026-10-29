/**
 * In-page keyboard shortcuts. A shortcut is a key plus modifiers; scopes let a drawer, a modal or
 * the notch take the keys while open (the newest scope wins). Typing in a field is never hijacked
 * unless the binding says so.
 */

export interface Binding {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Fire even while focus is in a text field. */
  inFields?: boolean;
  run: (event: KeyboardEvent) => void;
  description?: string;
}

export interface Scope {
  readonly name: string;
  bindings: Binding[];
  /** When true, keys not bound here do not reach older scopes (modals). */
  exclusive?: boolean;
}

function isField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function matches(binding: Binding, event: KeyboardEvent): boolean {
  if (normalizeKey(binding.key) !== normalizeKey(event.key)) return false;
  const ctrl = event.ctrlKey || event.metaKey;
  return !!binding.ctrl === ctrl && !!binding.shift === event.shiftKey && !!binding.alt === event.altKey;
}

export class Keyboard {
  readonly #scopes: Scope[] = [];
  #attached = false;

  constructor(private readonly root: Pick<Window, 'addEventListener' | 'removeEventListener'> = window) {}

  attach(): void {
    if (this.#attached) return;
    this.#attached = true;
    this.root.addEventListener('keydown', this.#onKey as EventListener);
  }

  detach(): void {
    if (!this.#attached) return;
    this.#attached = false;
    this.root.removeEventListener('keydown', this.#onKey as EventListener);
  }

  /** Pushes a scope; returns the function that removes it. */
  push(scope: Scope): () => void {
    this.#scopes.push(scope);
    return () => {
      const i = this.#scopes.indexOf(scope);
      if (i >= 0) this.#scopes.splice(i, 1);
    };
  }

  /** Dispatches one event (exposed for tests). Returns true when a binding ran. */
  handle(event: KeyboardEvent): boolean {
    const inField = isField(event.target);
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      const scope = this.#scopes[i];
      if (!scope) continue;
      const binding = scope.bindings.find((b) => matches(b, event) && (b.inFields || !inField));
      if (binding) {
        event.preventDefault();
        binding.run(event);
        return true;
      }
      if (scope.exclusive) return false;
    }
    return false;
  }

  readonly #onKey = (event: KeyboardEvent): void => {
    this.handle(event);
  };
}
