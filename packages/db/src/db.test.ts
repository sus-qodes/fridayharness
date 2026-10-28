import { existsSync, statSync } from 'node:fs';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { closeDatabase, type DriverName, fromJson, type Migration, migrate, openDatabase, toJson } from './index.js';

const MIGRATIONS: Migration[] = [
  { version: 1, name: 'items', up: 'CREATE TABLE items (id TEXT PRIMARY KEY, flag INTEGER, note TEXT);' },
  {
    version: 2,
    name: 'tags',
    up: 'CREATE TABLE tags (item_id TEXT NOT NULL REFERENCES items(id), tag TEXT NOT NULL);',
  },
];

describe.each<DriverName>(['better-sqlite3', 'node:sqlite'])('driver %s', (driver) => {
  const ws = useTestWorkspace();
  const open = () => ws().track(openDatabase(ws().dbPath, { driver }));

  it('opens in WAL mode with foreign keys on', () => {
    const db = open();
    expect(db.driver).toBe(driver);
    expect(String(db.pragma('journal_mode')).toLowerCase()).toBe('wal');
    expect(Number(db.pragma('foreign_keys'))).toBe(1);
  });

  it('migrates once, records checksums and sets user_version', () => {
    const db = open();
    expect(migrate(db, MIGRATIONS).applied).toEqual([1, 2]);
    expect(migrate(db, MIGRATIONS).applied).toEqual([]);
    expect(Number(db.pragma('user_version'))).toBe(2);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get<{ n: number }>()?.n).toBe(2);
  });

  it('refuses to start when an applied migration changed', () => {
    const db = open();
    migrate(db, MIGRATIONS);
    const tampered = [
      MIGRATIONS[0] as Migration,
      { ...(MIGRATIONS[1] as Migration), up: 'CREATE TABLE tags (x TEXT);' },
    ];
    expect(() => migrate(db, tampered)).toThrow(/changed after it was applied/);
  });

  it('rejects out-of-order migrations', () => {
    const db = open();
    expect(() => migrate(db, [MIGRATIONS[1] as Migration, MIGRATIONS[0] as Migration])).toThrow(/out of order/);
  });

  it('binds booleans and undefined, and round-trips rows', () => {
    const db = open();
    migrate(db, MIGRATIONS);
    db.prepare('INSERT INTO items (id, flag, note) VALUES (?, ?, ?)').run('a', true, undefined);
    expect(db.prepare('SELECT * FROM items WHERE id = ?').get('a')).toEqual({ id: 'a', flag: 1, note: null });
    expect(db.prepare('SELECT * FROM items').all()).toHaveLength(1);
  });

  it('rolls a transaction back when it throws, including nested savepoints', () => {
    const db = open();
    migrate(db, MIGRATIONS);
    const insert = db.prepare('INSERT INTO items (id) VALUES (?)');
    expect(() =>
      db.transaction(() => {
        insert.run('x');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.prepare('SELECT count(*) AS n FROM items').get<{ n: number }>()?.n).toBe(0);

    db.transaction(() => {
      insert.run('outer');
      expect(db.inTransaction).toBe(true);
      expect(() =>
        db.transaction(() => {
          insert.run('inner');
          throw new Error('inner fails');
        }),
      ).toThrow('inner fails');
    });
    expect(db.prepare('SELECT id FROM items').all()).toEqual([{ id: 'outer' }]);
    expect(db.inTransaction).toBe(false);
  });

  it('enforces foreign keys', () => {
    const db = open();
    migrate(db, MIGRATIONS);
    expect(() => db.prepare('INSERT INTO tags (item_id, tag) VALUES (?, ?)').run('missing', 't')).toThrow();
  });

  it('closeDatabase checkpoints the WAL so the directory can be deleted', async () => {
    const db = openDatabase(ws().dbPath, { driver });
    migrate(db, MIGRATIONS);
    db.prepare('INSERT INTO items (id) VALUES (?)').run('w');
    closeDatabase(db);
    const wal = `${ws().dbPath}-wal`;
    expect(!existsSync(wal) || statSync(wal).size === 0, 'WAL should be gone or empty after close').toBe(true);
    const result = await ws().cleanup();
    expect(result.removed).toBe(true);
  });
});

describe('json helpers', () => {
  it('round-trips and falls back on NULL', () => {
    expect(fromJson(toJson({ a: [1, 2] }), null)).toEqual({ a: [1, 2] });
    expect(fromJson(null, [])).toEqual([]);
  });
});
