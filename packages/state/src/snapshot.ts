import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { closeDatabase, openDatabase, type SqlDatabase, type SqlValue } from '@friday/db';
import { EventStore } from '@friday/events';
import { FridayError } from '@friday/protocol';
import { stableStringify } from './bus.js';
import { DOMAIN_TABLES } from './migrations.js';
import { StateProjector } from './projector.js';
import { type FridayState, INSPECTION_MARKER } from './service.js';

/**
 * Snapshots, isolated replay and backup (plan M3c, ADR-0018; M3.1). A snapshot holds the
 * replayable domain tables of one project at one event sequence; operational data (leases,
 * outbox, jobs, cursors, credentials) is rebuilt or left out by design, and artifacts stay files.
 *
 * None of this holds the daemon's event loop for long (M3.1, R09): reads go through a second
 * connection inside one WAL read transaction, so they stay consistent while the daemon keeps
 * writing; copies use SQLite's online backup in small steps; files are streamed; replay rebuilds
 * in batches. Only one of these jobs runs at a time per project.
 */

export const SNAPSHOT_FORMAT = 'friday-snapshot';
export const SNAPSHOT_FORMAT_VERSION = 2;
export const BACKUP_FORMAT = 'friday-backup';
/** 2 (review F16): a backup also holds the code a clone of the project would not have. */
export const BACKUP_FORMAT_VERSION = 2;
/** Snapshots live in this folder of the artifacts root; `state_ref` names a file in it. */
export const SNAPSHOT_DIR = 'snapshots';

const BATCH = 1000;

type Row = Record<string, unknown>;

/** The first line of a snapshot file. Rows follow, one per line; the last line holds the hash. */
export interface SnapshotHeader {
  format: typeof SNAPSHOT_FORMAT;
  format_version: number;
  schema_version: number;
  project_id: string;
  up_to_sequence: number;
  created_at: string;
}

export interface SnapshotInfo {
  snapshot_id: string;
  /** Where the file is now, resolved against the artifacts root. */
  file: string;
  /** What `event_snapshots` records: a path relative to the artifacts root. */
  state_ref: string;
  up_to_sequence: number;
  sha256: string;
  tables: Record<string, number>;
  created_at: string;
}

const schemaVersion = (db: SqlDatabase): number => Number(db.pragma('user_version'));

const headOf = (db: SqlDatabase, projectId: string): number =>
  db.prepare('SELECT last_sequence FROM event_sequences WHERE project_id = ?').get<{ last_sequence: number }>(projectId)
    ?.last_sequence ?? 0;

// ---------------------------------------------------------------- one job at a time

const running = new WeakMap<FridayState, string>();

async function exclusive<T>(state: FridayState, what: string, fn: () => Promise<T>): Promise<T> {
  const current = running.get(state);
  if (current) throw new FridayError('invalid_request', `a ${current} is running; try again when it has finished`);
  running.set(state, what);
  try {
    return await fn();
  } finally {
    running.delete(state);
  }
}

function artifactsRoot(state: FridayState, override?: string): string {
  const root = override ?? state.artifactsDir;
  if (!root) throw new FridayError('invalid_request', 'this Friday state has no artifacts folder');
  return root;
}

// ---------------------------------------------------------------- consistent reads that yield

/**
 * Runs `fn` against a read-only view of the live database as of one moment. A file database is
 * read through a second connection inside one read transaction (WAL keeps that view stable while
 * the daemon writes); an in-memory database is copied to a scratch file first.
 */
