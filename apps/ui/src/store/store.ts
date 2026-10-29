/**
 * A small observable store (frontend handoff Part 07 §2.2): immutable slices, listeners per slice,
 * notified only when their slice's reference changed. No framework, no dependency.
 */

type Listener<V> = (next: V, prev: V) => void;

export class ObservableStore<T extends object> {
  #state: Readonly<T>;
  readonly #listeners = new Map<keyof T, Set<Listener<never>>>();
  readonly #any = new Set<(next: Readonly<T>, prev: Readonly<T>) => void>();

  constructor(initial: T) {
    this.#state = Object.freeze({ ...initial });
  }

  getState(): Readonly<T> {
    return this.#state;
  }

  select<K extends keyof T>(key: K): T[K] {
    return this.#state[key];
  }

  /** Calls `listener` whenever slice `key` changes; returns the unsubscribe function. */
  subscribe<K extends keyof T>(key: K, listener: Listener<T[K]>): () => void {
    let set = this.#listeners.get(key);
    if (!set) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(listener as Listener<never>);
    return () => set.delete(listener as Listener<never>);
  }

  /** Calls `listener` after every change of any slice. */
  subscribeAll(listener: (next: Readonly<T>, prev: Readonly<T>) => void): () => void {
    this.#any.add(listener);
    return () => this.#any.delete(listener);
  }

  setState(updater: Partial<T> | ((prev: Readonly<T>) => Partial<T>)): void {
    const prev = this.#state;
    const partial = typeof updater === 'function' ? updater(prev) : updater;
    let changed = false;
    for (const key of Object.keys(partial) as (keyof T)[]) {
      if (partial[key] !== prev[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    const next = Object.freeze({ ...prev, ...partial }) as Readonly<T>;
    this.#state = next;
    for (const [key, listeners] of this.#listeners) {
      if (prev[key] === next[key]) continue;
      for (const listener of [...listeners]) (listener as Listener<T[keyof T]>)(next[key], prev[key]);
    }
    for (const listener of [...this.#any]) listener(next, prev);
  }

  /** Replaces one field of an object slice. */
  patch<K extends keyof T>(key: K, changes: Partial<T[K]>): void {
    const current = this.#state[key];
    this.setState({ [key]: { ...current, ...changes } } as unknown as Partial<T>);
  }
}
