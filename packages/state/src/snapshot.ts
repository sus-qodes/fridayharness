import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase, type SqlDatabase, type SqlValue } from '@friday/db';
import { EventStore } from '@friday/events';
import { FridayError } from '@friday/protocol';
import { stableStringify } from './bus.js';
import { DOMAIN_TABLES } from './migrations.js';
import { StateProjector } from './projector.js';
import type { FridayState } from './service.js';

/**
 * Snapshots, isolated replay and backup (plan M3c, ADR-0018). A snapshot holds the replayable
 * domain tables of one project at one event sequence; operational data (leases, outbox, jobs,
 * cursors, credentials) is rebuilt or left out by design, and artifacts stay files.
 */

export const SNAPSHOT_FORMAT = 'friday-snapshot';
export const SNAPSHOT_FORMAT_VERSION = 1;

type Row = Record<string, unknown>;

export interface SnapshotFile {
  format: typeof SNAPSHOT_FORMAT;
  format_version: number;
  schema_version: number;
  project_id: string;
  up_to_sequence: number;
  created_at: string;
  tables: Record<string, Row[]>;
  sha256: string;
}

export interface SnapshotInfo {
  snapshot_id: string;
  file: string;
  up_to_sequence: number;
  sha256: string;
  tables: Record<string, number>;
  created_at: string;
}

const schemaVersion = (db: SqlDatabase): number => Number(db.pragma('user_version'));

function digest(s: Omit<SnapshotFile, 'sha256'>): string {
  return createHash('sha256').update(stableStringify(s)).digest('hex');
}

/** Every domain row of the project, per table, as of one consistent read. */
function readTables(db: SqlDatabase, projectId: string): Record<string, Row[]> {
  const out: Record<string, Row[]> = {};
  for (const t of [...DOMAIN_TABLES].reverse()) {
    out[t] = db.prepare(`SELECT * FROM ${t} WHERE project_id = ? ORDER BY rowid`).all<Row>(projectId);
  }
  return out;
}

/** A content hash per table that does not depend on row order. */
function tableHashes(db: SqlDatabase, projectId: string): Record<string, { rows: number; hash: string }> {
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const [t, rows] of Object.entries(readTables(db, projectId))) {
    const lines = rows.map((r) => stableStringify(r)).sort();
    out[t] = { rows: rows.length, hash: createHash('sha256').update(lines.join('\n')).digest('hex') };
  }
  return out;
}

/**
 * Takes a snapshot of the project's domain tables at the current event head (ADR-0018 §1, §3):
 * one read transaction, written to a temporary file and renamed, recorded in `event_snapshots`.
 * A snapshot at an unchanged head returns the existing one.
 */
export function createSnapshot(state: FridayState, projectId: string, dir: string): SnapshotInfo {
  const taken = state.db.transaction(() => ({
    head: state.store.head(projectId),
    tables: readTables(state.db, projectId),
  }));
  const existing = state.db
    .prepare('SELECT * FROM event_snapshots WHERE project_id = ? AND up_to_sequence = ?')
    .get<{ snapshot_id: string; state_ref: string; created_at: string }>(projectId, taken.head);
  if (existing && existsSync(existing.state_ref)) {
    const file = loadSnapshot(existing.state_ref, { projectId, schemaVersion: schemaVersion(state.db) });
    return {
      snapshot_id: existing.snapshot_id,
      file: existing.state_ref,
      up_to_sequence: file.up_to_sequence,
      sha256: file.sha256,
      tables: Object.fromEntries(Object.entries(file.tables).map(([t, r]) => [t, r.length])),
      created_at: existing.created_at,
    };
  }
  const created_at = state.clock.now();
  const body: Omit<SnapshotFile, 'sha256'> = {
    format: SNAPSHOT_FORMAT,
    format_version: SNAPSHOT_FORMAT_VERSION,
    schema_version: schemaVersion(state.db),
    project_id: projectId,
    up_to_sequence: taken.head,
    created_at,
    tables: taken.tables,
  };
  const snapshot: SnapshotFile = { ...body, sha256: digest(body) };
  const snapshot_id = state.ids.next('snap');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${snapshot_id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, file);
  state.db
    .prepare(
      `INSERT INTO event_snapshots (snapshot_id, project_id, up_to_sequence, state_ref, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, up_to_sequence) DO UPDATE SET snapshot_id = excluded.snapshot_id, state_ref = excluded.state_ref,
         created_at = excluded.created_at`,
    )
    .run(snapshot_id, projectId, taken.head, file, created_at);
  return {
    snapshot_id,
    file,
    up_to_sequence: taken.head,
    sha256: snapshot.sha256,
    tables: Object.fromEntries(Object.entries(taken.tables).map(([t, r]) => [t, r.length])),
    created_at,
  };
}

