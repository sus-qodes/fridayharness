/**
 * Snapshots, isolated replay and backup (plan M3c, ADR-0018), with the M3.1 review fixes:
 * relocatable snapshots (R06), the backup boundary (R07), inspection copies (R08) and
 * maintenance that leaves the event loop running (R09).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, FridayError, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  backupTo,
  createSnapshot,
  FridayState,
  isInspectionCopy,
  listSnapshots,
  replayInto,
  stableStringify,
} from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const ws = useTestWorkspace();

let db: SqlDatabase;
let state: FridayState;
let clock: FakeClock;
let artifacts: string;

beforeEach(() => {
  db = openDatabase(path.join(ws().root, 'live.db'));
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  artifacts = path.join(ws().root, 'artifacts');
  state = new FridayState({ db, clock, ids: sequentialIds(), artifactsDir: artifacts });
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

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    return (e as FridayError).message;
  }
  throw new Error('expected an error');
}

/** Rewrites a snapshot's lines and signs it again, as another Friday build could have. */
function resign(file: string, change: (lines: Record<string, unknown>[]) => void): void {
  const lines = readFileSync(file, 'utf8')
    .trimEnd()
    .split('\n')
    .slice(0, -1)
    .map((l) => JSON.parse(l));
  change(lines);
  const body = lines.map((l) => `${stableStringify(l)}\n`).join('');
  writeFileSync(file, `${body}${JSON.stringify({ sha256: createHash('sha256').update(body).digest('hex') })}\n`);
}