async function withReadView<T>(
  state: FridayState,
  scratchDir: string,
  fn: (db: SqlDatabase) => Promise<T>,
): Promise<T> {
  if (state.db.path === ':memory:') {
    mkdirSync(scratchDir, { recursive: true });
    const file = path.join(scratchDir, `.view-${randomBytes(6).toString('hex')}.db`);
    await state.db.backup(file);
    const db = openDatabase(file);
    try {
      return await fn(db);
    } finally {
      closeDatabase(db);
      await rm(file, { force: true });
    }
  }
  const db = openDatabase(state.db.path);
  try {
    db.exec('BEGIN');
    // A read transaction takes its view at the first read.
    db.prepare('SELECT COUNT(*) AS n FROM event_sequences').get();
    return await fn(db);
  } finally {
    try {
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  }
}

/** The project's rows of one table in rowid order, a page at a time, yielding between pages. */
async function* rowsOf(db: SqlDatabase, table: string, projectId: string): AsyncGenerator<Row> {
  let after: number = Number.MIN_SAFE_INTEGER;
  const page = db.prepare(
    `SELECT rowid AS __rowid, * FROM ${table} WHERE project_id = ? AND rowid > ? ORDER BY rowid LIMIT ${BATCH}`,
  );
  for (;;) {
    const rows = page.all<Row>(projectId, after);
    if (rows.length === 0) return;
    for (const r of rows) {
      after = Number(r.__rowid);
      delete r.__rowid;
      yield r;
    }
    await nextTurn();
  }
}

/** Domain tables with parents first, the order rows can be inserted in. */
const INSERT_ORDER: readonly string[] = [...DOMAIN_TABLES].reverse();
const MOD = 1n << 256n;

/**
 * A content hash per table that does not depend on row order: the sum of the rows' sha256
 * values modulo 2^256, so it is computed in one streaming pass.
 */
async function tableHashes(
  db: SqlDatabase,
  projectId: string,
): Promise<Record<string, { rows: number; hash: string }>> {
  const out: Record<string, { rows: number; hash: string }> = {};
  for (const t of INSERT_ORDER) {
    let sum = 0n;
    let rows = 0;
    for await (const r of rowsOf(db, t, projectId)) {
      sum = (sum + BigInt(`0x${createHash('sha256').update(stableStringify(r)).digest('hex')}`)) % MOD;
      rows += 1;
    }
    out[t] = { rows, hash: sum.toString(16).padStart(64, '0') };
  }
  return out;
}

/** What `StateProjector.reset` does, in batches with yields (children first), for a scratch copy. */
async function clearInBatches(db: SqlDatabase, projectId: string): Promise<void> {
  for (const t of DOMAIN_TABLES) {
    const del = db.prepare(
      `DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE project_id = ? LIMIT ${BATCH * 5})`,
    );
    while (db.transaction(() => del.run(projectId).changes) > 0) await nextTurn();
  }
}

// ---------------------------------------------------------------- snapshot references

/**
 * The file a `state_ref` names, under the given artifacts root, or null when the ref is not a
 * snapshot file name. Refs are relative (`snapshots/<id>.jsonl`), so a restored or moved backup
 * finds its snapshots (M3.1, R06); an absolute ref from an M3c build is read by its file name.
 * Only a bare file name inside `snapshots/` is accepted, so a ref never leads anywhere else.
 */
export function snapshotPath(artifactsDir: string, ref: string): string | null {
  const name = ref.split(/[\\/]/).pop() ?? '';
  if (!/^snap_[0-9a-z]{1,64}\.jsonl?$/i.test(name)) return null;
  return path.join(artifactsDir, SNAPSHOT_DIR, name);
}

// ---------------------------------------------------------------- snapshot files

/** Streams a snapshot file's lines, its rows passed to `onRow`; checks everything before trusting it. */
async function readSnapshotFile(
  file: string,
  expect: { projectId: string; schemaVersion: number },
  onRow?: (table: string, row: Row) => Promise<void> | void,
): Promise<{ header: SnapshotHeader; sha256: string; tables: Record<string, number> }> {
  const name = path.basename(file);
  const unreadable = (why: string) =>
    new FridayError('invalid_request', `snapshot ${name} cannot be read (an interrupted write?): ${why}`);
  const hash = createHash('sha256');
  const tables: Record<string, number> = {};
  let header: SnapshotHeader | undefined;
  let pending: string | undefined;
  let lines = 0;
  const input = createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of rl) {
      if (pending !== undefined) {
        hash.update(`${pending}\n`);
        if (header === undefined) {
          header = parseHeader(pending, name, unreadable);
        } else {
          let entry: { t?: unknown; r?: unknown };
          try {
            entry = JSON.parse(pending) as { t?: unknown; r?: unknown };
          } catch (e) {
            throw unreadable((e as Error).message);
          }
          const t = String(entry.t);
          tables[t] = (tables[t] ?? 0) + 1;
          if (onRow) await onRow(t, entry.r as Row);
        }
      }
      pending = line;
      lines += 1;
    }
  } catch (e) {
    if (e instanceof FridayError) throw e;
    throw unreadable((e as Error).message);
  } finally {
    rl.close();
    input.destroy();
  }
  if (lines < 2 || pending === undefined || header === undefined) {
    if (lines === 1 && pending !== undefined) parseHeader(pending, name, unreadable);
    throw unreadable('it ends before its checksum');
  }
  let trailer: { sha256?: unknown };
  try {
    trailer = JSON.parse(pending) as { sha256?: unknown };
  } catch (e) {
    throw unreadable((e as Error).message);
  }
  if (typeof trailer.sha256 !== 'string') throw unreadable('it ends before its checksum');
  const sha256 = hash.digest('hex');
  if (sha256 !== trailer.sha256) {
    throw new FridayError('invalid_request', `snapshot ${name} is corrupt: its content does not match its sha256`);
  }
  if (header.project_id !== expect.projectId) {
    throw new FridayError('invalid_request', `snapshot ${name} belongs to project ${header.project_id}`);
  }
  if (header.schema_version !== expect.schemaVersion) {
    throw new FridayError(
      'invalid_request',
      `snapshot ${name} was taken at schema version ${header.schema_version}; this database is at ${expect.schemaVersion}. Take a new snapshot, or replay the full log`,
    );
  }
  return { header, sha256, tables };
}

