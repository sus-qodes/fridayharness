/**
 * Splitting a multi-role proposal (ADR-0035 §5; plan Phase 2.3): a human approves the classifier's
 * proposed DAG by turning the task into one linked task per role.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_TABLES, FridayState } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const classifier: Actor = { kind: 'system', id: 'role-classifier' };

let db: SqlDatabase;
let state: FridayState;

beforeEach(() => {
  db = openDatabase(':memory:');
  state = new FridayState({ db, clock: new FakeClock('2026-10-22T10:00:00.000Z'), ids: sequentialIds() });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
});

/** A task whose paths point at two roles, with the classifier's proposed split stored on it. */
function proposed(extra: { ready?: boolean } = {}) {
  const task = state.createTask(PROJECT, human, {
    summary: 'Split the checkout work',
    description: 'The page and its API.',
    acceptance_criteria: ['the page renders', 'the API answers'],
    priority: 'high',
    risk_level: 'medium',
    scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: ['docs/**'] },
    ready: extra.ready ?? true,
  });
  expect(task).toMatchObject({ role: null, role_source: 'missing' });
  state.recordTaskRoleDecision(PROJECT, classifier, task.task_id, {
    status: 'classified',
    assumptions: ['the page and the API can ship together'],
    roles: [
      { role: 'frontend_engineer', task_summary: 'Build the page', depends_on: [], confidence: 0.9 },
      // A positional label from the model: the parser rewrites it to the role's key (review R6).
      { role: 'backend_engineer', task_summary: 'Build the API', depends_on: ['role-1'], confidence: 0.85 },
    ],
  });
  expect(state.q.latestTaskRoleDecision(PROJECT, task.task_id)?.status).toBe('proposed');
  return state.q.task(PROJECT, task.task_id);
}

describe('splitting a multi-role proposal (ADR-0035 §5)', () => {
  it('makes one linked task per role, in order, with the human as the role source, and cancels the original', () => {
    const original = proposed();
    const dependent = state.createTask(PROJECT, human, {
      summary: 'Announce the checkout',
      depends_on: [original.task_id],
      scope: { write: ['docs/**'], read: [] },
    });
    const r = state.splitTask(PROJECT, human, original.task_id, 'ship both');
    expect(r.plan).toBeNull();
    expect(r.original).toMatchObject({ task_id: original.task_id, status: 'CANCELLED' });
    const [page, api] = r.subtasks;
    expect(r.subtasks).toHaveLength(2);
    expect(page).toMatchObject({
      role: 'frontend_engineer',
      role_source: 'human',
      summary: 'Build the page',
      description: `Split from ${original.task_id} (Split the checkout work).\n\nThe page and its API.`,
      kind: 'implementation',
      acceptance_criteria: ['the page renders', 'the API answers'],
      priority: 'high',
      risk_level: 'medium',
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: ['docs/**'] },
      dependencies: [],
      // The original was READY: so is the part nothing else waits for.
      status: 'READY',
      goal_id: null,
    });
    expect(api).toMatchObject({
      role: 'backend_engineer',
      role_source: 'human',
      summary: 'Build the API',
      dependencies: [page?.task_id],
      status: 'PROPOSED',
    });
    // Each part's role contract is the human's: the classifier is never asked again.
    expect(state.q.latestTaskRoleDecision(PROJECT, page?.task_id as string)).toMatchObject({
      status: 'resolved',
      source: 'human',
      role: 'frontend_engineer',
    });
    // Whatever depended on the original now depends on the split's last part.
    expect(state.q.task(PROJECT, dependent.task_id).dependencies).toEqual([api?.task_id]);
    expect(state.q.openDependencies(dependent.task_id)).toEqual([api?.task_id]);
    // The record: the cancellation names the parts, and the split names the proposal it approved.
    const events = state.store.readByRef(PROJECT, 'task', original.task_id);
    const cancelled = events.find((e) => e.type === 'task.cancelled');
    expect((cancelled?.payload as { transition?: { reason?: string } })?.transition?.reason).toBe(
      `split into ${page?.task_id}, ${api?.task_id}`,
    );
    expect(events.at(-1)).toMatchObject({
      type: 'task.split',
      payload: {
        task_id: original.task_id,
        decision_id: original.role_decision_id,
        subtasks: [page?.task_id, api?.task_id],
        plan: null,
      },
    });
    // A split task is not split again.
    expect(() => state.splitTask(PROJECT, human, original.task_id)).toThrow(/is CANCELLED/);
  });

  it('keeps the parts PROPOSED when the original was, and refuses what is not a waiting proposal', () => {
    const original = proposed({ ready: false });
    const r = state.splitTask(PROJECT, human, original.task_id);
    expect(r.subtasks.map((t) => t.status)).toEqual(['PROPOSED', 'PROPOSED']);
    expect(state.readyTask(PROJECT, human, r.subtasks[0]?.task_id as string).status).toBe('READY');

    const plain = state.createTask(PROJECT, human, { summary: 'Fix one file', role: 'backend' });
    expect(() => state.splitTask(PROJECT, human, plain.task_id)).toThrow(/no multi-role proposal waits/);
    expect(() => state.splitTask(PROJECT, { kind: 'agent', id: 'x' }, plain.task_id)).toThrow(FridayError);
    expect(() => state.splitTask(PROJECT, { kind: 'agent', id: 'x' }, plain.task_id)).toThrow(/only a human splits/);
  });

  it('is rebuilt by replay as it was', () => {
    const original = proposed();
    state.createTask(PROJECT, human, { summary: 'After', depends_on: [original.task_id] });
    state.splitTask(PROJECT, human, original.task_id);
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((tb) => [tb, db.prepare(`SELECT * FROM ${tb} ORDER BY 1, 2`).all()]));
    const deps = () => db.prepare('SELECT * FROM task_dependencies ORDER BY task_id, depends_on_task_id').all();
    const before = { ...dump(), task_dependencies: deps() };
    replay(db, state.store, PROJECT, state.projector);
    expect({ ...dump(), task_dependencies: deps() }).toEqual(before);
  });
});