describe('snapshots and replay', () => {
  it('rebuilds the same state from snapshot plus tail as from the full log, in an isolated copy', async () => {
    activity(1);
    activity(2);
    const snap = await createSnapshot(state, PROJECT);
    expect(snap.up_to_sequence).toBe(state.store.head(PROJECT));
    expect(snap.tables.tasks).toBe(2);
    expect(snap.state_ref).toBe(`snapshots/${snap.snapshot_id}.jsonl`);
    expect(snap.file).toBe(path.join(artifacts, 'snapshots', `${snap.snapshot_id}.jsonl`));
    // The same head gives the same snapshot.
    expect((await createSnapshot(state, PROJECT)).snapshot_id).toBe(snap.snapshot_id);
    activity(3);
    clock.advance(1000);
    activity(4);

    let published = 0;
    state.transport.subscribe({ project_id: PROJECT }, () => {
      published += 1;
    });
    const liveHead = state.store.head(PROJECT);
    const full = await replayInto(state, PROJECT, path.join(ws().root, 'full'));
    const tail = await replayInto(state, PROJECT, path.join(ws().root, 'tail'), { snapshotFile: snap.file });
    expect(full).toMatchObject({ equal: true, from_snapshot: null, up_to_sequence: liveHead });
    expect(tail).toMatchObject({ equal: true, from_snapshot: snap.snapshot_id });
    expect(tail.events_applied).toBe(liveHead - snap.up_to_sequence);
    expect(full.events_applied).toBe(liveHead);
    // Replay acts on nothing: no event published, the live log unchanged, no credential in the copy.
    expect(published).toBe(0);
    expect(state.store.head(PROJECT)).toBe(liveHead);
    const copy = openDatabase(path.join(ws().root, 'tail', 'project.db'));
    expect(copy.prepare('SELECT COUNT(*) AS n FROM credentials').get<{ n: number }>()?.n).toBe(0);
    expect(isInspectionCopy(copy)).toBe(true);
    copy.close();
    expect(listSnapshots(state, PROJECT)).toMatchObject([{ snapshot_id: snap.snapshot_id, present: true }]);
  });

  it('refuses corrupt, interrupted, foreign, old-format and old-schema snapshots, and a used destination', async () => {
    activity(1);
    const snap = await createSnapshot(state, PROJECT);
    const into = (name: string) => path.join(ws().root, name);
    const original = readFileSync(snap.file, 'utf8');
    const replayFrom = (name: string) => replayInto(state, PROJECT, into(name), { snapshotFile: snap.file });

    writeFileSync(snap.file, original.replace('"summary":"task 1"', '"summary":"tampered"'));
    expect(await refusal(replayFrom('r1'))).toMatch(/corrupt/);
    writeFileSync(snap.file, original.slice(0, original.length / 2));
    expect(await refusal(replayFrom('r2'))).toMatch(/interrupted write/);
    writeFileSync(snap.file, original);
    resign(snap.file, (lines) => {
      (lines[0] as Record<string, unknown>).schema_version = 5;
    });
    expect(await refusal(replayFrom('r3'))).toMatch(/schema version 5/);
    writeFileSync(snap.file, original);
    resign(snap.file, (lines) => {
      (lines[0] as Record<string, unknown>).format_version = 1;
    });
    expect(await refusal(replayFrom('r4'))).toMatch(/format 1.*Take a new snapshot/);
    writeFileSync(snap.file, original);
    const other = new FridayState({ db: openDatabase(path.join(ws().root, 'other.db')), clock, ids: sequentialIds() });
    other.ensureProject({ project_id: 'proj_00000000000000000000000002', name: 'other', root_path: 'C:/other' });
    expect(
      await refusal(replayInto(other, 'proj_00000000000000000000000002', into('r5'), { snapshotFile: snap.file })),
    ).toMatch(/belongs to project/);
    other.db.close();
    await replayInto(state, PROJECT, into('r6'));
    expect(await refusal(replayInto(state, PROJECT, into('r6')))).toMatch(/not empty/);
  });

  it('never runs Friday on an inspection copy (R08)', async () => {
    activity(1);
    await replayInto(state, PROJECT, path.join(ws().root, 'inspect'));
    const copy = openDatabase(path.join(ws().root, 'inspect', 'project.db'));
    ws().track({ close: () => copy.close() });
    expect(() => new FridayState({ db: copy, clock, ids: sequentialIds() })).toThrow(/inspection copy/);
    // Analysis can still open it on purpose.
    expect(new FridayState({ db: copy, clock, ids: sequentialIds(), inspection: true }).q.tasks(PROJECT)).toHaveLength(
      1,
    );
  });

  it('finds and replays snapshots after the backup is moved and the old root is gone (R06)', async () => {
    activity(1);
    activity(2);
    const snap = await createSnapshot(state, PROJECT);
    activity(3);
    const moved = path.join(ws().root, 'elsewhere');
    await backupTo(state, PROJECT, path.join(ws().root, 'backup'));
    cpSync(path.join(ws().root, 'backup'), moved, { recursive: true });
    db.close();
    rmSync(path.join(ws().root, 'backup'), { recursive: true });
    rmSync(artifacts, { recursive: true });
    rmSync(path.join(ws().root, 'live.db'), { force: true });

    db = openDatabase(path.join(moved, 'project.db'));
    state = new FridayState({ db, clock, ids: sequentialIds(), artifactsDir: path.join(moved, 'artifacts') });
    const [listed] = listSnapshots(state, PROJECT);
    expect(listed).toMatchObject({
      snapshot_id: snap.snapshot_id,
      state_ref: snap.state_ref,
      file: path.join(moved, 'artifacts', 'snapshots', `${snap.snapshot_id}.jsonl`),
      present: true,
    });
    const report = await replayInto(state, PROJECT, path.join(ws().root, 'r'), {
      snapshotFile: listed?.file as string,
    });
    expect(report).toMatchObject({ equal: true, from_snapshot: snap.snapshot_id });
  });

  it('resolves an absolute reference of an M3c build by its file name, and nothing outside snapshots/', async () => {
    activity(1);
    const snap = await createSnapshot(state, PROJECT);
    db.prepare('UPDATE event_snapshots SET state_ref = ?').run(
      path.join('C:', 'old', 'root', `${snap.snapshot_id}.jsonl`),
    );
    expect(listSnapshots(state, PROJECT)[0]).toMatchObject({ file: snap.file, present: true });
    db.prepare('UPDATE event_snapshots SET state_ref = ?').run('../../live.db');
    expect(listSnapshots(state, PROJECT)[0]).toMatchObject({ file: null, present: false });
  });
});