function parseHeader(line: string, name: string, unreadable: (why: string) => FridayError): SnapshotHeader {
  let h: Partial<SnapshotHeader>;
  try {
    h = JSON.parse(line) as Partial<SnapshotHeader>;
  } catch (e) {
    throw unreadable((e as Error).message);
  }
  if (h.format !== SNAPSHOT_FORMAT) {
    throw new FridayError('invalid_request', `${name} is not a Friday snapshot`);
  }
  if (h.format_version !== SNAPSHOT_FORMAT_VERSION) {
    throw new FridayError(
      'invalid_request',
      `${name} is a snapshot of format ${h.format_version}; this Friday reads format ${SNAPSHOT_FORMAT_VERSION}. Take a new snapshot`,
    );
  }
  return h as SnapshotHeader;
}

/** Checks a snapshot file completely (ADR-0018 §4) without applying it; every refusal names its reason. */
export async function verifySnapshot(
  file: string,
  expect: { projectId: string; schemaVersion: number },
): Promise<{ header: SnapshotHeader; sha256: string; tables: Record<string, number> }> {
  return readSnapshotFile(file, expect);
}

/** Buffered, streamed writes with a running hash. */
class LineWriter {
  private buf: string[] = [];
  private size = 0;
  readonly hash = createHash('sha256');
  private constructor(private readonly fh: Awaited<ReturnType<typeof open>>) {}
  static async create(file: string): Promise<LineWriter> {
    return new LineWriter(await open(file, 'wx'));
  }
  async line(s: string, hashed = true): Promise<void> {
    const l = `${s}\n`;
    if (hashed) this.hash.update(l);
    this.buf.push(l);
    this.size += l.length;
    if (this.size >= 1 << 20) await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.buf.length) return;
    await this.fh.write(this.buf.join(''));
    this.buf = [];
    this.size = 0;
  }
  async close(): Promise<void> {
    await this.flush();
    await this.fh.sync();
    await this.fh.close();
  }
  async abort(): Promise<void> {
    await this.fh.close().catch(() => undefined);
  }
}

