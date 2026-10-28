import type { Clock, IdGenerator } from '@friday/core';
import { fromJson, type SqlDatabase, toJson } from '@friday/db';
import {
  type Actor,
  type DomainEvent,
  EVENT_SCHEMA_VERSION,
  FridayError,
  type RefKind,
  type Sensitivity,
} from '@friday/protocol';
import { Redactor } from './redaction.js';

/** Structured event payloads above this size are rejected (plan B23). Large text goes to artifacts. */
export const MAX_EVENT_PAYLOAD_BYTES = 64 * 1024;

export interface EventDraft {
  type: string;
  project_id: string;
  actor: Actor;
  payload: Record<string, unknown>;
  correlation_id?: string | null;
  caused_by?: string[];
  sensitivity?: Sensitivity;
  occurred_at?: string;
  refs?: { kind: RefKind; id: string }[];
  artifact_refs?: string[];
}

export type StoredEvent = DomainEvent;

export interface ReadOptions {
  /** Exact types or prefixes ending in `*` (e.g. `task.*`). */
  types?: string[];
  limit?: number;
}

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, sensitive: 2, secret: 3 };

interface EventRow {
  event_id: string;
  project_id: string;
  sequence: number;
  schema_version: number;
  type: string;
  actor_kind: string;
  actor_id: string;
  caused_by_json: string;
  correlation_id: string | null;
  occurred_at: string;
  recorded_at: string;
  payload_json: string;
  artifact_refs_json: string;
  sensitivity: Sensitivity;
  redaction_status: 'none' | 'redacted';
}

function toEvent(r: EventRow): StoredEvent {
  return {
    event_id: r.event_id as StoredEvent['event_id'],
    sequence: r.sequence,
    schema_version: r.schema_version,
    type: r.type,
    project_id: r.project_id as StoredEvent['project_id'],
    actor: { kind: r.actor_kind as Actor['kind'], id: r.actor_id },
    caused_by: fromJson(r.caused_by_json, []),
    correlation_id: r.correlation_id,
    occurred_at: r.occurred_at,
    recorded_at: r.recorded_at,
    payload: fromJson(r.payload_json, {}),
    sensitivity: r.sensitivity,
    redaction_status: r.redaction_status,
    artifact_refs: fromJson(r.artifact_refs_json, []),
  };
}

function typeFilter(types: string[] | undefined): { sql: string; params: string[] } {
  if (!types || types.length === 0) return { sql: '', params: [] };
  const parts: string[] = [];
  const params: string[] = [];
  for (const t of types) {
    if (t.endsWith('*')) {
      parts.push('type LIKE ?');
      params.push(`${t.slice(0, -1).replaceAll('%', '').replaceAll('_', '\\_')}%`);
    } else {
      parts.push('type = ?');
      params.push(t);
    }
  }
  return { sql: ` AND (${parts.map((p) => (p.includes('LIKE') ? `${p} ESCAPE '\\'` : p)).join(' OR ')})`, params };
}

/**
 * Append-only event store (spec Part 05 §9). Sequences are monotonic per project and are
 * allocated in the same transaction as the insert, so a rolled-back command leaves no gap.
 */
export class EventStore {
  readonly redactor: Redactor;

  constructor(
    private readonly db: SqlDatabase,
    private readonly deps: { ids: IdGenerator; clock: Clock; redactor?: Redactor },
  ) {
    this.redactor = deps.redactor ?? new Redactor();
  }

  append(draft: EventDraft): StoredEvent {
    if (!this.db.inTransaction) return this.db.transaction(() => this.append(draft));
    if (!draft.type) throw new FridayError('invalid_request', 'event type is required');

    const { value: payload, redacted } = this.redactor.redact(draft.payload);
    const payloadJson = toJson(payload);
    const bytes = Buffer.byteLength(payloadJson, 'utf8');
    if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
      throw new FridayError(
        'payload_too_large',
        `event ${draft.type} payload is ${bytes} bytes (limit ${MAX_EVENT_PAYLOAD_BYTES}); store large text as an artifact`,
        { type: draft.type, bytes, limit: MAX_EVENT_PAYLOAD_BYTES },
      );
    }
    let sensitivity: Sensitivity = draft.sensitivity ?? 'internal';
    if (redacted && SENSITIVITY_RANK[sensitivity] < SENSITIVITY_RANK.sensitive) sensitivity = 'sensitive';

