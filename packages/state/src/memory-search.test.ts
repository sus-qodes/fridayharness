import path from 'node:path';
import { sequentialIds } from '@friday/core';
import { type DriverName, openDatabase, type SqlDatabase, type SqlStatement, type SqlValue } from '@friday/db';
import { HarnessRegisterParams } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decayWeight,
  ftsQuery,
  type MemoryActor,
  type MemoryView,
  type SearchHit,
  type SearchQuery,
} from './memory.js';
import { FridayState } from './service.js';

const PROJECT = 'proj_memory_search';
const OTHER = 'proj_other_memory_search';
const NOW = '2026-01-01T12:00:00.000Z';
const HUMAN: MemoryActor = { kind: 'human', actor: { kind: 'human', id: 'operator' } };
type RankedRow = Pick<MemoryView, 'memory_id' | 'authority' | 'verification_status' | 'status' | 'updated_at'> & {
  needs_review: number;
  rank: number;
  uses: number;
};
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Contract oracle: build every full view before sorting, independently of search's implementation. */
function referenceSearch(state: FridayState, who: MemoryActor, q: SearchQuery = {}): SearchHit[] {
  const allowed = state.memory.readScopes(PROJECT, who);
  const scopes =
    allowed && q.scopes
      ? q.scopes.filter((s) => allowed.some((a) => a.scope_type === s.scope_type && a.scope_id === s.scope_id))
      : (q.scopes ?? allowed);
  if (scopes?.length === 0) return [];
  const where = ['m.project_id = ?'];
  const params: SqlValue[] = [PROJECT];
  if (!q.include_inactive) where.push("m.status = 'active'");
  if (q.kinds?.length) {
    where.push(`m.kind IN (${q.kinds.map(() => '?').join(', ')})`);
    params.push(...q.kinds);
  }
  if (scopes) {
    where.push(`(${scopes.map(() => '(m.scope_type = ? AND m.scope_id = ?)').join(' OR ')})`);
    for (const scope of scopes) params.push(scope.scope_type, scope.scope_id);
  }
  const match = ftsQuery(q.query);
  if (!match && q.query?.trim()) return [];
  const rows = state.db
    .prepare(
      match
        ? `SELECT m.*, -bm25(memories_fts, 4.0, 1.0, 2.0) AS rank, COALESCE(u.uses, 0) AS uses
       FROM memories_fts JOIN memories m ON m.rowid = memories_fts.rowid
       LEFT JOIN memory_usage u ON u.memory_id = m.memory_id
       WHERE memories_fts MATCH ? AND ${where.join(' AND ')}`
        : `SELECT m.*, 0 AS rank, COALESCE(u.uses, 0) AS uses FROM memories m
       LEFT JOIN memory_usage u ON u.memory_id = m.memory_id WHERE ${where.join(' AND ')}`,
    )
    .all<RankedRow>(...(match ? [match, ...params] : params));
  const best = Math.max(0, ...rows.map((row) => row.rank));
  return rows
    .map((row) => {
      const weight = decayWeight(row, row.uses, Date.parse(NOW));
      const relevance = match && best > 0 ? Math.max(0, row.rank) / best : 1;
      return {
        ...state.memory.get(row.memory_id),
        score: round(relevance * weight),
        why: { relevance: round(relevance), weight: round(weight), uses: row.uses },
      };
    })
    .sort((a, b) => b.score - a.score || b.updated_at.localeCompare(a.updated_at))
    .slice(0, Math.min(Math.max(q.limit ?? 20, 1), 200));
}