/**
 * Takes a snapshot of the project's domain tables at the current event head (ADR-0018 §1, §3):
 * one consistent view, streamed to a temporary file and renamed, recorded in `event_snapshots`
 * with a path relative to the artifacts root. A snapshot at an unchanged head returns the
 * existing one while its file is intact.
 */
export async function createSnapshot(
  state: FridayState,
  projectId: string,
  opts: { artifactsDir?: string } = {},
): Promise<SnapshotInfo> {
  const root = artifactsRoot(state, opts.artifactsDir);
  return exclusive(state, 'snapshot', async () => {
    const dir = path.join(root, SNAPSHOT_DIR);
    mkdirSync(dir, { recursive: true });
    return withReadView(state, dir, async (view) => {
      const head = headOf(view, projectId);
      const schema = schemaVersion(view);
      const existing = state.db
        .prepare('SELECT * FROM event_snapshots WHERE project_id = ? AND up_to_sequence = ?')
        .get<{ snapshot_id: string; state_ref: string; created_at: string }>(projectId, head);
      const existingFile = existing ? snapshotPath(root, existing.state_ref) : null;
      if (existing && existingFile && existsSync(existingFile)) {
        const ok = await verifySnapshot(existingFile, { projectId, schemaVersion: schema }).catch(() => undefined);
        if (ok) {
          return {
            snapshot_id: existing.snapshot_id,
            file: existingFile,
            state_ref: `${SNAPSHOT_DIR}/${path.basename(existingFile)}`,
            up_to_sequence: head,
            sha256: ok.sha256,
            tables: ok.tables,
            created_at: existing.created_at,
          };
        }
      }
      const created_at = state.clock.now();
      const snapshot_id = state.ids.next('snap');
      const state_ref = `${SNAPSHOT_DIR}/${snapshot_id}.jsonl`;
      const file = path.join(dir, `${snapshot_id}.jsonl`);
      const tmp = `${file}.${process.pid}.tmp`;
      const header: SnapshotHeader = {
        format: SNAPSHOT_FORMAT,
        format_version: SNAPSHOT_FORMAT_VERSION,
        schema_version: schema,
        project_id: projectId,
        up_to_sequence: head,
        created_at,
      };
      const tables: Record<string, number> = {};
      const w = await LineWriter.create(tmp);
      try {
        await w.line(stableStringify(header));
        for (const t of INSERT_ORDER) {
          tables[t] = 0;
          for await (const r of rowsOf(view, t, projectId)) {
            await w.line(stableStringify({ t, r }));
            tables[t] += 1;
          }
        }
        const sha256 = w.hash.digest('hex');
        await w.line(stableStringify({ sha256, tables }), false);
        await w.close();
        await rename(tmp, file);
        state.db
          .prepare(
            `INSERT INTO event_snapshots (snapshot_id, project_id, up_to_sequence, state_ref, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(project_id, up_to_sequence) DO UPDATE SET snapshot_id = excluded.snapshot_id, state_ref = excluded.state_ref,
               created_at = excluded.created_at`,
          )
          .run(snapshot_id, projectId, head, state_ref, created_at);
        return { snapshot_id, file, state_ref, up_to_sequence: head, sha256, tables, created_at };
      } catch (e) {
        await w.abort();
        await rm(tmp, { force: true });
        throw e;
      }
    });
  });
}

/** Snapshots recorded for a project, newest first, with where each file is now. */
export function listSnapshots(
  state: FridayState,
  projectId: string,
  opts: { artifactsDir?: string } = {},
): {
  snapshot_id: string;
  up_to_sequence: number;
  state_ref: string;
  file: string | null;
  created_at: string;
  present: boolean;
}[] {
  const root = opts.artifactsDir ?? state.artifactsDir;
  return state.db
    .prepare('SELECT * FROM event_snapshots WHERE project_id = ? ORDER BY up_to_sequence DESC')
    .all<{ snapshot_id: string; up_to_sequence: number; state_ref: string; created_at: string }>(projectId)
    .map((r) => {
      const file = root ? snapshotPath(root, r.state_ref) : null;
      return {
        snapshot_id: r.snapshot_id,
        up_to_sequence: r.up_to_sequence,
        state_ref: r.state_ref,
        file,
        created_at: r.created_at,
        present: file !== null && existsSync(file),
      };
    });
}

