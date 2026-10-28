import type { StoredEvent } from './store.js';

export interface EventFilter {
  project_id?: string;
  /** Exact types or prefixes ending in `*`. */
  types?: string[];
}

export type EventHandler = (event: StoredEvent) => void;
export type Unsubscribe = () => void;

/** Spec Part 02 §8: semantics stay the same whatever carries the events. */
export interface EventTransport {
  publish(events: readonly StoredEvent[]): void;
  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe;
}

function matches(filter: EventFilter, e: StoredEvent): boolean {
  if (filter.project_id && filter.project_id !== e.project_id) return false;
  if (!filter.types || filter.types.length === 0) return true;
  return filter.types.some((t) => (t.endsWith('*') ? e.type.startsWith(t.slice(0, -1)) : e.type === t));
}

/**
 * In-process fan-out, called after a transaction commits. A failing subscriber never
 * affects the command that produced the event or other subscribers.
 */
export class InProcessTransport implements EventTransport {
  readonly #subs = new Set<{ filter: EventFilter; handler: EventHandler }>();

  constructor(private readonly onError: (err: unknown, event: StoredEvent) => void = () => {}) {}

  publish(events: readonly StoredEvent[]): void {
    for (const event of events) {
      for (const sub of [...this.#subs]) {
        if (!matches(sub.filter, event)) continue;
        try {
          sub.handler(event);
        } catch (err) {
          this.onError(err, event);
        }
      }
    }
  }

  subscribe(filter: EventFilter, handler: EventHandler): Unsubscribe {
    const sub = { filter, handler };
    this.#subs.add(sub);
    return () => {
      this.#subs.delete(sub);
    };
  }

  get subscriberCount(): number {
    return this.#subs.size;
  }
}
