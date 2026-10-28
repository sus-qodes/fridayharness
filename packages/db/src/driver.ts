import { createRequire } from 'node:module';

export type SqlValue = string | number | bigint | boolean | null | undefined | Uint8Array;
type Bound = string | number | bigint | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqlStatement {
  run(...params: SqlValue[]): RunResult;
  get<T = Record<string, unknown>>(...params: SqlValue[]): T | undefined;
  all<T = Record<string, unknown>>(...params: SqlValue[]): T[];
}

export type DriverName = 'better-sqlite3' | 'node:sqlite';

/**
 * The SqliteDriver seam (plan B15): the rest of Friday only uses this interface, so the
 * native better-sqlite3 addon can be swapped for Node's built-in `node:sqlite`.
 * Parameters are positional (`?`). Booleans bind as 0/1 and `undefined` as NULL.
 */
export interface SqlDatabase {
  readonly driver: DriverName;
  readonly path: string;
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** BEGIN IMMEDIATE … COMMIT; rolls back when `fn` throws. Nested calls become savepoints. */
  transaction<T>(fn: () => T): T;
  /** Runs a PRAGMA and returns its first row's first column, if any. */
  pragma(sql: string): unknown;
  readonly inTransaction: boolean;
  /**
   * A consistent copy of the database at `target`, made with SQLite's online backup in small
   * steps, so the event loop keeps running while a large database is copied. Writes made through
   * this connection meanwhile are carried into the copy.
   */
  backup(target: string): Promise<void>;
  close(): void;
}

/** Pages copied per backup step: about 2 MB with 4 KB pages, a few milliseconds each. */
const BACKUP_PAGES_PER_STEP = 512;

function bind(params: SqlValue[]): Bound[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

const require = createRequire(import.meta.url);

// ---- better-sqlite3 ------------------------------------------------------------------------

interface BetterStatement {
  run(...p: Bound[]): RunResult;
  get(...p: Bound[]): unknown;
  all(...p: Bound[]): unknown[];
  readonly reader: boolean;
}
interface BetterDb {
  exec(sql: string): void;
  prepare(sql: string): BetterStatement;
  transaction<F extends (...a: never[]) => unknown>(fn: F): { immediate: F };
  pragma(sql: string, opts?: { simple?: boolean }): unknown;
  backup(
    target: string,
    opts?: { progress?: (info: { totalPages: number; remainingPages: number }) => number },
  ): Promise<unknown>;
  readonly inTransaction: boolean;
  close(): void;
}

export function openBetterSqlite(path: string): SqlDatabase {
  const Database = require('better-sqlite3') as new (file: string) => BetterDb;
  const db = new Database(path);
  const cache = new Map<string, SqlStatement>();
  return {
    driver: 'better-sqlite3',
    path,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const hit = cache.get(sql);
      if (hit) return hit;
      const stmt = db.prepare(sql);
      const wrapped: SqlStatement = {
        run: (...p) => stmt.run(...bind(p)),
        get: <T>(...p: SqlValue[]) => stmt.get(...bind(p)) as T | undefined,
        all: <T>(...p: SqlValue[]) => stmt.all(...bind(p)) as T[],
      };
      cache.set(sql, wrapped);
      return wrapped;
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn).immediate(),
    pragma: (sql) => db.pragma(sql, { simple: true }),
    get inTransaction() {
      return db.inTransaction;
    },
    backup: async (target) => {
      await db.backup(target, { progress: () => BACKUP_PAGES_PER_STEP });
    },
    close: () => db.close(),
  };
}

// ---- node:sqlite ---------------------------------------------------------------------------

interface NodeStatement {
  run(...p: Bound[]): RunResult;
  get(...p: Bound[]): unknown;
  all(...p: Bound[]): unknown[];
}
interface NodeDb {
  exec(sql: string): void;
  prepare(sql: string): NodeStatement;
  readonly isTransaction?: boolean;
  close(): void;
}

function plain<T>(row: unknown): T {
  // node:sqlite returns null-prototype objects; normalize for equality checks and JSON.
  return (row === undefined || row === null ? row : { ...(row as object) }) as T;
}

type NodeBackup = (db: NodeDb, target: string, opts?: { rate?: number }) => Promise<number>;

export function openNodeSqlite(path: string): SqlDatabase {
  const mod = process.getBuiltinModule('node:sqlite') as unknown as
    | { DatabaseSync: new (file: string) => NodeDb; backup?: NodeBackup }
    | undefined;
  if (!mod) throw new Error('node:sqlite is not available in this Node.js build');
  const db = new mod.DatabaseSync(path);
  const cache = new Map<string, SqlStatement>();
  let depth = 0;
  return {
    driver: 'node:sqlite',
    path,
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const hit = cache.get(sql);
      if (hit) return hit;
      const stmt = db.prepare(sql);
      const wrapped: SqlStatement = {
        run: (...p) => stmt.run(...bind(p)),
        get: <T>(...p: SqlValue[]) => plain<T | undefined>(stmt.get(...bind(p))),
        all: <T>(...p: SqlValue[]) => stmt.all(...bind(p)).map((r) => plain<T>(r)),
      };
      cache.set(sql, wrapped);
      return wrapped;
    },
    transaction<T>(fn: () => T): T {
      const savepoint = `sp_${depth}`;
      db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const out = fn();
        depth -= 1;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return out;
      } catch (e) {
        depth -= 1;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw e;
      }
    },
    pragma(sql) {
      const row = db.prepare(`PRAGMA ${sql}`).get() as Record<string, unknown> | undefined;
      return row ? Object.values(row)[0] : undefined;
    },
    get inTransaction() {
      return depth > 0;
    },
    async backup(target) {
      // node:sqlite has an online backup from Node 22.16; older builds copy in one step.
      if (mod.backup) await mod.backup(db, target, { rate: BACKUP_PAGES_PER_STEP });
      else db.prepare('VACUUM INTO ?').run(target);
    },
    close: () => db.close(),
  };
}

export function betterSqliteAvailable(): boolean {
  try {
    require.resolve('better-sqlite3');
    return true;
  } catch {
    return false;
  }
}
