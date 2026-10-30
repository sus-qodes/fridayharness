import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { closeDatabase, openDatabase, type SqlDatabase } from '@friday/db';
import type { CodeGraph } from './graph.js';

/**
 * Keyword retrieval over the graph (ADR-0037 §2): one FTS5 row per symbol and one per file, ranked
 * by SQLite's BM25. Identifiers are split at case changes and separators, so `checkoutService` is
 * found by `checkout`. Derived from the graph; rebuilt with it; safe to delete. No vectors: they
 * wait for a measurement that shows keyword and graph retrieval miss things.
 */

export interface SearchHit {
  kind: 'symbol' | 'file';
  path: string;
  /** The symbol's name; the file's base name. */
  name: string;
  symbol_kind: string | null;
  line: number | null;
  signature: string | null;
  /** Higher is better (the negated BM25 rank). */
  score: number;
}

export interface SearchIndex {
  /** Replaces the root's rows with the graph's symbols and files. */
  replace(root: string, graph: CodeGraph): void;
  search(root: string, query: string, opts?: { limit?: number; kind?: 'symbol' | 'file' }): SearchHit[];
  clear(): void;
  close(): void;
}

export const SEARCH_FORMAT = 1;

/** The words of an identifier or a path: split at separators and case changes, lower-cased, plus the whole. */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.split(/[^A-Za-z0-9]+/)) {
    if (!part) continue;
    out.add(part.toLowerCase());
    const words = part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/\s+/);
    for (const w of words) if (w.length > 1) out.add(w.toLowerCase());
  }
  return [...out];
}

/** The FTS5 query for a search: every word required, else any word. */
function matchExpression(query: string, any: boolean): string | null {
  const terms = tokenize(query).filter((t) => /^[a-z0-9]+$/.test(t));
  if (!terms.length) return null;
  const quoted = terms.map((t) => `"${t}"`);
  return any ? quoted.join(' OR ') : quoted.join(' AND ');
}

const SCHEMA = `CREATE VIRTUAL TABLE graph_fts USING fts5(
  tokens, words, path, name UNINDEXED, root UNINDEXED, kind UNINDEXED, symbol_kind UNINDEXED, line UNINDEXED, signature UNINDEXED,
  tokenize = 'unicode61'
)`;

function index(db: SqlDatabase, owned: boolean): SearchIndex {
  if (
    Number(db.pragma('user_version')) !== SEARCH_FORMAT ||
    !db.prepare("SELECT name FROM sqlite_master WHERE name = 'graph_fts'").get()
  ) {
    db.exec('DROP TABLE IF EXISTS graph_fts');
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SEARCH_FORMAT}`);
  }
  const del = db.prepare('DELETE FROM graph_fts WHERE root = ?');
  const put = db.prepare(
    'INSERT INTO graph_fts (tokens, words, path, name, root, kind, symbol_kind, line, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const run = (root: string, expr: string, kind: 'symbol' | 'file' | undefined, limit: number) =>
    db
      .prepare(
        `SELECT path, name, kind, symbol_kind, line, signature, bm25(graph_fts, 1.0, 4.0, 2.0) AS rank
         FROM graph_fts WHERE graph_fts MATCH ? AND root = ?${kind ? ' AND kind = ?' : ''}
         ORDER BY rank, kind DESC, path, line LIMIT ?`,
      )
      .all<{
        path: string;
        name: string;
        kind: string;
        symbol_kind: string | null;
        line: number | null;
        signature: string | null;
        rank: number;
      }>(...(kind ? [expr, root, kind, limit] : [expr, root, limit]));
  return {
    replace(root, graph) {
      db.transaction(() => {
        del.run(root);
        for (const s of graph.symbols) {
          const tokens = [...tokenize(s.name), ...tokenize(s.path), ...(s.parent ? tokenize(s.parent) : [])].join(' ');
          put.run(tokens, tokenize(s.name).join(' '), s.path, s.name, root, 'symbol', s.kind, s.line, s.signature);
        }
        for (const [p, node] of graph.nodes) {
          const exported = graph
            .symbolsOf(p)
            .filter((s) => s.exported && s.parent === null)
            .map((s) => s.name);
          const tokens = [...tokenize(p), ...tokenize(node.area), ...exported.flatMap(tokenize)].join(' ');
          const base = path.posix.basename(p);
          put.run(tokens, tokenize(base).join(' '), p, base, root, 'file', null, null, null);
        }
      });
    },
    search(root, query, opts = {}) {
      const limit = opts.limit ?? 20;
      const all = matchExpression(query, false);
      if (!all) return [];
      let rows = run(root, all, opts.kind, limit);
      if (!rows.length) {
        const any = matchExpression(query, true) as string;
        rows = run(root, any, opts.kind, limit);
      }
      return rows.map((r) => ({
        kind: r.kind as 'symbol' | 'file',
        path: r.path,
        name: r.name,
        symbol_kind: r.symbol_kind,
        line: r.line,
        signature: r.signature,
        score: Math.round(-r.rank * 1000) / 1000,
      }));
    },
    clear: () => db.exec('DELETE FROM graph_fts'),
    close: () => {
      if (owned) closeDatabase(db);
    },
  };
}

export function memorySearchIndex(): SearchIndex {
  return index(openDatabase(':memory:'), true);
}

/** `<dir>/search.db`, usually `.friday/graph/search.db` (ignored by git; derived, safe to delete). */
export function openSearchIndex(dir: string): SearchIndex {
  mkdirSync(dir, { recursive: true });
  return index(openDatabase(path.join(dir, 'search.db')), true);
}