/** Snapshots taken for a project, newest first. */
export function listSnapshots(
  state: FridayState,
  projectId: string,
): { snapshot_id: string; up_to_sequence: number; file: string; created_at: string; present: boolean }[] {
  return state.db
    .prepare('SELECT * FROM event_snapshots WHERE project_id = ? ORDER BY up_to_sequence DESC')
    .all<{ snapshot_id: string; up_to_sequence: number; state_ref: string; created_at: string }>(projectId)
    .map((r) => ({
      snapshot_id: r.snapshot_id,
      up_to_sequence: r.up_to_sequence,
      file: r.state_ref,
      created_at: r.created_at,
      present: existsSync(r.state_ref),
    }));
}

/** Reads and checks a snapshot file (ADR-0018 §4); every refusal names its reason. */
export function loadSnapshot(file: string, expect: { projectId: string; schemaVersion: number }): SnapshotFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new FridayError(
      'invalid_request',
      `snapshot ${path.basename(file)} cannot be read (an interrupted write?): ${(e as Error).message}`,
    );
  }
  const s = raw as Partial<SnapshotFile>;
  if (s.format !== SNAPSHOT_FORMAT || s.format_version !== SNAPSHOT_FORMAT_VERSION) {
    throw new FridayError(
      'invalid_request',
      `${path.basename(file)} is not a Friday snapshot of format ${SNAPSHOT_FORMAT_VERSION}`,
    );
  }
  const { sha256, ...body } = s as SnapshotFile;
  if (digest(body) !== sha256) {
    throw new FridayError(
      'invalid_request',
      `snapshot ${path.basename(file)} is corrupt: its content does not match its sha256`,
    );
  }
  if (s.project_id !== expect.projectId) {
    throw new FridayError('invalid_request', `snapshot ${path.basename(file)} belongs to project ${s.project_id}`);
  }
  if (s.schema_version !== expect.schemaVersion) {
    throw new FridayError(
      'invalid_request',
      `snapshot ${path.basename(file)} was taken at schema version ${s.schema_version}; this database is at ${expect.schemaVersion}. Take a new snapshot, or replay the full log`,
    );
  }
  return s as SnapshotFile;
}

function requireEmptyDir(dir: string, what: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new FridayError('invalid_request', `${dir} is not empty; ${what} needs a new or empty directory`);
  }
  mkdirSync(dir, { recursive: true });
}

/** A consistent copy of the live database, even while the daemon writes (SQLite `VACUUM INTO`). */
function copyDatabase(db: SqlDatabase, target: string): void {
  db.prepare('VACUUM INTO ?').run(target);
}

export interface ReplayReport {
  into: string;
  from_snapshot: string | null;
  up_to_sequence: number;
  events_applied: number;
  tables: { table: string; rows: number; equal: boolean }[];
  /** True when every rebuilt table equals the live state the copy was taken at. */
  equal: boolean;
}

/**
 * Rebuilds the project's domain tables in an isolated copy and compares them with the live state
 * at the moment of the copy (ADR-0018 §5). Only the projector runs: nothing is published, sent,
 * called, issued or started, and the live database is never written.
 */
