import { createHash } from 'node:crypto';
import type { Clock, IdGenerator } from '@friday/core';
import { type SqlDatabase, toJson } from '@friday/db';
import type { EventDraft, EventStore, EventTransport, StoredEvent } from '@friday/events';
import { type Actor, FridayError, isFridayError } from '@friday/protocol';
import type { StateProjector } from './projector.js';

export interface CommandMeta {
  /** Command name, e.g. `task.claim`; part of the idempotency scope. */
  name: string;
  project_id: string;
  actor: Actor;
  idempotency_key?: string | undefined;
  correlation_id?: string | null | undefined;
  /** The request, hashed to detect a reused idempotency key with different content. */
  params?: unknown;
}

export type DraftInput = Omit<EventDraft, 'project_id' | 'actor' | 'correlation_id' | 'occurred_at'> & {
  actor?: Actor;
};

export interface CommandContext {
  readonly project_id: string;
  readonly actor: Actor;
  readonly correlation_id: string | null;
  /** One timestamp for the whole command. */
  readonly now: string;
  readonly ids: IdGenerator;
  readonly db: SqlDatabase;
  /** Appends the event and applies it to the domain tables immediately (same transaction). */
  emit(draft: DraftInput): StoredEvent;
  readonly events: readonly StoredEvent[];
}

export interface CommandOutcome<T> {
  result: T;
  events: StoredEvent[];
  /** True when an earlier response was returned for a repeated idempotency key. */
  replayed: boolean;
}

/** Deterministic JSON for hashing (keys sorted at every level). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

const PROTOCOL_ACTORS = new Set(['agent', 'harness']);

/**
 * Executes commands atomically: idempotency check → handler (which emits events that are
 * appended and projected in the same transaction) → idempotency record → commit → publish.
 * Spec Part 02 §4: Command → validated transition → event → subscribers → projection.
 */
export class CommandBus {
  constructor(
    private readonly deps: {
      db: SqlDatabase;
      store: EventStore;
      projector: StateProjector;
      transport: EventTransport;
      ids: IdGenerator;
      clock: Clock;
      idempotencyTtlMs: number;
    },
  ) {}

  execute<T>(meta: CommandMeta, handler: (ctx: CommandContext) => T): CommandOutcome<T> {
    const { db, store, projector, transport, ids, clock } = this.deps;
    const scope = `${meta.project_id}|${meta.actor.kind}:${meta.actor.id}|${meta.name}`;
    const requestHash = createHash('sha256')
      .update(stableStringify(meta.params ?? null))
      .digest('hex');
    let outcome: CommandOutcome<T>;
    try {
      outcome = db.transaction(() => {
        const now = clock.now();
        if (meta.idempotency_key) {
          const prior = db
            .prepare(
              'SELECT request_hash, response_json FROM idempotency_keys WHERE scope = ? AND key = ? AND expires_at > ?',
            )
            .get<{ request_hash: string; response_json: string }>(scope, meta.idempotency_key, now);
          if (prior) {
            if (prior.request_hash !== requestHash) {
              throw new FridayError(
                'idempotency_key_conflict',
                `idempotency key "${meta.idempotency_key}" was already used for a different ${meta.name} request`,
              );
            }
            return { result: JSON.parse(prior.response_json) as T, events: [], replayed: true };
          }
        }
        const events: StoredEvent[] = [];
        const ctx: CommandContext = {
          project_id: meta.project_id,
          actor: meta.actor,
          correlation_id: meta.correlation_id ?? null,
          now,
          ids,
          db,
          events,
          emit: (draft) => {
            const { actor, ...rest } = draft;
            const event = store.append({
              ...rest,
              project_id: meta.project_id,
              actor: actor ?? meta.actor,
              correlation_id: meta.correlation_id ?? null,
              occurred_at: now,
            });
            projector.apply(event);
            events.push(event);
            return event;
          },
        };
        const result = handler(ctx);
        if (meta.idempotency_key) {
          db.prepare(
            `INSERT INTO idempotency_keys (scope, key, request_hash, response_json, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(
            scope,
            meta.idempotency_key,
            requestHash,
            toJson(result),
            now,
            new Date(Date.parse(now) + this.deps.idempotencyTtlMs).toISOString(),
          );
        }
        return { result, events, replayed: false };
      });
    } catch (err) {
      this.recordRejection(meta, err);
      throw err;
    }
    transport.publish(outcome.events);
    return outcome;
  }

  /** Spec Part 05 §5 and plan B16: rejected protocol commands are events; rejected operator commands are audit rows. */
  private recordRejection(meta: CommandMeta, err: unknown): void {
    if (!isFridayError(err)) return;
    const { db, store, projector, transport, ids, clock } = this.deps;
    try {
      if (PROTOCOL_ACTORS.has(meta.actor.kind)) {
        const event = db.transaction(() => {
          const e = store.append({
            type: 'command.rejected',
            project_id: meta.project_id,
            actor: meta.actor,
            correlation_id: meta.correlation_id ?? null,
            payload: { command: meta.name, error: { code: err.code, name: err.errorName, message: err.message } },
          });
          projector.apply(e);
          return e;
        });
        transport.publish([event]);
      } else {
        db.prepare(
          `INSERT INTO audit_records (audit_id, project_id, occurred_at, actor_kind, actor_id, action, decision, error_code, details_json)
           VALUES (?, ?, ?, ?, ?, ?, 'rejected', ?, ?)`,
        ).run(
          ids.next('aud'),
          meta.project_id,
          clock.now(),
          meta.actor.kind,
          meta.actor.id,
          meta.name,
          err.code,
          toJson({ message: err.message }),
        );
      }
    } catch {
      // Recording a rejection must never mask the original error.
    }
  }

  /** Deletes expired idempotency records. */
  sweepIdempotency(): number {
    return this.deps.db.prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(this.deps.clock.now())
      .changes;
  }
}
