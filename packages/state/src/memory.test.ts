/**
 * Scoped memory with provenance and authority (plan M4c, ADR-0021).
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, DOMAIN_TABLES, FridayState, type MemoryActor } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const H: MemoryActor = { kind: 'human', actor: human };
const BRAIN: MemoryActor = { kind: 'master_brain', actor: { kind: 'master_brain', id: 'master-brain' } };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

function agent(key: string, role = 'backend', harnessKey = `fake:${key}`): Caller & { shadow: boolean } {
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: harnessKey,
      vendor: 'generic',
      name: key,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: key, role },
    }),
  );
  return { harness_id: r.harness_id, agent_id: r.agent_id, shadow: r.shadow };
}

function task(key: string, summary: string): string {
  const t = state.createTask(PROJECT, human, {
    summary,
    scope: { write: [`${summary}/**`], read: [] },
    assign_agent_key: key,
  });
  return t.task_id;
}

const A = (caller: Caller): MemoryActor => ({ kind: 'agent', caller });

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    return (e as FridayError).code;
  }
  throw new Error('expected an error');
}

describe('Part 12 §12: a contradiction supersedes without deleting', () => {
  it('replaces "Auth uses JWT" with a human decision for OAuth, and keeps the old one readable', () => {
    const old = state.memory.record(PROJECT, BRAIN, {
      scope_type: 'project',
      kind: 'architecture',
      subject: 'Authentication',
      content: 'Auth uses JWT.',
      tags: ['auth'],
    }).memory;
    expect(old).toMatchObject({ authority: 'system', verification_status: 'unverified', status: 'active' });
    clock.advance(60_000);
    const decision = state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'architecture',
      subject: '  authentication ',
      content: 'Auth uses OAuth through the AuthService abstraction.',
    });
    expect(decision.superseded).toEqual([old.memory_id]);
    expect(decision.memory).toMatchObject({
      authority: 'human-approved',
      verification_status: 'verified',
      supersedes: old.memory_id,
    });
    expect(state.memory.get(old.memory_id)).toMatchObject({
      status: 'superseded',
      superseded_by: decision.memory.memory_id,
    });
    expect(state.memory.search(PROJECT, H, { query: 'auth' }).map((m) => m.memory_id)).toEqual([
      decision.memory.memory_id,
    ]);
    expect(
      state.memory
        .search(PROJECT, H, { query: 'auth', include_inactive: true })
        .map((m) => m.status)
        .sort(),
    ).toEqual(['active', 'superseded']);
  });
});

describe('authority and scope', () => {
  it('never lets an agent or the Master Brain replace a human-approved decision; it waits for review', () => {
    const be = agent('be-1');
    const t = task('be-1', 'backend');
    const money = state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'decision',
      subject: 'money',
      content: 'Money is integer minor units with an ISO-4217 currency.',
    }).memory;
    const brain = state.memory.record(PROJECT, BRAIN, {
      scope_type: 'project',
      kind: 'decision',
      subject: 'money',
      content: 'Money is a float in euros.',
    });
    expect(brain).toMatchObject({ superseded: [], contradicts: [money.memory_id], memory: { needs_review: true } });
    const mine = state.memory.record(PROJECT, A(be), {
      scope_type: 'task',
      scope_id: t,
      kind: 'decision',
      subject: 'Money',
      content: 'Use floats for money here, it is simpler.',
    });
    expect(mine.superseded).toEqual([]);
    expect(mine.contradicts).toContain(money.memory_id);
    expect(mine.memory.needs_review).toBe(true);
    expect(state.memory.get(money.memory_id)).toMatchObject({ status: 'active', authority: 'human-approved' });
    expect(
      code(() => state.memory.supersede(PROJECT, A(be), money.memory_id, mine.memory.memory_id, 'mine is better')),
    ).toBe('COS-3000');
    expect(code(() => state.memory.retract(PROJECT, A(be), money.memory_id, 'no'))).toBe('COS-3000');
    // A human may.
    state.memory.supersede(PROJECT, H, money.memory_id, mine.memory.memory_id, 'changed our mind');
    expect(state.memory.get(money.memory_id).status).toBe('superseded');
  });

  it('lets the same source update its own memory, and a higher authority replace a lower one in its scope', () => {
    const be = agent('be-1');
    const t = task('be-1', 'backend');
    const first = state.memory.record(PROJECT, A(be), {
      scope_type: 'task',
      kind: 'convention',
      subject: 'cache ttl',
      content: 'Cache for 5 minutes.',
    });
    expect(first.memory).toMatchObject({ scope_id: t, authority: 'agent', source: { kind: 'agent', id: 'be-1' } });
    const second = state.memory.record(PROJECT, A(be), {
      scope_type: 'task',
      kind: 'convention',
      subject: 'Cache TTL',
      content: 'Cache for 10 minutes.',
    });
    expect(second.superseded).toEqual([first.memory.memory_id]);
    const human = state.memory.record(PROJECT, H, {
      scope_type: 'task',
      scope_id: t,
      kind: 'convention',
      subject: 'cache ttl',
      content: 'Do not cache prices.',
    });
    expect(human.superseded).toEqual([second.memory.memory_id]);
  });

  it('never lets a child scope change project memory, nor a project memory erase a task memory', () => {
    const be = agent('be-1');
    task('be-1', 'backend');
    const project = state.memory.record(PROJECT, BRAIN, {
      scope_type: 'project',
      kind: 'constraint',
      subject: 'node',
      content: 'Node 24 only.',
    }).memory;
    const child = state.memory.record(PROJECT, A(be), {
      scope_type: 'task',
      kind: 'constraint',
      subject: 'node',
      content: 'Node 22 works too.',
    });
    expect(child).toMatchObject({ superseded: [], contradicts: [project.memory_id] });
    const later = state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'constraint',
      subject: 'node',
      content: 'Node 24 or 26.',
    });
    expect(later.superseded).toEqual([project.memory_id]);
    expect(later.contradicts).toEqual([child.memory.memory_id]);
    expect(state.memory.get(child.memory.memory_id).status).toBe('active');
  });

  it('records nothing for a duplicate', () => {
    const first = state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'convention',
      subject: 'Commits',
      content: 'Use conventional commits.',
    });
    const head = state.store.head(PROJECT);
    const again = state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'convention',
      subject: 'commits',
      content: '  use   conventional commits. ',
    });
    expect(again).toMatchObject({ deduplicated: true, memory: { memory_id: first.memory.memory_id } });
    expect(state.store.head(PROJECT)).toBe(head);
  });

  it('keeps agents to their own task, agent and session scopes', () => {
    const be = agent('be-1');
    const fe = agent('fe-1', 'frontend');
    task('be-1', 'backend');
    const feTask = task('fe-1', 'frontend');
    const m = (scope_type: 'project' | 'team' | 'agent' | 'task' | 'session' | 'organization', scope_id?: string) => ({
      scope_type,
      ...(scope_id ? { scope_id } : {}),
      kind: 'summary' as const,
      subject: 's',
      content: `${scope_type} note`,
    });
    expect(code(() => state.memory.record(PROJECT, A(be), m('project')))).toBe('COS-3000');
    expect(code(() => state.memory.record(PROJECT, A(be), m('team', 'backend')))).toBe('COS-3000');
    expect(code(() => state.memory.record(PROJECT, A(be), m('agent', 'fe-1')))).toBe('COS-3000');
    expect(code(() => state.memory.record(PROJECT, A(be), m('task', feTask)))).toBe('COS-3000');
    expect(code(() => state.memory.record(PROJECT, A(be), m('session', fe.harness_id)))).toBe('COS-3000');
    expect(code(() => state.memory.record(PROJECT, H, m('organization')))).toBe('COS-1000');
    expect(code(() => state.memory.record(PROJECT, BRAIN, m('agent', 'be-1')))).toBe('COS-3000');
    expect(state.memory.record(PROJECT, A(be), m('agent')).memory).toMatchObject({
      scope_type: 'agent',
      scope_id: 'be-1',
    });
    expect(state.memory.record(PROJECT, A(be), m('session')).memory).toMatchObject({ scope_id: be.harness_id });
    const shadow = agent('be-1', 'backend', 'fake:be-1:second');
    expect(shadow.shadow).toBe(true);
    expect(code(() => state.memory.record(PROJECT, A(shadow), m('agent')))).toBe('COS-4006');
  });
});

describe('search and decay', () => {
  it('ranks an old approved decision above a newer speculative observation, within what the reader may read', () => {
    const be = agent('be-1');
    const fe = agent('fe-1', 'frontend');
    task('be-1', 'backend');
    const decision = state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'decision',
      subject: 'login',
      content: 'Use OAuth for login.',
    }).memory;
    clock.advance(340 * 86_400_000);
    const guess = state.memory.record(PROJECT, A(be), {
      scope_type: 'agent',
      kind: 'learned-risk',
      subject: 'login flake',
      content: 'OAuth login seems flaky in tests.',
    }).memory;
    const feNote = state.memory.record(PROJECT, A(fe), {
      scope_type: 'agent',
      kind: 'summary',
      subject: 'fe',
      content: 'OAuth login button styling.',
    }).memory;
    clock.advance(60 * 86_400_000);
    const hits = state.memory.search(PROJECT, A(be), { query: 'oauth login' });
    expect(hits.map((h) => h.memory_id)).toEqual([decision.memory_id, guess.memory_id]);
    expect(hits[0]?.why.weight).toBe(1);
    expect(hits[1]?.why.weight).toBeLessThan(0.15);
    // Humans read every scope; another agent's own memory is not readable by be-1.
    expect(state.memory.search(PROJECT, H, { query: 'oauth' }).map((h) => h.memory_id)).toContain(feNote.memory_id);
    // Reuse lifts a memory; retraction removes it.
    const before = state.memory.search(PROJECT, A(be), { query: 'flaky' })[0]?.score ?? 0;
    state.memory.noteUse(PROJECT, [guess.memory_id, guess.memory_id]);
    state.memory.noteUse(PROJECT, [guess.memory_id]);
    expect(state.memory.search(PROJECT, A(be), { query: 'flaky' })[0]?.score).toBeGreaterThan(before);
    state.memory.retract(PROJECT, A(be), guess.memory_id, 'it was a slow CI runner');
    expect(state.memory.search(PROJECT, A(be), { query: 'flaky' })).toEqual([]);
  });

  it('treats query text as words, never as FTS syntax', () => {
    state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'convention',
      subject: 'quotes',
      content: 'He said "hello" (twice).',
    });
    expect(() => state.memory.search(PROJECT, H, { query: 'hello" OR (NEAR x' })).not.toThrow();
    expect(state.memory.search(PROJECT, H, { query: 'hello" OR (NEAR x' })).toHaveLength(1);
    expect(state.memory.search(PROJECT, H, { query: '***' })).toEqual([]);
  });

  it('lets a human approve a memory waiting for review', () => {
    const be = agent('be-1');
    task('be-1', 'backend');
    const m = state.memory.record(PROJECT, A(be), {
      scope_type: 'task',
      kind: 'bug-pattern',
      subject: 'rounding',
      content: 'Round per line.',
    }).memory;
    expect(code(() => state.memory.approve(PROJECT, { kind: 'agent', id: be.agent_id }, m.memory_id))).toBe('COS-3000');
    expect(state.memory.approve(PROJECT, human, m.memory_id)).toMatchObject({
      authority: 'human-approved',
      verification_status: 'verified',
      needs_review: false,
    });
  });
});

describe('replay', () => {
  it('rebuilds memories, links and the search index exactly', () => {
    const be = agent('be-1');
    task('be-1', 'backend');
    state.memory.record(PROJECT, BRAIN, {
      scope_type: 'project',
      kind: 'architecture',
      subject: 'auth',
      content: 'Auth uses JWT.',
    });
    state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'architecture',
      subject: 'auth',
      content: 'Auth uses OAuth.',
    });
    state.memory.record(PROJECT, A(be), {
      scope_type: 'task',
      kind: 'architecture',
      subject: 'auth',
      content: 'Auth via API keys.',
    });
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
    const before = dump();
    const found = state.memory.search(PROJECT, H, { query: 'oauth' }).map((m) => m.memory_id);
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
    expect(state.memory.search(PROJECT, H, { query: 'oauth' }).map((m) => m.memory_id)).toEqual(found);
    // FTS5 checks its index; with rank 1 also against the content table, throwing when they disagree.
    expect(() => db.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('integrity-check')").run()).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO memories_fts(memories_fts, rank) VALUES ('integrity-check', 1)").run(),
    ).not.toThrow();
  });

  it('keeps an index whose columns the content table has, so it can be read and rebuilt (v16)', () => {
    state.memory.record(PROJECT, H, {
      scope_type: 'project',
      kind: 'decision',
      subject: 'Auth uses OAuth device flow',
      content: 'Sessions are refreshed by the backend.',
      tags: ['auth'],
    });
    // v8 named a column `tags` that `memories` lacks: reading the index's columns failed.
    expect(db.prepare('SELECT subject, tags_json FROM memories_fts').all()).toEqual([
      { subject: 'Auth uses OAuth device flow', tags_json: '["auth"]' },
    ]);
    expect(() => db.prepare("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')").run()).not.toThrow();
    expect(state.memory.search(PROJECT, H, { query: 'oauth' })).toHaveLength(1);
  });
});
