import { createHash } from 'node:crypto';
import { FridayError } from '@friday/protocol';
import type { SqlDatabase } from './driver.js';

export interface Migration {
  version: number;
  name: string;
  /** SQL executed once, inside a transaction. */
  up: string;
}

export function checksum(m: Migration): string {
  return createHash('sha256').update(m.up.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Applies missing migrations in order (forward-only). Refuses to run when an applied
 * migration's SQL changed, because the database would no longer match the code.
 */
export function migrate(db: SqlDatabase, migrations: readonly Migration[]): { applied: number[] } {
  for (let i = 1; i < migrations.length; i += 1) {
    const prev = migrations[i - 1] as Migration;
    const cur = migrations[i] as Migration;
    if (cur.version <= prev.version) {
      throw new FridayError('internal_error', `migrations out of order: ${prev.version} then ${cur.version}`);
    }
  }
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const existing = new Map(
    db
      .prepare('SELECT version, checksum FROM schema_migrations')
      .all<{ version: number; checksum: string }>()
      .map((r) => [r.version, r.checksum]),
  );
  const applied: number[] = [];
  for (const m of migrations) {
    const sum = checksum(m);
    const have = existing.get(m.version);
    if (have !== undefined) {
      if (have !== sum) {
        throw new FridayError(
          'internal_error',
          `migration ${m.version} (${m.name}) changed after it was applied; refusing to start`,
          { version: m.version },
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        m.version,
        m.name,
        sum,
        new Date().toISOString(),
      );
    });
    applied.push(m.version);
  }
  const top = migrations.at(-1)?.version ?? 0;
  db.pragma(`user_version = ${top}`);
  return { applied };
}
