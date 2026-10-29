import { existsSync } from 'node:fs';
import path from 'node:path';
import { sequentialIds, systemClock } from '@friday/core';
import { migrate, openDatabase, type SqlDatabase } from '@friday/db';
import { type Actor, FridayError } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  ArtifactStore,
  EVENT_MIGRATIONS,
  EventStore,
  findCredentials,
  InProcessTransport,
  MAX_EVENT_PAYLOAD_BYTES,
  Redactor,
  type StoredEvent,
  truncateText,
} from './index.js';

const P1 = 'proj_00000000000000000000000001';
const P2 = 'proj_00000000000000000000000002';
const human: Actor = { kind: 'human', id: 'local' };

describe('EventStore', () => {
  const ws = useTestWorkspace();
  let db: SqlDatabase;
  const setup = () => {
    db = ws().track(openDatabase(ws().dbPath));
    migrate(db, EVENT_MIGRATIONS);
    return new EventStore(db, { ids: sequentialIds(), clock: systemClock });
  };

  it('assigns monotonic sequences per project, independently', () => {
    const store = setup();
    db.transaction(() => {
      for (let i = 0; i < 10_000; i += 1) {
        store.append({ type: 'test.tick', project_id: i % 3 === 0 ? P2 : P1, actor: human, payload: { i } });
      }
    });
    const p1 = store.readSince(P1, 0, { limit: 20_000 });
    const p2 = store.readSince(P2, 0, { limit: 20_000 });
    expect(p1.map((e) => e.sequence)).toEqual(Array.from({ length: p1.length }, (_, i) => i + 1));
    expect(p2.map((e) => e.sequence)).toEqual(Array.from({ length: p2.length }, (_, i) => i + 1));
    expect(p1.length + p2.length).toBe(10_000);
    expect(store.head(P1)).toBe(p1.length);
    expect(store.head('proj_unknown')).toBe(0);
  });

  it('leaves no event and no sequence gap when the enclosing transaction rolls back', () => {
    const store = setup();
    store.append({ type: 'a', project_id: P1, actor: human, payload: {} });
    expect(() =>
      db.transaction(() => {
        store.append({ type: 'b', project_id: P1, actor: human, payload: {} });
        throw new Error('command failed');
      }),
    ).toThrow('command failed');
    expect(store.head(P1)).toBe(1);
    const next = store.append({ type: 'c', project_id: P1, actor: human, payload: {} });
    expect(next.sequence).toBe(2);
  });

  it('stores the full envelope and reads it back by id, correlation and ref', () => {
    const store = setup();
    const e = store.append({
      type: 'task.created',
      project_id: P1,
      actor: human,
      payload: { summary: 'x' },
      correlation_id: 'corr_1',
      caused_by: ['evt_parent'],
      refs: [{ kind: 'task', id: 'task_1' }],
    });
    store.append({
      type: 'task.ready',
      project_id: P1,
      actor: human,
      payload: {},
      refs: [{ kind: 'task', id: 'task_1' }],
    });
    store.append({ type: 'other', project_id: P1, actor: human, payload: {} });
    expect(store.get(e.event_id)).toEqual(e);
    expect(e).toMatchObject({
      schema_version: 1,
      sensitivity: 'internal',
      redaction_status: 'none',
      caused_by: ['evt_parent'],
    });
    expect(store.readByCorrelation(P1, 'corr_1').map((x) => x.type)).toEqual(['task.created']);
    expect(store.readByRef(P1, 'task', 'task_1').map((x) => x.type)).toEqual(['task.created', 'task.ready']);
    expect(store.readByRef(P1, 'task', 'task_1', { types: ['task.ready'] })).toHaveLength(1);
  });

  it('filters by exact type and by prefix', () => {
    const store = setup();
    for (const type of ['task.created', 'task.harness_lost', 'run.created', 'taskish']) {
      store.append({ type, project_id: P1, actor: human, payload: {} });
    }
    expect(store.readSince(P1, 0, { types: ['task.*'] }).map((e) => e.type)).toEqual([
      'task.created',
      'task.harness_lost',
    ]);
    expect(store.readSince(P1, 0, { types: ['run.created', 'taskish'] })).toHaveLength(2);
    expect(store.readSince(P1, 2).map((e) => e.sequence)).toEqual([3, 4]);
  });

  it('redacts secrets before storing and raises sensitivity', () => {
    const store = setup();
    store.redactor.addSecret('daemon-operator-token-0123456789');
    const e = store.append({
      type: 'agent.event',
      project_id: P1,
      actor: { kind: 'agent', id: 'agent_1' },
      payload: {
        output: 'export ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
        nested: { header: 'Authorization: Bearer abcdef0123456789', aws: 'AKIAABCDEFGHIJKLMNOP' },
        token: 'whatever-value',
        echoed: 'token is daemon-operator-token-0123456789',
        harmless: 'all tests passed',
      },
    });
    const text = JSON.stringify(e.payload);
    expect(text).not.toContain('sk-ant-api03');
    expect(text).not.toContain('abcdef0123456789');
    expect(text).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(text).not.toContain('whatever-value');
    expect(text).not.toContain('daemon-operator-token-0123456789');
    expect(text).toContain('all tests passed');
    expect(e.redaction_status).toBe('redacted');
    expect(e.sensitivity).toBe('sensitive');
    const raw = db
      .prepare('SELECT payload_json FROM events WHERE event_id = ?')
      .get<{ payload_json: string }>(e.event_id);
    expect(raw?.payload_json).not.toContain('sk-ant-api03');
  });

  it('rejects oversized structured payloads with COS-1004 and writes nothing', () => {
    const store = setup();
    const before = store.head(P1);
    let thrown: unknown;
    try {
      store.append({
        type: 'big',
        project_id: P1,
        actor: human,
        payload: { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_BYTES) },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(FridayError);
    expect((thrown as FridayError).code).toBe('COS-1004');
    expect(store.head(P1)).toBe(before);
    expect(db.prepare('SELECT count(*) AS n FROM events').get<{ n: number }>()?.n).toBe(0);
  });

  it('appends fast enough (p50 < 10 ms per committed event)', () => {
    const store = setup();
    const times: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const t0 = performance.now();
      store.append({ type: 'perf', project_id: P1, actor: human, payload: { i, note: 'x'.repeat(200) } });
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    expect(times[100]).toBeLessThan(10);
  });
});

describe('InProcessTransport', () => {
  const ev = (type: string, project_id = P1) => ({ type, project_id }) as unknown as StoredEvent;

  it('delivers matching events and isolates failing subscribers', () => {
    const errors: unknown[] = [];
    const t = new InProcessTransport((e) => errors.push(e));
    const seen: string[] = [];
    t.subscribe({ types: ['task.*'] }, (e) => seen.push(`a:${e.type}`));
    t.subscribe({}, () => {
      throw new Error('bad subscriber');
    });
    const off = t.subscribe({ project_id: P2 }, (e) => seen.push(`p2:${e.type}`));
    t.publish([ev('task.created'), ev('run.created'), ev('task.ready', P2)]);
    expect(seen).toEqual(['a:task.created', 'a:task.ready', 'p2:task.ready']);
    expect(errors).toHaveLength(3);
    off();
    t.publish([ev('x', P2)]);
    expect(seen).toHaveLength(3);
  });
});

describe('ArtifactStore and helpers', () => {
  const ws = useTestWorkspace();

  it('stores redacted text with a checksum and reads it back', () => {
    const db = ws().track(openDatabase(ws().dbPath));
    migrate(db, EVENT_MIGRATIONS);
    const dir = path.join(ws().fridayDir, 'artifacts');
    const store = new ArtifactStore(db, dir, { ids: sequentialIds(), clock: systemClock, redactor: new Redactor() });
    const rec = store.storeText(P1, 'test-output', 'ok\npassword=hunter22\n');
    expect(existsSync(path.join(dir, rec.path))).toBe(true);
    expect(rec.path.startsWith('test-output/')).toBe(true);
    expect(store.readText(rec.artifact_id)).not.toContain('hunter22');
    expect(rec.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('truncateText marks what it dropped', () => {
    expect(truncateText('abc', 5)).toBe('abc');
    expect(truncateText('abcdefgh', 3)).toBe('abc…[truncated 5 chars]');
  });
});

describe('credentials in code (ADR-0024 §3)', () => {
  it('finds well-known credential formats by line, and ignores what only looks like a secret', () => {
    // Built from parts so the repository never holds a whole sample.
    const aws = `AKIA${'ABCDEFGHIJKLMNOP'}`;
    const anthropic = `sk-ant-${'api03-'}${'x'.repeat(24)}`;
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIB', '-----END RSA PRIVATE KEY-----'].join('\n');
    const text = [
      'const token = createToken();',
      `const aws = "${aws}";`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text that holds a template literal.
      'const auth = `Bearer ${session}`;',
      `const key = "${anthropic}";`,
      'const url = "https://user:password@example.com";',
      pem,
    ].join('\n');
    expect(findCredentials(text)).toEqual([
      { kind: 'aws_key', line: 2 },
      { kind: 'anthropic_key', line: 4 },
      { kind: 'private_key', line: 6 },
    ]);
    expect(findCredentials('export const a = 1;\n')).toEqual([]);
  });
});