/** Read-only ranking fixtures cover combinations without exercising the write pipeline again. */
function seed(state: FridayState, agent: MemoryActor, taskIds: string[]) {
  if (agent.kind !== 'agent') throw new Error('Agent fixture required');
  const insert = state.db.prepare(`INSERT INTO memories
    (memory_id, project_id, scope_type, scope_id, kind, subject, subject_key, content, content_hash,
     tags_json, source_events_json, source_kind, source_id, authority, verification_status, status,
     needs_review, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const scopes = ['project', 'team', 'agent', 'session', 'task'] as const;
  const authorities = ['human-approved', 'verified', 'system', 'agent'] as const;
  state.db.transaction(() => {
    for (let i = 0; i < 512; i++) {
      const project = i % 11 === 0 ? OTHER : PROJECT;
      const scope = scopes[i % scopes.length] ?? 'project';
      const scopeId =
        scope === 'project'
          ? project
          : scope === 'team'
            ? i % 2
              ? 'backend'
              : 'frontend'
            : scope === 'agent'
              ? i % 2
                ? 'dev-1'
                : 'dev-2'
              : scope === 'session'
                ? i % 2
                  ? agent.caller.harness_id
                  : 'other-session'
                : (taskIds[i % 3] ?? 'unheld-task');
      const at = new Date(Date.parse(NOW) - (i % 90) * 86_400_000).toISOString();
      const subject = `shared context authority module${i % 13} item${i}`;
      insert.run(
        `mem_fixture_${i}`,
        project,
        scope,
        scopeId,
        i % 3 ? 'decision' : 'constraint',
        subject,
        subject,
        `sqlite transaction policy secret approval 日本語 naïve café ${'scoped evidence '.repeat(12)}`,
        `fixture:${i}`,
        JSON.stringify(['fixture', `path:src/module${i % 13}.ts`]),
        JSON.stringify([`evt_fixture_${i}`]),
        'system',
        'fixture',
        authorities[i % 4] ?? 'agent',
        i % 3 ? 'verified' : 'unverified',
        i % 17 === 0 ? 'retracted' : i % 19 === 0 ? 'superseded' : 'active',
        i % 7 === 0 ? 1 : 0,
        at,
        at,
      );
    }
    const use = state.db.prepare(
      'INSERT INTO memory_usage(memory_id, project_id, uses, last_used_at) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < 512; i += 9) use.run(`mem_fixture_${i}`, i % 11 === 0 ? OTHER : PROJECT, i % 41, NOW);
    state.db
      .prepare(
        "INSERT INTO memory_links(project_id, from_id, to_id, kind, created_at) VALUES (?, ?, ?, 'contradicts', ?)",
      )
      .run(PROJECT, 'mem_fixture_108', 'mem_fixture_109', NOW);
  });
}

/** Probe actual SQLite state, including drivers whose flag tracks helper-owned transactions only. */
function expectReleased(db: SqlDatabase) {
  expect(db.inTransaction).toBe(false);
  expect(() => {
    db.exec('BEGIN');
    db.exec('ROLLBACK');
  }).not.toThrow();
}

describe.each<DriverName>(['better-sqlite3', 'node:sqlite'])('memory search snapshots and ranking (%s)', (driver) => {
  const ws = useTestWorkspace();
  let db: SqlDatabase;
  let state: FridayState;
  let agent: MemoryActor;
  beforeEach(() => {
    db = ws().track(openDatabase(ws().dbPath, { driver }));
    state = new FridayState({ db, clock: new FakeClock(NOW), ids: sequentialIds() });
    state.ensureProject({ project_id: PROJECT, name: 'memory', root_path: ws().projectDir });
    state.ensureProject({ project_id: OTHER, name: 'other', root_path: path.join(ws().root, 'other') });
    const registration = state.registerHarness(
      PROJECT,
      HarnessRegisterParams.parse({
        protocol_version: '1.0',
        project_id: PROJECT,
        harness_key: 'memory-search',
        vendor: 'generic',
        name: 'memory-search',
        attach_mode: 'attach',
        capabilities: {},
        agent: { agent_key: 'dev-1', role: 'backend' },
      }),
    );
    agent = { kind: 'agent', caller: { harness_id: registration.harness_id, agent_id: registration.agent_id } };
    const tasks = ['held task', 'reserved task'].map(
      (summary) =>
        state.createTask(PROJECT, HUMAN.actor, {
          summary,
          ready: true,
          assign_agent_key: 'dev-1',
        }).task_id,
    );
    seed(state, agent, tasks);
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns identical full records, scores and order across the query and scope matrix', () => {
    let comparisons = 0;
    for (const actor of [HUMAN, agent]) {
      for (const query of [
        undefined,
        '',
        'shared',
        'sqlite transaction',
        'policy secret approval',
        'shared shared context',
        '日本語 café',
        'module7',
        'NOT " OR )',
        'zzzzmissing',
      ]) {
        for (const limit of [0, 1, 5, 20, 200, 999]) {
          for (const include_inactive of [false, true]) {
            const q: SearchQuery = {
              query,
              limit,
              include_inactive,
              ...(comparisons % 3 === 0 ? { kinds: ['decision'] } : {}),
            };
            expect(state.memory.search(PROJECT, actor, q, NOW)).toEqual(referenceSearch(state, actor, q));
            expectReleased(db);
            comparisons++;
          }
        }
      }
    }
    for (const scopes of [
      [],
      [{ scope_type: 'team', scope_id: 'frontend' }],
      [{ scope_type: 'project', scope_id: OTHER }],
      [{ scope_type: 'agent', scope_id: 'dev-1' }],
    ] satisfies NonNullable<SearchQuery['scopes']>[]) {
      const q = { query: 'shared', scopes };
      expect(state.memory.search(PROJECT, agent, q, NOW)).toEqual(referenceSearch(state, agent, q));
      comparisons++;
    }
    const linked = state.memory.search(PROJECT, HUMAN, { query: 'item108', limit: 1 }, NOW);
    expect(linked[0]?.contradicts).toEqual(['mem_fixture_109']);
    expect(linked).toEqual(referenceSearch(state, HUMAN, { query: 'item108', limit: 1 }));
    expect(++comparisons).toBe(245);
  }, 30_000);

  it('applies authority before the limit and preserves the database order for exact ties', () => {
    const ids = ['mem_fixture_1', 'mem_fixture_2', 'mem_fixture_3'];
    db.transaction(() => {
      db.prepare('UPDATE memories SET status = ?').run('retracted');
      for (const id of ids)
        db.prepare(`UPDATE memories SET project_id = ?, scope_type = 'project', scope_id = ?,
        status = 'active', authority = 'human-approved', verification_status = 'verified', needs_review = 0, updated_at = ? WHERE memory_id = ?`).run(
          PROJECT,
          PROJECT,
          NOW,
          id,
        );
      db.prepare("UPDATE memories SET authority = 'agent' WHERE memory_id = ?").run(ids[0]);
    });
    expect(state.memory.search(PROJECT, HUMAN, { limit: 2 }, NOW).map((m) => m.memory_id)).toEqual(ids.slice(1));
    db.prepare("UPDATE memories SET authority = 'human-approved' WHERE memory_id = ?").run(ids[0]);
    expect(state.memory.search(PROJECT, HUMAN, { limit: 2 }, NOW)).toEqual(referenceSearch(state, HUMAN, { limit: 2 }));
    expect(state.memory.search(PROJECT, HUMAN, { limit: 2 }, NOW).map((m) => m.memory_id)).toEqual(ids.slice(0, 2));
  });

  it('hydrates only the selected records, including their contradiction links', () => {
    const prepare = vi.spyOn(db, 'prepare');
    const result = state.memory.search(PROJECT, HUMAN, { query: 'shared', limit: 3 }, NOW);
    expect(result).toHaveLength(3);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes('FROM memory_links'))).toHaveLength(3);
    for (const memory of result)
      expect(memory).toMatchObject({
        content: expect.any(String),
        tags: expect.any(Array),
        source_events: expect.any(Array),
        source: { kind: 'system', id: 'fixture' },
      });
  });

  it('keeps ranking and full records on one read snapshot while another connection commits', () => {
    const writer = ws().track(openDatabase(ws().dbPath, { driver, busyTimeoutMs: 50 }));
    const q = { query: 'shared', limit: 20 };
    const expected = referenceSearch(state, HUMAN, q);
    const target = expected[0]?.memory_id;
    expect(target).toBeDefined();
    let wrote = false;
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql): SqlStatement => {
      const statement = prepare(sql);
      if (!sql.includes('FROM memories_fts')) return statement;
      return {
        ...statement,
        all<T>(...params: SqlValue[]): T[] {
          const rows = statement.all<T>(...params);
          if (!wrote) {
            writer
              .prepare('UPDATE memories SET content = ?, updated_at = ? WHERE memory_id = ?')
              .run('concurrent writer body', '2026-01-02T12:00:00.000Z', target);
            wrote = true;
          }
          return rows;
        },
      };
    });
    expect(state.memory.search(PROJECT, HUMAN, q, NOW)).toEqual(expected);
    expect(wrote).toBe(true);
    expect(
      writer.prepare('SELECT content FROM memories WHERE memory_id = ?').get<{ content: string }>(target)?.content,
    ).toBe('concurrent writer body');
    expectReleased(db);
  });

  it.each(['hydration', 'commit'])('releases its own read transaction after a %s failure', (phase) => {
    const failure = new Error(`failed ${phase}`);
    const prepare = db.prepare.bind(db);
    const exec = db.exec.bind(db);
    if (phase === 'hydration')
      vi.spyOn(db, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql);
        return sql.includes('FROM memory_links')
          ? {
              ...statement,
              all: () => {
                throw failure;
              },
            }
          : statement;
      });
    else
      vi.spyOn(db, 'exec').mockImplementation((sql) => {
        if (sql === 'COMMIT') throw failure;
        exec(sql);
      });
    expect(() => state.memory.search(PROJECT, HUMAN, { limit: 3 }, NOW)).toThrow(failure);
    vi.restoreAllMocks();
    expectReleased(db);
    expect(state.memory.search(PROJECT, HUMAN, { limit: 1 }, NOW)).toHaveLength(1);
  });

  it('reuses a caller transaction and never commits its uncommitted changes', () => {
    const failure = new Error('caller rolls back');
    expect(() =>
      db.transaction(() => {
        db.prepare('UPDATE memories SET content = ? WHERE memory_id = ?').run(
          'uncommitted caller body',
          'mem_fixture_108',
        );
        expect(state.memory.search(PROJECT, HUMAN, { query: 'item108', limit: 1 }, NOW)[0]?.content).toBe(
          'uncommitted caller body',
        );
        expect(db.inTransaction).toBe(true);
        throw failure;
      }),
    ).toThrow(failure);
    expect(state.memory.get('mem_fixture_108').content).not.toBe('uncommitted caller body');
    expectReleased(db);
  });

  it('leaves the caller transaction open when hydration fails', () => {
    const failure = new Error('hydration fails inside caller transaction');
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      return sql.includes('FROM memory_links')
        ? {
            ...statement,
            all: () => {
              throw failure;
            },
          }
        : statement;
    });
    db.transaction(() => {
      db.prepare('UPDATE memories SET content = ? WHERE memory_id = ?').run('caller keeps control', 'mem_fixture_108');
      expect(() => state.memory.search(PROJECT, HUMAN, { limit: 1 }, NOW)).toThrow(failure);
      expect(db.inTransaction).toBe(true);
      expect(
        db.prepare('SELECT content FROM memories WHERE memory_id = ?').get<{ content: string }>('mem_fixture_108')
          ?.content,
      ).toBe('caller keeps control');
    });
    expectReleased(db);
  });

  it('closes its snapshot on empty scopes, non-word queries, misses and scope lookup errors', () => {
    for (const q of [{ scopes: [] }, { query: '***' }, { query: 'missingterm' }] satisfies SearchQuery[]) {
      expect(state.memory.search(PROJECT, HUMAN, q, NOW)).toEqual([]);
      expectReleased(db);
    }
    expect(() =>
      state.memory.search(PROJECT, { kind: 'agent', caller: { agent_id: 'missing', harness_id: 'missing' } }, {}, NOW),
    ).toThrow();
    expectReleased(db);
  });
});
