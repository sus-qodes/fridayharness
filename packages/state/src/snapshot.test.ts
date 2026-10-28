/**
 * Snapshots, isolated replay and backup (plan M3c, ADR-0018).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { backupTo, createSnapshot, FridayState, listSnapshots, replayInto, stableStringify } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const ws = useTestWorkspace();

let db: SqlDatabase;
let state: FridayState;
let clock: FakeClock;

beforeEach(() => {
  db = openDatabase(path.join(ws().root, 'live.db'));
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
  ws().track({ close: () => db.close() });
});

/** Some history: agents, tasks through their states, messages. */
function activity(n: number): void {
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `fake:${n}`,
      vendor: 'generic',
      name: `a-${n}`,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: `a-${n}`, role: 'backend' },
    }),
  );
  const t = state.createTask(PROJECT, human, {
    summary: `task ${n}`,
    scope: { write: [`m${n}/**`], read: [] },
    ready: true,
  });
  state.assignTask(PROJECT, human, t.task_id, `a-${n}`);
  const msgs = state.pollOutbox(PROJECT, r.harness_id, 10);
  state.ackOutbox(
    PROJECT,
    r.harness_id,
    msgs.map((m) => ({ message_id: m.message_id, accepted: true, session_ref: 's' })),
  );
  state.sendMessage(
    PROJECT,
    { kind: 'human', actor: human },
    { to: `a-${n}`, mode: 'notification', content: `hello ${n}` },
  );
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    return (e as FridayError).message;
  }
  throw new Error('expected an error');
};

describe('snapshots and replay', () => {
  it('rebuilds the same state from snapshot plus tail as from the full log, in an isolated copy', () => {
    activity(1);
    activity(2);
    const snapDir = path.join(ws().root, 'snapshots');
    const snap = createSnapshot(state, PROJECT, snapDir);
    expect(snap.up_to_sequence).toBe(state.store.head(PROJECT));
    expect(snap.tables.tasks).toBe(2);
    // The same head gives the same snapshot.
    expect(createSnapshot(state, PROJECT, snapDir).snapshot_id).toBe(snap.snapshot_id);
    activity(3);
    clock.advance(1000);
    activity(4);

    let published = 0;
    state.transport.subscribe({ project_id: PROJECT }, () => {
      published += 1;
    });
    const liveHead = state.store.head(PROJECT);
    const full = replayInto(state, PROJECT, path.join(ws().root, 'full'));
    const tail = replayInto(state, PROJECT, path.join(ws().root, 'tail'), { snapshotFile: snap.file });
    expect(full).toMatchObject({ equal: true, from_snapshot: null, up_to_sequence: liveHead });
    expect(tail).toMatchObject({ equal: true, from_snapshot: snap.snapshot_id });
    expect(tail.events_applied).toBe(liveHead - snap.up_to_sequence);
    expect(full.events_applied).toBe(liveHead);
    // Replay acts on nothing: no event published, the live log unchanged, no credential in the copy.
    expect(published).toBe(0);
    expect(state.store.head(PROJECT)).toBe(liveHead);
    const copy = openDatabase(path.join(ws().root, 'tail', 'project.db'));
    expect(copy.prepare('SELECT COUNT(*) AS n FROM credentials').get<{ n: number }>()?.n).toBe(0);
    copy.close();
    expect(listSnapshots(state, PROJECT)).toMatchObject([{ snapshot_id: snap.snapshot_id, present: true }]);
  });

  it('refuses corrupt, interrupted, foreign and old snapshots, and a used destination', () => {
    activity(1);
    const snap = createSnapshot(state, PROJECT, path.join(ws().root, 'snapshots'));
    const into = (name: string) => path.join(ws().root, name);
    const original = readFileSync(snap.file, 'utf8');
    const edit = (change: (s: Record<string, unknown>) => void) => {
      const s = JSON.parse(original) as Record<string, unknown>;
      change(s);
      writeFileSync(snap.file, JSON.stringify(s));
    };

    edit((s) => {
      ((s.tables as Record<string, Record<string, unknown>[]>).tasks?.[0] as Record<string, unknown>).summary =
        'tampered';
    });
    expect(code(() => replayInto(state, PROJECT, into('r1'), { snapshotFile: snap.file }))).toMatch(/corrupt/);
    writeFileSync(snap.file, original.slice(0, original.length / 2));
    expect(code(() => replayInto(state, PROJECT, into('r2'), { snapshotFile: snap.file }))).toMatch(
      /interrupted write/,
    );
    edit((s) => {
      s.schema_version = 1;
    });
    // A changed field breaks the hash first; a consistent old snapshot is refused for its schema.
    expect(code(() => replayInto(state, PROJECT, into('r3'), { snapshotFile: snap.file }))).toMatch(/corrupt/);
    writeFileSync(snap.file, original);
    const other = new FridayState({ db: openDatabase(path.join(ws().root, 'other.db')), clock, ids: sequentialIds() });
    other.ensureProject({ project_id: 'proj_00000000000000000000000002', name: 'other', root_path: 'C:/other' });
    expect(
      code(() => replayInto(other, 'proj_00000000000000000000000002', into('r4'), { snapshotFile: snap.file })),
    ).toMatch(/belongs to project/);
    other.db.close();
    replayInto(state, PROJECT, into('r5'));
    expect(code(() => replayInto(state, PROJECT, into('r5')))).toMatch(/not empty/);
  });

  it('refuses a snapshot taken at another schema version', () => {
    activity(1);
    const snap = createSnapshot(state, PROJECT, path.join(ws().root, 'snapshots'));
    const s = JSON.parse(readFileSync(snap.file, 'utf8'));
    // Re-sign the snapshot as if an older Friday had written it.
    const { sha256: _old, ...body } = s;
    body.schema_version = 5;
    writeFileSync(
      snap.file,
      JSON.stringify({ ...body, sha256: createHash('sha256').update(stableStringify(body)).digest('hex') }),
    );
    expect(code(() => replayInto(state, PROJECT, path.join(ws().root, 'r'), { snapshotFile: snap.file }))).toMatch(
      /schema version 5/,
    );
  });
});

describe('backup', () => {
  it('copies the database consistently, the artifacts, and a manifest', () => {
    activity(1);
    const artifacts = path.join(ws().root, 'artifacts');
    mkdirSync(path.join(artifacts, 'check'), { recursive: true });
    writeFileSync(path.join(artifacts, 'check', 'out.txt'), 'output');
    const report = backupTo(state, PROJECT, path.join(ws().root, 'backup'), {
      artifactsDir: artifacts,
      fridayVersion: '0.1.0',
    });
    expect(report.files).toEqual(['project.db', 'artifacts/', 'manifest.json']);
    const copy = openDatabase(path.join(ws().root, 'backup', 'project.db'));
    expect(copy.prepare('SELECT MAX(sequence) AS s FROM events').get<{ s: number }>()?.s).toBe(
      state.store.head(PROJECT),
    );
    copy.close();
    expect(readFileSync(path.join(ws().root, 'backup', 'artifacts', 'check', 'out.txt'), 'utf8')).toBe('output');
    const manifest = JSON.parse(readFileSync(path.join(ws().root, 'backup', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ project_id: PROJECT, event_head: report.event_head, friday_version: '0.1.0' });
  });
});