function requireEmptyDir(dir: string, what: string): void {
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new FridayError('invalid_request', `${dir} is not empty; ${what} needs a new or empty directory`);
  }
}

// ---------------------------------------------------------------- replay

export interface ReplayReport {
  into: string;
  from_snapshot: string | null;
  up_to_sequence: number;
  events_applied: number;
  tables: { table: string; rows: number; equal: boolean }[];
  /** True when every rebuilt table equals the live state the copy was taken at. */
  equal: boolean;
  duration_ms: number;
}

/**
 * Rebuilds the project's domain tables in an isolated copy and compares them with the live state
 * at the moment of the copy (ADR-0018 §5). Only the projector runs: nothing is published, sent,
 * called, issued or started, and the live database is never written. The copy carries no
 * credential and is marked as an inspection copy, which Friday refuses to run on (M3.1, R08).
 */
export async function replayInto(
  state: FridayState,
  projectId: string,
  into: string,
  opts: { snapshotFile?: string } = {},
): Promise<ReplayReport> {
  return exclusive(state, 'replay', async () => {
    const started = Date.now();
    requireEmptyDir(into, 'a replay');
    mkdirSync(into, { recursive: true });
    const expect = { projectId, schemaVersion: schemaVersion(state.db) };
    const snapshot = opts.snapshotFile ? await verifySnapshot(opts.snapshotFile, expect) : undefined;
    const target = path.join(into, 'project.db');
    await state.db.backup(target);
    const db = openDatabase(target);
    try {
      db.exec(
        `CREATE TABLE ${INSPECTION_MARKER} (made_at TEXT NOT NULL, made_by TEXT NOT NULL, source_head INTEGER NOT NULL)`,
      );
      db.prepare('DELETE FROM credentials').run();
      const store = new EventStore(db, { ids: state.ids, clock: state.clock });
      const head = store.head(projectId);
      db.prepare(`INSERT INTO ${INSPECTION_MARKER} VALUES (?, ?, ?)`).run(
        state.clock.now(),
        'friday events replay',
        head,
      );
      const before = await tableHashes(db, projectId);
      if (snapshot && snapshot.header.up_to_sequence > head) {
        throw new FridayError(
          'invalid_request',
          `the snapshot covers sequence ${snapshot.header.up_to_sequence}, beyond the log (${head})`,
        );
      }
      const projector = new StateProjector(db);
      await clearInBatches(db, projectId);
      if (snapshot && opts.snapshotFile) {
        // The copy is scratch, so it is rebuilt in batches; the verified file is read again to apply it.
        let batch: { t: string; r: Row }[] = [];
        const flush = () => {
          const rows = batch;
          batch = [];
          db.transaction(() => {
            for (const { t, r } of rows) {
              const cols = Object.keys(r);
              db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
                ...cols.map((c) => r[c] as SqlValue),
              );
            }
          });
        };
        await readSnapshotFile(opts.snapshotFile, expect, async (t, r) => {
          if (!INSERT_ORDER.includes(t))
            throw new FridayError('invalid_request', `snapshot names an unknown table ${t}`);
          batch.push({ t, r });
          if (batch.length >= BATCH) {
            flush();
            await nextTurn();
          }
        });
        flush();
      }
      let since = snapshot?.header.up_to_sequence ?? 0;
      let applied = 0;
      for (;;) {
        const events = store.readSince(projectId, since, { limit: BATCH });
        if (events.length === 0) break;
        db.transaction(() => {
          for (const e of events) {
            projector.apply(e);
            applied += 1;
            since = e.sequence;
          }
        });
        await nextTurn();
      }
      const after = await tableHashes(db, projectId);
      const tables = Object.keys(before).map((t) => ({
        table: t,
        rows: after[t]?.rows ?? 0,
        equal: before[t]?.hash === after[t]?.hash,
      }));
      return {
        into,
        from_snapshot: opts.snapshotFile ? path.basename(opts.snapshotFile).replace(/\.jsonl?$/, '') : null,
        up_to_sequence: head,
        events_applied: applied,
        tables,
        equal: tables.every((t) => t.equal),
        duration_ms: Date.now() - started,
      };
    } finally {
      closeDatabase(db);
    }
  });
}

