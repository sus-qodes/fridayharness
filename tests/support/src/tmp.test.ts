import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestWorkspace, MAX_TEST_ROOT_LENGTH, useTestWorkspace } from './tmp.js';

describe('createTestWorkspace', () => {
  it('creates a short root with project, .friday and state directories', async () => {
    const ws = await createTestWorkspace();
    try {
      expect(ws.root.length).toBeLessThanOrEqual(MAX_TEST_ROOT_LENGTH);
      expect(existsSync(ws.projectDir)).toBe(true);
      expect(existsSync(ws.fridayDir)).toBe(true);
      expect(existsSync(ws.stateDir)).toBe(true);
      expect(ws.dbPath).toBe(path.join(ws.fridayDir, 'project.db'));
    } finally {
      await ws.cleanup();
    }
    expect(existsSync(ws.root)).toBe(false);
  });

  it('refuses a temp base that would make the root too long', async () => {
    const longBase = path.join(os.tmpdir(), `fri-long-${'x'.repeat(MAX_TEST_ROOT_LENGTH)}`);
    mkdirSync(longBase, { recursive: true });
    try {
      await expect(createTestWorkspace({ base: longBase })).rejects.toThrow(/FRIDAY_TEST_TMP/);
    } finally {
      rmSync(longBase, { recursive: true, force: true });
    }
  });

  it('closes tracked resources in reverse order before deleting', async () => {
    const ws = await createTestWorkspace();
    const order: string[] = [];
    ws.track({ close: () => order.push('first') });
    ws.track({ close: () => order.push('second') });
    await ws.cleanup();
    expect(order).toEqual(['second', 'first']);
    expect(existsSync(ws.root)).toBe(false);
  });

  it('keep() leaves the directory on disk', async () => {
    const ws = await createTestWorkspace();
    ws.keep('debugging');
    const result = await ws.cleanup();
    expect(result.removed).toBe(false);
    expect(ws.keptReason).toBe('debugging');
    expect(existsSync(ws.root)).toBe(true);
    rmSync(ws.root, { recursive: true, force: true });
  });

  it('deletes a directory holding a WAL-mode SQLite database once it is closed', async () => {
    const sqlite = await import('node:sqlite').catch(() => null);
    if (!sqlite) return; // node:sqlite unavailable on this Node build; better-sqlite3 coverage arrives in M1
    const ws = await createTestWorkspace();
    const db = new sqlite.DatabaseSync(ws.dbPath);
    db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1);');
    expect(existsSync(`${ws.dbPath}-wal`)).toBe(true);
    ws.track({
      close: () => {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        db.close();
      },
    });
    const result = await ws.cleanup();
    expect(result.removed).toBe(true);
    expect(existsSync(ws.root)).toBe(false);
  });
});

describe('useTestWorkspace', () => {
  const ws = useTestWorkspace();
  let previousRoot = '';

  it('provides a fresh workspace to each test', () => {
    previousRoot = ws().root;
    writeFileSync(path.join(ws().projectDir, 'marker.txt'), 'x');
    expect(existsSync(previousRoot)).toBe(true);
  });

  it('deleted the previous test workspace', () => {
    expect(previousRoot).not.toBe('');
    expect(ws().root).not.toBe(previousRoot);
    expect(existsSync(previousRoot)).toBe(false);
  });
});
