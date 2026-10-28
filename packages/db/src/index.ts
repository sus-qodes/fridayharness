/**
 * @friday/db
 * SQLite access behind a small driver seam: pragmas, migrations and transactions.
 */
export const PACKAGE_NAME = '@friday/db';

export {
  betterSqliteAvailable,
  type DriverName,
  openBetterSqlite,
  openNodeSqlite,
  type RunResult,
  type SqlDatabase,
  type SqlStatement,
  type SqlValue,
} from './driver.js';
export { checksum, type Migration, migrate } from './migrate.js';
export { closeDatabase, type OpenOptions, openDatabase } from './open.js';

/** Encodes a value for a JSON column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Decodes a JSON column, returning `fallback` for NULL. */
export function fromJson<T>(text: unknown, fallback: T): T {
  if (text === null || text === undefined) return fallback;
  return JSON.parse(String(text)) as T;
}