// ---------------------------------------------------------------- backup

export interface BackupArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * What a backup holds of the project's code (review F16), written by the daemon, which runs git:
 * Friday's branches, the preserved states of earlier attempts and the uncommitted work of task
 * worktrees, in one git bundle with its full history. The main checkout is yours and is not copied.
 */
export interface BackupCode {
  included: boolean;
  /** Why no code is included. */
  reason?: string;
  /** The bundle's file name in the backup, with its size and sha256. */
  bundle?: string;
  bytes?: number;
  sha256?: string;
  refs?: {
    ref: string;
    commit: string;
    kind: 'task_branch' | 'goal_branch' | 'preserved' | 'restored' | 'uncommitted';
    task_id: string | null;
  }[];
  /** Task worktrees whose uncommitted work it holds, and the ref a restore puts that work under. */
  worktrees?: {
    task_id: string;
    worktree_id: string;
    path: string;
    head: string | null;
    files: number;
    restores_to: string;
  }[];
  /** Task worktrees that may hold work it could not read. */
  skipped?: { task_id: string; path: string; reason: string }[];
}

export interface BackupReport {
  into: string;
  project_id: string;
  /** Read from the copy itself, so it describes exactly what the backup holds. */
  event_head: number;
  schema_version: number;
  files: string[];
  artifacts: { files: number; bytes: number };
  /** Entries left out on purpose: links and unfinished writes. */
  skipped: { path: string; reason: string }[];
  /** Artifacts the database references that the backup lacks or holds with other content. */
  problems: { artifact_id: string; path: string; problem: 'missing' | 'changed' }[];
  code: BackupCode;
  duration_ms: number;
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/**
 * Copies a folder of regular files. Links (symlinks, junctions) are not followed: a backup
 * holds the project's files, never what a link points to (M3.1, R07).
 */
async function copyTree(
  src: string,
  dest: string,
  rel: string,
  inventory: BackupArtifact[],
  skipped: { path: string; reason: string }[],
): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = (await readdir(src)).sort();
  for (const name of entries) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = await lstat(from);
    if (st.isSymbolicLink()) {
      skipped.push({ path: r, reason: 'a link; backups copy files, not what links point to' });
    } else if (st.isDirectory()) {
      await copyTree(from, to, r, inventory, skipped);
    } else if (!st.isFile()) {
      skipped.push({ path: r, reason: 'not a regular file' });
    } else if (name.endsWith('.tmp')) {
      skipped.push({ path: r, reason: 'an unfinished write' });
    } else {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      inventory.push({ path: r, bytes: (await stat(to)).size, sha256: await hashFile(to) });
    }
  }
}

/**
 * A backup (ADR-0018 §6, M3.1): a consistent copy of the database without credentials, the
 * artifacts folder with a hash of every file, and a manifest describing exactly what was copied.
 * It is built in a staging folder next to `into` and renamed into place when complete, so a
 * failed backup leaves nothing that looks like a backup. The private directory is left out:
 * tokens rotate at every start, and provider keys and approvals belong to the user and machine.
 */
