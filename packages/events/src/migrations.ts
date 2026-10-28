import type { Migration } from '@friday/db';

/** Event log tables (plan Appendix 1, migration 0001). Owned by @friday/events. */
export const EVENT_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'events',
    up: `
CREATE TABLE event_sequences (
  project_id TEXT PRIMARY KEY,
  last_sequence INTEGER NOT NULL
);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  caused_by_json TEXT NOT NULL DEFAULT '[]',
  correlation_id TEXT,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  artifact_refs_json TEXT NOT NULL DEFAULT '[]',
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public','internal','sensitive','secret')),
  redaction_status TEXT NOT NULL DEFAULT 'none' CHECK (redaction_status IN ('none','redacted')),
  UNIQUE (project_id, sequence)
);
CREATE INDEX ix_events_project_type ON events(project_id, type, sequence);
CREATE INDEX ix_events_corr ON events(correlation_id) WHERE correlation_id IS NOT NULL;
CREATE TABLE event_refs (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  PRIMARY KEY (ref_kind, ref_id, event_id)
);
CREATE TABLE event_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  up_to_sequence INTEGER NOT NULL,
  state_ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, up_to_sequence)
);
CREATE TABLE artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
`,
  },
];
