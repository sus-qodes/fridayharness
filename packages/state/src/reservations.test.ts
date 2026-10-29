/**
 * File reservations in the state (plan M5c, ADR-0025 §1).
 */
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_TABLES, FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-user' };
const same = (a: string, b: string) => a === b || (b.endsWith('/**') && a.startsWith(b.slice(0, -2)));
const overlaps = (a: string, b: string) => same(a, b) || same(b, a);

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock, config: { fileReservationTtlMs: 60_000 } });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

const task = (summary: string) => state.createTask(PROJECT, human, { summary, ready: true }).task_id;

function refusal(fn: () => unknown): FridayError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    return e as FridayError;
  }
  throw new Error('expected an error');
}

describe('file reservations', () => {
  it('gives a pattern to one task at a time, keeps what a task already holds, and names the holder', () => {
    const a = task('a');
    const b = task('b');
    const [held] = state.reserveFiles(PROJECT, human, a, ['migrations/**'], 'human', overlaps, 'schema change');
    expect(held).toMatchObject({
      task_id: a,
      pattern: 'migrations/**',
      status: 'active',
      via: 'human',
      note: 'schema change',
    });
    // Asking again is not a second reservation.
    expect(state.reserveFiles(PROJECT, human, a, ['migrations/**'], 'write', overlaps)[0]?.reservation_id).toBe(
      held?.reservation_id,
    );
    const err = refusal(() => state.reserveFiles(PROJECT, human, b, ['migrations/0007.sql'], 'write', overlaps));
    expect(err.code).toBe('COS-8002');
    expect(err.message).toContain(a);
    expect(err.details).toMatchObject({ holder_task_id: a, pattern: 'migrations/**' });
    // A refused request takes nothing, not even its free patterns.
    refusal(() => state.reserveFiles(PROJECT, human, b, ['pnpm-lock.yaml', 'migrations/x.sql'], 'write', overlaps));
    expect(state.q.fileReservations(PROJECT, ['active']).map((r) => r.pattern)).toEqual(['migrations/**']);
  });

  it('ends with its task, expires when the task stands still, and a human can release it', () => {
    const a = task('a');
    const b = task('b');
    const c = task('c');
    state.reserveFiles(PROJECT, human, a, ['pnpm-lock.yaml'], 'write', overlaps);
    state.reserveFiles(PROJECT, human, b, ['shared/api.ts'], 'write', overlaps);
    const [manual] = state.reserveFiles(PROJECT, human, c, ['infra/**'], 'human', overlaps);

    state.cancelTask(PROJECT, human, a, 'not needed');
    expect(
      state.q
        .fileReservations(PROJECT, ['active'])
        .map((r) => r.task_id)
        .sort(),
    ).toEqual([b, c].sort());
    expect(state.q.fileReservations(PROJECT).find((r) => r.task_id === a)).toMatchObject({
      status: 'released',
      note: 'the task was cancelled',
    });

    // b and c are READY (standing still): after the TTL their reservations expire.
    clock.advance(30_000);
    expect(state.tick(PROJECT).files_released).toEqual([]);
    state.releaseFileReservation(PROJECT, human, manual?.reservation_id as string, 'done by hand');
    clock.advance(31_000);
    const expired = state.tick(PROJECT).files_released;
    expect(expired).toHaveLength(1);
    expect(state.q.fileReservation(expired[0] as string)).toMatchObject({ task_id: b, status: 'expired' });
    expect(state.q.fileReservation(manual?.reservation_id as string)).toMatchObject({
      status: 'released',
      note: 'done by hand',
    });
    expect(() => state.reserveFiles(PROJECT, human, a, ['x'], 'human', overlaps)).toThrow(/CANCELLED/);

    const dump = () => Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });
});
