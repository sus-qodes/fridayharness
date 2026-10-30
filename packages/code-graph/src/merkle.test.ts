/**
 * The Merkle tree over a root's files (ADR-0037 §2; plan Phase 5B): BLAKE3 per file, kept by
 * size and time, folder hashes from the children, and what changed between scans.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { hashBytes, memoryMerkleStore, openMerkleStore, treeHash } from './merkle.js';

const ws = useTestWorkspace();

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
}

describe('treeHash', () => {
  it('is the same for the same files whatever their order, and differs when any hash, name or folder differs', () => {
    const a = treeHash(
      new Map([
        ['src/a.ts', 'h1'],
        ['src/b.ts', 'h2'],
        ['README.md', 'h3'],
      ]),
    );
    const b = treeHash(
      new Map([
        ['README.md', 'h3'],
        ['src/b.ts', 'h2'],
        ['src/a.ts', 'h1'],
      ]),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(
      treeHash(
        new Map([
          ['src/a.ts', 'h1'],
          ['src/b.ts', 'h9'],
          ['README.md', 'h3'],
        ]),
      ),
    ).not.toBe(a);
    expect(
      treeHash(
        new Map([
          ['src/a.ts', 'h1'],
          ['src/c.ts', 'h2'],
          ['README.md', 'h3'],
        ]),
      ),
    ).not.toBe(a);
    expect(
      treeHash(
        new Map([
          ['lib/a.ts', 'h1'],
          ['lib/b.ts', 'h2'],
          ['README.md', 'h3'],
        ]),
      ),
    ).not.toBe(a);
    expect(treeHash(new Map())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBytes(new TextEncoder().encode('abc'))).toBe(
      '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85',
    );
  });
});

describe('MerkleStore', () => {
  for (const [name, open] of [
    ['in memory', () => memoryMerkleStore()],
    ['on disk', () => openMerkleStore(path.join(ws().root, 'merkle-cache'))],
  ] as const) {
    it(`${name}: reads every file once, then nothing while nothing changes, and names what changed`, async () => {
      const root = path.join(ws().root, 'tree');
      write(root, { 'src/a.ts': 'a', 'src/b.ts': 'b', 'docs/x.md': 'x' });
      const files = ['src/a.ts', 'src/b.ts', 'docs/x.md'];
      const store = open();
      ws().track(store);
      const first = await store.scan(root, files);
      expect(first).toMatchObject({ previous_root_hash: null, files: 3, read: 3, unchanged: 0 });
      expect([...first.changed].sort()).toEqual(files.slice().sort());
      expect(store.rootHash(root)).toBe(first.root_hash);

      const again = await store.scan(root, files);
      expect(again).toMatchObject({
        root_hash: first.root_hash,
        previous_root_hash: first.root_hash,
        files: 3,
        read: 0,
        unchanged: 3,
      });
      expect(again.changed.size).toBe(0);

      // A rewrite with the same bytes and a new time is read, and is no change.
      const later = new Date(Date.now() + 5_000);
      utimesSync(path.join(root, 'src/a.ts'), later, later);
      const touched = await store.scan(root, files);
      expect(touched).toMatchObject({ root_hash: first.root_hash, read: 1, unchanged: 2 });
      expect(touched.changed.size).toBe(0);

      // A real change, a new file and a deleted one: each named, and the root hash moves.
      write(root, { 'src/b.ts': 'bb', 'src/c.ts': 'c' });
      rmSync(path.join(root, 'docs/x.md'));
      const changed = await store.scan(root, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
      expect(changed.root_hash).not.toBe(first.root_hash);
      expect(changed.previous_root_hash).toBe(first.root_hash);
      expect([...changed.changed].sort()).toEqual(['docs/x.md', 'src/b.ts', 'src/c.ts']);
      expect(changed).toMatchObject({ files: 3, read: 2, unchanged: 1 });

      store.clear();
      expect(store.rootHash(root)).toBeNull();
    });
  }
});
