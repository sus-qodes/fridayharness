import {
  betterSqliteAvailable,
  type DriverName,
  openBetterSqlite,
  openNodeSqlite,
  type SqlDatabase,
} from './driver.js';

export interface OpenOptions {
  /** Defaults to FRIDAY_SQLITE_DRIVER, then better-sqlite3 when installed, else node:sqlite. */
  driver?: DriverName;
  busyTimeoutMs?: number;
}

/**
 * Opens a database with Friday's pragmas: WAL journal (file databases), NORMAL sync,
 * foreign keys on, and a busy timeout so short lock waits do not fail.
 */
export function openDatabase(path: string, opts: OpenOptions = {}): SqlDatabase {
  const envDriver = process.env.FRIDAY_SQLITE_DRIVER as DriverName | undefined;
  const driver = opts.driver ?? envDriver ?? (betterSqliteAvailable() ? 'better-sqlite3' : 'node:sqlite');
  const db = driver === 'better-sqlite3' ? openBetterSqlite(path) : openNodeSqlite(path);
  try {
    if (path !== ':memory:') db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** Flushes the WAL into the main file and truncates it, then closes. Safe on Windows before deleting files. */
export function closeDatabase(db: SqlDatabase): void {
  try {
    if (db.path !== ':memory:') db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}