describe('backup', () => {
  it('copies the database without credentials, every artifact with its hash, and a manifest read from the copy', async () => {
    activity(1);
    const stored = state.artifacts?.storeText(PROJECT, 'check', 'output');
    const head = state.store.head(PROJECT);
    const report = await backupTo(state, PROJECT, path.join(ws().root, 'backup'), { fridayVersion: '0.1.0' });
    expect(report).toMatchObject({
      files: ['project.db', 'artifacts/', 'manifest.json'],
      event_head: head,
      artifacts: { files: 1 },
      skipped: [],
      problems: [],
    });
    const copy = openDatabase(path.join(ws().root, 'backup', 'project.db'));
    expect(copy.prepare('SELECT MAX(sequence) AS s FROM events').get<{ s: number }>()?.s).toBe(head);
    expect(copy.prepare('SELECT COUNT(*) AS n FROM credentials').get<{ n: number }>()?.n).toBe(0);
    copy.close();
    expect(state.db.prepare('SELECT COUNT(*) AS n FROM credentials').get<{ n: number }>()?.n).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(path.join(ws().root, 'backup', 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      format: 'friday-backup',
      format_version: 2,
      project_id: PROJECT,
      event_head: head,
      friday_version: '0.1.0',
      artifacts: [{ path: stored?.path, bytes: 6, sha256: stored?.sha256 }],
      // The state alone writes no code; the daemon adds it (review F16).
      code: { included: false },
    });
    // Nothing but the backup is left next to it.
    expect(readdirSync(ws().root).filter((n) => n.includes('incomplete'))).toEqual([]);
  });

  it('skips links, reports artifacts the database references but the folder lacks, and leaves nothing on failure (R07)', async () => {
    activity(1);
    const kept = state.artifacts?.storeText(PROJECT, 'check', 'kept');
    const lost = state.artifacts?.storeText(PROJECT, 'check', 'lost');
    rmSync(path.join(artifacts, lost?.path as string));
    writeFileSync(path.join(artifacts, 'check', 'x.jsonl.123.tmp'), 'half');
    const outside = path.join(ws().root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'not for backups');
    symlinkSync(outside, path.join(artifacts, 'link'), 'junction');

    const report = await backupTo(state, PROJECT, path.join(ws().root, 'b1'));
    expect(report.artifacts.files).toBe(1);
    expect(report.skipped.map((s) => s.path).sort()).toEqual(['check/x.jsonl.123.tmp', 'link']);
    expect(report.problems).toEqual([{ artifact_id: lost?.artifact_id, path: lost?.path, problem: 'missing' }]);
    expect(existsSync(path.join(ws().root, 'b1', 'artifacts', kept?.path as string))).toBe(true);
    expect(existsSync(path.join(ws().root, 'b1', 'artifacts', 'link'))).toBe(false);

    // A failing copy leaves neither the destination nor a staging folder.
    const realCopy = state.db.backup.bind(state.db);
    (state.db as { backup: (t: string) => Promise<void> }).backup = async () => {
      throw new Error('disk full');
    };
    await expect(backupTo(state, PROJECT, path.join(ws().root, 'b2'))).rejects.toThrow('disk full');
    (state.db as { backup: (t: string) => Promise<void> }).backup = realCopy;
    expect(existsSync(path.join(ws().root, 'b2'))).toBe(false);
    expect(readdirSync(ws().root).filter((n) => n.includes('incomplete'))).toEqual([]);
  });
});

describe('leases after Friday was stopped or paused (R09)', () => {
  const register = (key: string) =>
    state.registerHarness(
      PROJECT,
      HarnessRegisterParams.parse({
        protocol_version: '1.0',
        harness_key: `fake:${key}`,
        vendor: 'generic',
        name: key,
        attach_mode: 'spawn',
        project_id: PROJECT,
        capabilities: { task_start: true },
        agent: { agent_key: key, role: 'backend' },
      }),
    );
  const statusOf = (id: string) => state.q.harness(id).status;

  it('gives sessions that could not report one lease to do so, and judges everything else as usual', () => {
    const quiet = register('quiet');
    const back = register('back');
    // Friday was down (or asleep) for longer than a lease.
    clock.advance(state.config.leaseTtlMs * 3);
    const hold = state.holdLeaseJudgement(PROJECT);
    expect(state.tick(PROJECT).lost).toEqual([]);
    // A session registered after the pause is judged normally.
    const fresh = register('fresh');
    clock.advance(state.config.leaseTtlMs / 2);
    state.heartbeat(PROJECT, back.harness_id);
    expect(state.tick(PROJECT)).toMatchObject({ lost: [], degraded: [] });
    // The hold ends after one lease: the one that came back stays, the quiet one is lost.
    clock.advance(state.config.leaseTtlMs / 2 + 1);
    expect(clock.now() > hold.until).toBe(true);
    state.heartbeat(PROJECT, fresh.harness_id);
    expect(state.tick(PROJECT).lost).toEqual([quiet.harness_id]);
    expect([statusOf(back.harness_id), statusOf(fresh.harness_id)]).not.toContain('DISCONNECTED');
  });
});

describe('maintenance and the event loop (R09)', () => {
  it('lets timers run while a replay and a backup work, and runs one job at a time', async () => {
    for (let n = 0; n < 150; n++) activity(n);
    let ticks = 0;
    const probe = setInterval(() => {
      ticks += 1;
    }, 1);
    try {
      const replay = replayInto(state, PROJECT, path.join(ws().root, 'r'));
      expect(await refusal(backupTo(state, PROJECT, path.join(ws().root, 'b')))).toMatch(/a replay is running/);
      expect((await replay).equal).toBe(true);
      const duringReplay = ticks;
      expect(duringReplay).toBeGreaterThan(1);
      await backupTo(state, PROJECT, path.join(ws().root, 'b'));
      expect(ticks).toBeGreaterThan(duringReplay);
    } finally {
      clearInterval(probe);
    }
  });
});