    const seq = this.db
      .prepare(
        `INSERT INTO event_sequences (project_id, last_sequence) VALUES (?, 1)
         ON CONFLICT(project_id) DO UPDATE SET last_sequence = last_sequence + 1
         RETURNING last_sequence`,
      )
      .get<{ last_sequence: number }>(draft.project_id);
    if (!seq) throw new FridayError('internal_error', 'could not allocate an event sequence');

    const now = this.deps.clock.now();
    const event: StoredEvent = {
      event_id: this.deps.ids.next('evt'),
      sequence: seq.last_sequence,
      schema_version: EVENT_SCHEMA_VERSION,
      type: draft.type,
      project_id: draft.project_id as StoredEvent['project_id'],
      actor: draft.actor,
      caused_by: draft.caused_by ?? [],
      correlation_id: draft.correlation_id ?? null,
      occurred_at: draft.occurred_at ?? now,
      recorded_at: now,
      payload,
      sensitivity,
      redaction_status: redacted ? 'redacted' : 'none',
      artifact_refs: draft.artifact_refs ?? [],
    };
    this.db
      .prepare(
        `INSERT INTO events (event_id, project_id, sequence, schema_version, type, actor_kind, actor_id, caused_by_json,
          correlation_id, occurred_at, recorded_at, payload_json, artifact_refs_json, sensitivity, redaction_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.event_id,
        event.project_id,
        event.sequence,
        event.schema_version,
        event.type,
        event.actor.kind,
        event.actor.id,
        toJson(event.caused_by),
        event.correlation_id,
        event.occurred_at,
        event.recorded_at,
        payloadJson,
        toJson(event.artifact_refs),
        event.sensitivity,
        event.redaction_status,
      );
    const refStmt = this.db.prepare('INSERT OR IGNORE INTO event_refs (event_id, ref_kind, ref_id) VALUES (?, ?, ?)');
    for (const ref of draft.refs ?? []) refStmt.run(event.event_id, ref.kind, ref.id);
    return event;
  }

  /** Events with `sequence > since`, oldest first. */
  readSince(projectId: string, since = 0, opts: ReadOptions = {}): StoredEvent[] {
    const f = typeFilter(opts.types);
    return this.db
      .prepare(`SELECT * FROM events WHERE project_id = ? AND sequence > ?${f.sql} ORDER BY sequence LIMIT ?`)
      .all<EventRow>(projectId, since, ...f.params, opts.limit ?? 500)
      .map(toEvent);
  }

  readByCorrelation(projectId: string, correlationId: string): StoredEvent[] {
    return this.db
      .prepare('SELECT * FROM events WHERE project_id = ? AND correlation_id = ? ORDER BY sequence')
      .all<EventRow>(projectId, correlationId)
      .map(toEvent);
  }

  readByRef(projectId: string, kind: RefKind, id: string, opts: ReadOptions = {}): StoredEvent[] {
    const f = typeFilter(opts.types);
    return this.db
      .prepare(
        `SELECT e.* FROM events e JOIN event_refs r ON r.event_id = e.event_id
         WHERE e.project_id = ? AND r.ref_kind = ? AND r.ref_id = ?${f.sql.replaceAll('type', 'e.type')}
         ORDER BY e.sequence LIMIT ?`,
      )
      .all<EventRow>(projectId, kind, id, ...f.params, opts.limit ?? 500)
      .map(toEvent);
  }

  get(eventId: string): StoredEvent | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE event_id = ?').get<EventRow>(eventId);
    return row ? toEvent(row) : undefined;
  }

  /** Highest sequence for the project, 0 when empty. */
  head(projectId: string): number {
    return (
      this.db
        .prepare('SELECT last_sequence FROM event_sequences WHERE project_id = ?')
        .get<{ last_sequence: number }>(projectId)?.last_sequence ?? 0
    );
  }
}
