import type { SqlDatabase } from '@friday/db';
import type { EventStore, StoredEvent } from './store.js';

/** Rebuilds domain tables from events (spec Part 11 §9). Implemented by @friday/state. */
export interface Projector {
  /** Deletes every domain row for the project before a replay. */
  reset(projectId: string): void;
  apply(event: StoredEvent): void;
}

/** Placeholder until snapshots land in M3; replay always starts from sequence 0. */
export interface SnapshotStore {
  latest(projectId: string): { up_to_sequence: number } | null;
}
export const nullSnapshotStore: SnapshotStore = { latest: () => null };

/** Replays every event (optionally up to `toSequence`) through the projector in one transaction. */
export function replay(
  db: SqlDatabase,
  store: EventStore,
  projectId: string,
  projector: Projector,
  opts: { toSequence?: number; batch?: number } = {},
): { applied: number } {
  const batch = opts.batch ?? 1000;
  return db.transaction(() => {
    projector.reset(projectId);
    let since = 0;
    let applied = 0;
    for (;;) {
      const events = store.readSince(projectId, since, { limit: batch });
      if (events.length === 0) break;
      for (const e of events) {
        if (opts.toSequence !== undefined && e.sequence > opts.toSequence) return { applied };
        projector.apply(e);
        applied += 1;
        since = e.sequence;
      }
    }
    return { applied };
  });
}