export async function backupTo(
  state: FridayState,
  projectId: string,
  into: string,
  opts: {
    artifactsDir?: string;
    fridayVersion?: string;
    /** Writes the project's code into the staging folder and describes it (the daemon; review F16). */
    code?: (staging: string) => Promise<BackupCode>;
  } = {},
): Promise<BackupReport> {
  return exclusive(state, 'backup', async () => {
    const started = Date.now();
    const target = path.resolve(into);
    requireEmptyDir(target, 'a backup');
    const parent = path.dirname(target);
    mkdirSync(parent, { recursive: true });
    const staging = path.join(parent, `.${path.basename(target)}.incomplete-${randomBytes(4).toString('hex')}`);
    await mkdir(staging);
    try {
      const dbFile = path.join(staging, 'project.db');
      await state.db.backup(dbFile);
      const copy = openDatabase(dbFile);
      let event_head: number;
      let schema_version: number;
      let recorded: { artifact_id: string; path: string; sha256: string }[];
      try {
        // A backup carries no credential: after a restore every session registers again (R08).
        copy.prepare('DELETE FROM credentials').run();
        event_head = headOf(copy, projectId);
        schema_version = schemaVersion(copy);
        recorded = copy
          .prepare('SELECT artifact_id, path, sha256 FROM artifacts WHERE project_id = ? ORDER BY artifact_id')
          .all<{ artifact_id: string; path: string; sha256: string }>(projectId);
      } finally {
        closeDatabase(copy);
      }
      const files = ['project.db'];
      const inventory: BackupArtifact[] = [];
      const skipped: { path: string; reason: string }[] = [];
      const artifactsDir = opts.artifactsDir ?? state.artifactsDir;
      if (artifactsDir && existsSync(artifactsDir)) {
        await copyTree(artifactsDir, path.join(staging, 'artifacts'), '', inventory, skipped);
        files.push('artifacts/');
      }
      const byPath = new Map(inventory.map((a) => [a.path, a]));
      const problems: BackupReport['problems'] = [];
      for (const r of recorded) {
        const a = byPath.get(r.path);
        if (!a) problems.push({ artifact_id: r.artifact_id, path: r.path, problem: 'missing' });
        else if (a.sha256 !== r.sha256) problems.push({ artifact_id: r.artifact_id, path: r.path, problem: 'changed' });
      }
      // After the database, so the code holds at least every commit the copy refers to.
      const code: BackupCode = opts.code
        ? await opts.code(staging)
        : { included: false, reason: "this backup was made without the project's code" };
      if (code.included && code.bundle) files.push(code.bundle);
      files.push('manifest.json');
      const report: BackupReport = {
        into: target,
        project_id: projectId,
        event_head,
        schema_version,
        files,
        artifacts: { files: inventory.length, bytes: inventory.reduce((n, a) => n + a.bytes, 0) },
        skipped,
        problems,
        code,
        duration_ms: 0,
      };
      await writeFile(
        path.join(staging, 'manifest.json'),
        `${JSON.stringify(
          {
            format: BACKUP_FORMAT,
            format_version: BACKUP_FORMAT_VERSION,
            project_id: projectId,
            event_head,
            schema_version,
            created_at: state.clock.now(),
            friday_version: opts.fridayVersion ?? null,
            files,
            credentials: 'removed; every session registers again after a restore',
            artifacts: inventory,
            skipped,
            problems,
            code,
            restore:
              'Stop the daemon, then run "friday restore --from <this folder>" in a clone of the project. It checks this manifest, adds the code\'s refs to the clone without moving any of its own back, sets the current state aside, and puts project.db and artifacts/ back. A task worktree\'s uncommitted work comes back with "friday recover <task> --action reassign". Provider keys and this clone\'s provider approval stay in the private directory and are not part of a backup.',
          },
          null,
          2,
        )}\n`,
      );
      if (existsSync(target)) await rmdir(target);
      await rename(staging, target);
      report.duration_ms = Date.now() - started;
      return report;
    } catch (e) {
      await rm(staging, { recursive: true, force: true });
      throw e;
    }
  });
}
