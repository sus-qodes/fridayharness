import { mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { closeDatabase, openDatabase, type SqlDatabase } from '@friday/db';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * A Merkle tree over the files git sees in an execution root (ADR-0037 §2): per file the BLAKE3 of
 * its bytes, remembered with its size and modification time so an unchanged file keeps its hash
 * unread; per folder the BLAKE3 of its children's names and hashes; the root hash names the tree.
 * "Did anything change since the last graph" costs a stat per file and reads nothing when nothing
 * changed. Git's source identity (ADR-0019) stays the authority on what the checkout is; this tree
 * accelerates the graph's own staleness check and names graph versions, and when the two disagree
 * git wins and the tree is simply scanned again.
 */

export interface TreeScan {
  /** The tree's hash now. */
  root_hash: string;
  /** The tree's hash at the previous scan of this root, or null for the first scan. */
  previous_root_hash: string | null;
  /** Paths whose hash differs from the previous scan, including files added and removed. */
  changed: Set<string>;
  files: number;
  /** Files hashed (read) in this scan; the rest kept their hash from their size and time. */
  read: number;
  unchanged: number;
  ms: number;
}

export interface MerkleStore {
  /** Scans the root's files, updates the records, and says what changed since the last scan. */
  scan(root: string, files: readonly string[], opts?: { yieldEvery?: number }): Promise<TreeScan>;
  /** The root hash of the last scan, or null. */
  rootHash(root: string): string | null;
  /** Forgets every record (`friday graph reindex`). */
  clear(): void;
  close(): void;
}

/** Bump when the records' shape or the hashing changes: an older store is discarded. */
export const MERKLE_FORMAT = 1;

const hex = (bytes: Uint8Array) => bytesToHex(blake3(bytes));
export const hashBytes = (bytes: Uint8Array): string => hex(bytes);

interface Record_ {
  size: number;
  mtime_ms: number;
  hash: string;
}

/** The folder hashes from the file hashes, bottom-up; the root's is returned. */
export function treeHash(hashes: ReadonlyMap<string, string>): string {
  const children = new Map<string, { name: string; hash: string }[]>();
  const add = (dir: string, name: string, hash: string) => {
    const list = children.get(dir) ?? [];
    list.push({ name, hash });
    children.set(dir, list);
  };
  for (const [p, h] of hashes) add(path.posix.dirname(p), path.posix.basename(p), h);
  const dirs = [...new Set([...hashes.keys()].map((p) => path.posix.dirname(p)))];
  // Every folder up to the root is a node, even one holding only folders.
  for (const d of dirs) {
    let cur = d;
    while (cur !== '.' && cur !== '') {
      const parent = path.posix.dirname(cur);
      if (!children.has(parent)) children.set(parent, []);
      cur = parent;
    }
  }
  const memo = new Map<string, string>();
  const hashOf = (dir: string): string => {
    const known = memo.get(dir);
    if (known) return known;
    const entries = [...(children.get(dir) ?? [])];
    for (const sub of [...children.keys()].filter((d) => d !== '.' && d !== '' && path.posix.dirname(d) === dir)) {
      entries.push({ name: `${path.posix.basename(sub)}/`, hash: hashOf(sub) });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const h = hex(utf8ToBytes(entries.map((e) => `${e.name}\u0000${e.hash}\n`).join('')));
    memo.set(dir, h);
    return h;
  };
  return hashOf('.');
}

interface Backend {
  load(root: string): Map<string, Record_>;
  rootHash(root: string): string | null;
  save(root: string, records: Map<string, Record_>, hash: string): void;
  clear(): void;
  close(): void;
}

function store(backend: Backend): MerkleStore {
  return {
    async scan(root, files, opts = {}) {
      const started = Date.now();
      const previous = backend.load(root);
      const previousHash = backend.rootHash(root);
      const records = new Map<string, Record_>();
      const hashes = new Map<string, string>();
      const changed = new Set<string>();
      let read = 0;
      let unchanged = 0;
      let count = 0;
      for (const rel of files) {
        if (++count % (opts.yieldEvery ?? 200) === 0) await nextTurn();
        const abs = path.join(root, rel);
        let st: { size: number; mtimeMs: number };
        try {
          const s = await stat(abs);
          if (!s.isFile()) continue;
          st = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          continue; // listed by git, gone from the working tree: as deleted
        }
        const prev = previous.get(rel);
        let hash: string;
        if (prev && prev.size === st.size && prev.mtime_ms === st.mtimeMs) {
          hash = prev.hash;
          unchanged += 1;
        } else {
          try {
            hash = hex(await readFile(abs));
          } catch {
            continue;
          }
          read += 1;
          if (!prev || prev.hash !== hash) changed.add(rel);
        }
        records.set(rel, { size: st.size, mtime_ms: st.mtimeMs, hash });
        hashes.set(rel, hash);
      }
      for (const p of previous.keys()) if (!records.has(p)) changed.add(p);
      const root_hash = treeHash(hashes);
      backend.save(root, records, root_hash);
      return {
        root_hash,
        previous_root_hash: previousHash,
        changed,
        files: records.size,
        read,
        unchanged,
        ms: Date.now() - started,
      };
    },
    rootHash: (root) => backend.rootHash(root),
    clear: () => backend.clear(),
    close: () => backend.close(),
  };
}

export function memoryMerkleStore(): MerkleStore {
  const roots = new Map<string, { records: Map<string, Record_>; hash: string }>();
  return store({
    load: (root) => new Map(roots.get(root)?.records ?? []),
    rootHash: (root) => roots.get(root)?.hash ?? null,
    save: (root, records, hash) => roots.set(root, { records: new Map(records), hash }),
    clear: () => roots.clear(),
    close: () => undefined,
  });
}

/** `<dir>/merkle.db`, usually `.friday/graph/merkle.db` (ignored by git; derived, safe to delete). */
export function openMerkleStore(dir: string): MerkleStore {
  mkdirSync(dir, { recursive: true });
  const db: SqlDatabase = openDatabase(path.join(dir, 'merkle.db'));
  if (Number(db.pragma('user_version')) !== MERKLE_FORMAT) {
    db.exec('DROP TABLE IF EXISTS tree; DROP TABLE IF EXISTS roots');
    db.exec(
      `CREATE TABLE tree (root TEXT NOT NULL, path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (root, path)) WITHOUT ROWID;
       CREATE TABLE roots (root TEXT PRIMARY KEY, hash TEXT NOT NULL, scanned_at TEXT NOT NULL) WITHOUT ROWID`,
    );
    db.pragma(`user_version = ${MERKLE_FORMAT}`);
  }
  const load = db.prepare('SELECT path, size, mtime_ms, hash FROM tree WHERE root = ?');
  const rootHash = db.prepare('SELECT hash FROM roots WHERE root = ?');
  const del = db.prepare('DELETE FROM tree WHERE root = ?');
  const put = db.prepare('INSERT INTO tree (root, path, size, mtime_ms, hash) VALUES (?, ?, ?, ?, ?)');
  const putRoot = db.prepare('INSERT OR REPLACE INTO roots (root, hash, scanned_at) VALUES (?, ?, ?)');
  return store({
    load(root) {
      const out = new Map<string, Record_>();
      for (const r of load.all<{ path: string; size: number; mtime_ms: number; hash: string }>(root)) {
        out.set(r.path, { size: r.size, mtime_ms: r.mtime_ms, hash: r.hash });
      }
      return out;
    },
    rootHash: (root) => rootHash.get<{ hash: string }>(root)?.hash ?? null,
    save(root, records, hash) {
      db.transaction(() => {
        del.run(root);
        for (const [p, r] of records) put.run(root, p, r.size, r.mtime_ms, r.hash);
        putRoot.run(root, hash, new Date().toISOString());
      });
    },
    clear: () => db.exec('DELETE FROM tree; DELETE FROM roots'),
    close: () => closeDatabase(db),
  });
}
