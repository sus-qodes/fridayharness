import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase, type SqlDatabase } from '@friday/db';
import type { ParsedFacts } from './symbols.js';

/**
 * Content-addressed facts (ADR-0020 §3; ADR-0037 §1): what a file imports, declares, binds and
 * references, keyed by the sha256 of its bytes. Shared by every execution root and version;
 * derived data that is always safe to delete.
 */
export interface FactsCache {
  get(sha: string): ParsedFacts | undefined;
  putAll(entries: { sha: string; language: string; facts: ParsedFacts }[]): void;
  clear(): void;
  close(): void;
}

/** Bump when the shape of the facts changes: an older cache is discarded, never migrated. */
export const FACTS_FORMAT = 2;

export function memoryFactsCache(): FactsCache {
  const map = new Map<string, ParsedFacts>();
  return {
    get: (sha) => map.get(sha),
    putAll: (entries) => {
      for (const e of entries) map.set(e.sha, e.facts);
    },
    clear: () => map.clear(),
    close: () => undefined,
  };
}

/** `<dir>/facts.db`, usually `.friday/graph/facts.db` (ignored by git, C.3). */
export function openFactsCache(dir: string): FactsCache {
  mkdirSync(dir, { recursive: true });
  const db: SqlDatabase = openDatabase(path.join(dir, 'facts.db'));
  const format = Number(db.pragma('user_version'));
  if (format !== FACTS_FORMAT) {
    db.exec('DROP TABLE IF EXISTS facts');
    db.exec(
      'CREATE TABLE facts (sha TEXT PRIMARY KEY, language TEXT NOT NULL, facts_json TEXT NOT NULL) WITHOUT ROWID',
    );
    db.pragma(`user_version = ${FACTS_FORMAT}`);
  }
  const get = db.prepare('SELECT facts_json FROM facts WHERE sha = ?');
  const put = db.prepare('INSERT OR REPLACE INTO facts (sha, language, facts_json) VALUES (?, ?, ?)');
  return {
    get(sha) {
      const row = get.get<{ facts_json: string }>(sha);
      return row ? (JSON.parse(row.facts_json) as ParsedFacts) : undefined;
    },
    putAll(entries) {
      if (!entries.length) return;
      db.transaction(() => {
        for (const e of entries) put.run(e.sha, e.language, JSON.stringify(e.facts));
      });
    },
    clear() {
      db.exec('DELETE FROM facts');
    },
    close() {
      closeDatabase(db);
    },
  };
}