export function replayInto(
  state: FridayState,
  projectId: string,
  into: string,
  opts: { snapshotFile?: string } = {},
): ReplayReport {
  requireEmptyDir(into, 'a replay');
  const target = path.join(into, 'project.db');
  const snapshot = opts.snapshotFile
    ? loadSnapshot(opts.snapshotFile, { projectId, schemaVersion: schemaVersion(state.db) })
    : undefined;
  copyDatabase(state.db, target);
  const db = openDatabase(target);
  try {
    // A debug copy carries no usable credential.
    db.prepare('DELETE FROM credentials').run();
    const before = tableHashes(db, projectId);
    const store = new EventStore(db, { ids: state.ids, clock: state.clock });
    const projector = new StateProjector(db);
    const head = store.head(projectId);
    if (snapshot && snapshot.up_to_sequence > head) {
      throw new FridayError(
        'invalid_request',
        `the snapshot covers sequence ${snapshot.up_to_sequence}, beyond the log (${head})`,
      );
    }
    let applied = 0;
    db.transaction(() => {
      projector.reset(projectId);
      if (snapshot) {
        for (const t of DOMAIN_TABLES.slice().reverse()) {
          for (const row of snapshot.tables[t] ?? []) {
            const cols = Object.keys(row);
            db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
              ...cols.map((c) => row[c] as SqlValue),
            );
          }
        }
      }
      let since = snapshot?.up_to_sequence ?? 0;
      for (;;) {
        const events = store.readSince(projectId, since, { limit: 1000 });
        if (events.length === 0) break;
        for (const e of events) {
          projector.apply(e);
          applied += 1;
          since = e.sequence;
        }
      }
    });
    const after = tableHashes(db, projectId);
    const tables = Object.keys(before).map((t) => ({
      table: t,
      rows: after[t]?.rows ?? 0,
      equal: before[t]?.hash === after[t]?.hash,
    }));
    return {
      into,
      from_snapshot: snapshot ? path.basename(opts.snapshotFile as string, '.json') : null,
      up_to_sequence: head,
      events_applied: applied,
      tables,
      equal: tables.every((t) => t.equal),
    };
  } finally {
    closeDatabase(db);
  }
}

export interface BackupReport {
  into: string;
  project_id: string;
  event_head: number;
  schema_version: number;
  files: string[];
}

/**
 * A backup (ADR-0018 §6): a consistent copy of the database, the artifacts folder and a manifest.
 * The private directory is left out: tokens rotate at every start, and provider keys belong to the user.
 */
export function backupTo(
  state: FridayState,
  projectId: string,
  into: string,
  opts: { artifactsDir?: string; fridayVersion?: string } = {},
): BackupReport {
  requireEmptyDir(into, 'a backup');
  const files: string[] = [];
  try {
    copyDatabase(state.db, path.join(into, 'project.db'));
    files.push('project.db');
    if (opts.artifactsDir && existsSync(opts.artifactsDir)) {
      cpSync(opts.artifactsDir, path.join(into, 'artifacts'), { recursive: true });
      files.push('artifacts/');
    }
    const report: BackupReport = {
      into,
      project_id: projectId,
      event_head: state.store.head(projectId),
      schema_version: schemaVersion(state.db),
      files,
    };
    writeFileSync(
      path.join(into, 'manifest.json'),
      `${JSON.stringify(
        {
          ...report,
          created_at: state.clock.now(),
          friday_version: opts.fridayVersion ?? null,
          restore:
            'Stop the daemon, then put project.db and artifacts/ back into .friday/. Tokens are created again at start; provider keys are kept per user outside the project.',
        },
        null,
        2,
      )}\n`,
    );
    files.push('manifest.json');
    return report;
  } catch (e) {
    rmSync(path.join(into, 'project.db'), { force: true });
    throw e;
  }
}
