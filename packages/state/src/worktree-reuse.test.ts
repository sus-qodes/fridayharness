import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type DriverName, openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, HarnessRegisterParams } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { DOMAIN_TABLES, FridayState } from './index.js';

const PROJECT = 'proj_worktree_reuse';
const human: Actor = { kind: 'human', id: 'operator' };

describe.each<DriverName>(['better-sqlite3', 'node:sqlite'])('worktree reactivation (%s)', (driver) => {
  const ws = useTestWorkspace();
  let db: SqlDatabase;
  let state: FridayState;
  beforeEach(() => {
    db = ws().track(openDatabase(ws().dbPath, { driver }));
    state = new FridayState({
      db,
      clock: new FakeClock(),
      config: {
        worktreeMode: 'per_task',
        worktreeRoot: path.join(ws().root, 'worktrees'),
      },
    });
    state.ensureProject({ project_id: PROJECT, name: 'reuse', root_path: ws().projectDir });
  });

  it.each(['assignment', 'workspace ready'])(
    'reactivates a preserved worktree during %s and keeps reservations until integration',
    (phase) => {
      const goal = state.createGoal(PROJECT, human, { request: 'Ship preserved work', plan: false });
      const plan = state.proposePlan(PROJECT, human, goal.goal_id, {
        summary: 'One backend task',
        rationale: '',
        needs_human: null,
        trigger: 'test',
        tasks: [
          {
            key: 'backend',
            change: 'new',
            task_id: null,
            kind: 'implementation',
            summary: 'Finish backend work',
            description: null,
            acceptance_criteria: ['done'],
            depends_on: [],
            scope: { write: ['src/**'], read: [] },
            role: 'backend',
            priority: 'normal',
            risk_level: 'low',
            note: null,
          },
        ],
      });
      const task = state.approvePlan(PROJECT, human, plan.plan_id, plan.version).created[0];
      if (!task) throw new Error('No task materialized');
      const caller = state.registerHarness(
        PROJECT,
        HarnessRegisterParams.parse({
          protocol_version: '1.0',
          project_id: PROJECT,
          harness_key: 'spawn-reuse',
          vendor: 'codex',
          name: 'reuse',
          attach_mode: 'spawn',
          capabilities: { task_start: true },
          agent: { agent_key: 'backend-1', role: 'backend' },
        }),
      );
      const alloc = {
        path: path.join(ws().root, 'worktrees', 'task'),
        branch: `friday/${task.task_id}`,
        base_commit: 'a'.repeat(40),
        warnings: [],
      };
      if (phase === 'assignment') mkdirSync(alloc.path, { recursive: true });
      const tree = state.recordWorktree(PROJECT, human, task.task_id, alloc);
      state.releaseWorktree(PROJECT, human, tree.worktree_id, 'preserved', 'keep the uncommitted work');
      expect(state.q.worktreeForTask(task.task_id)?.status).toBe('preserved');
      state.assignTask(PROJECT, human, task.task_id, 'backend-1');
      const runId = state.q.task(PROJECT, task.task_id).current_run_id;
      if (!runId) throw new Error('No run created');
      if (phase === 'workspace ready') {
        expect(state.q.run(runId).workspace).toBe('pending');
        mkdirSync(alloc.path, { recursive: true });
        state.workspaceReady(PROJECT, runId, { ...alloc, created: false });
      }
      expect(state.q.worktreeForTask(task.task_id)).toMatchObject({ worktree_id: tree.worktree_id, status: 'active' });
      expect(state.q.worktreeAt(PROJECT, alloc.path)?.worktree_id).toBe(tree.worktree_id);
      expect(state.q.run(runId)).toMatchObject({ workspace: 'ready', execution_root: alloc.path });
      const start = state.pollOutbox(PROJECT, caller.harness_id).find((message) => message.method === 'task.start');
      if (!start) throw new Error('No task.start queued');
      state.ackOutbox(PROJECT, caller.harness_id, [
        { message_id: start.message_id, accepted: true, session_ref: 'reused' },
      ]);
      state.reserveFiles(PROJECT, human, task.task_id, ['src/shared.ts'], 'write', (a, b) => a === b);
      state.submitResult(PROJECT, caller, {
        idempotency_key: 'claim-reused',
        task_id: task.task_id,
        run_id: runId,
        status: 'completed_claim',
        summary: 'finished',
        changed_paths: ['src/shared.ts'],
        checks: [],
        notes: [],
        risks: [],
      });
      const verification = state.startVerification(PROJECT, human, task.task_id);
      state.finishVerification(PROJECT, human, verification.verification_id, true, 'passed');
      expect(state.q.task(PROJECT, task.task_id).status).toBe('COMPLETED');
      expect(state.awaitsIntegration(state.q.task(PROJECT, task.task_id))).toBe(true);
      expect(state.integratedWork(PROJECT, task.task_id)).toBe(false);
      expect(state.q.fileReservations(PROJECT, ['active'])).toHaveLength(1);
      const dump = () =>
        Object.fromEntries(DOMAIN_TABLES.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
      const before = dump();
      replay(db, state.store, PROJECT, state.projector);
      expect(dump()).toEqual(before);
      expect(state.q.worktreeForTask(task.task_id)?.status).toBe('active');
      expect(state.q.fileReservations(PROJECT, ['active'])).toHaveLength(1);
    },
  );
});
