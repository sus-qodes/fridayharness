/**
 * @friday/events
 * Append-only event store, in-process transport, redaction, artifacts and replay.
 */
export const PACKAGE_NAME = '@friday/events';

export { type ArtifactRecord, ArtifactStore, artifactRef } from './artifacts.js';
export { EVENT_MIGRATIONS } from './migrations.js';
export { findCredentials, Redactor, truncateText } from './redaction.js';
export { nullSnapshotStore, type Projector, replay, type SnapshotStore } from './replay.js';
export { type EventDraft, EventStore, MAX_EVENT_PAYLOAD_BYTES, type ReadOptions, type StoredEvent } from './store.js';
export {
  type EventFilter,
  type EventHandler,
  type EventTransport,
  InProcessTransport,
  type Unsubscribe,
} from './transport.js';
