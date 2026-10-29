import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { UI_API_VERSION } from '@friday/daemon';
import type { UiSnapshot } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { UI_API } from '../../apps/ui/src/shell/version.js';
import { startTestDaemon } from '../helpers/daemon.js';
import { attachedSession, raw, signIn } from '../helpers/ui.js';

/** The board snapshot (docs/frontend/PLAN.md §5.3, FD-08). */

const ws = useTestWorkspace();

describe('the board snapshot', () => {
  it('holds the board at the event head, with what the interface needs about the daemon', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, client, run_id } = await attachedSession(td);
    await client.update({
      task_id: task.task_id,
      run_id,
      status: 'waiting',
      waiting_reason: 'blocked',
      note: 'need the API key name',
    });
    const token = await signIn(td);
    const snap = (await raw(td, 'GET', td.operator.projectPath('/ui/snapshot'), { token }))
      .json as unknown as UiSnapshot;
    const head = (await td.operator.get<{ head: number }>(td.operator.projectPath('/events?limit=1'))).head;
    expect(snap.head).toBe(head);
    expect(snap.ui_api).toBe(UI_API_VERSION);
    expect(snap.project).toMatchObject({ has_commit: true, worktrees_mode: 'per_task' });
    expect(snap.config.loaded_hash).toBe(snap.config.current_hash);
    expect(snap.verification).toEqual({ checks: [], auto_on_completion: false });
    const t = snap.tasks.find((x) => x.task_id === task.task_id);
    expect(t).toMatchObject({ status: 'WAITING', agent_key: 'dev-1', waiting_note: 'need the API key name' });
    expect(snap.runs[task.task_id]?.base_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.agents.map((a) => a.agent_key)).toContain('dev-1');
    expect(snap.harnesses[0]).toHaveProperty('observed_model');
    expect(snap.control.paused).toBe(false);
    expect(snap.brain_jobs).toEqual([]);
    expect(snap.truncated).toEqual({});
  });

  it('speaks the API version the page was built for', () => {
    expect(UI_API).toBe(UI_API_VERSION);
  });

  it('says when config.yaml changed since Friday started', async () => {
    const td = await startTestDaemon(ws());
    appendFileSync(path.join(ws().fridayDir, 'config.yaml'), '\n# edited\n');
    const snap = await td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));
    expect(snap.config.current_hash).not.toBe(snap.config.loaded_hash);
  });

  it('carries inbox previews, not bodies, and why a READY task waits', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { client, task } = await attachedSession(td);
    await client.communicate({
      to: 'human',
      mode: 'notification',
      subject: 'long',
      content: `start ${'x'.repeat(5000)}`,
      task_id: task.task_id,
    });
    const loose = await td.operator.post<{ task_id: string }>(td.operator.projectPath('/tasks'), {
      summary: 'nobody can take this',
      kind: 'docs',
      scope: { write: ['**'], read: [] },
      ready: true,
    });
    await td.operator.post(td.operator.projectPath('/brain/run-once'), {});
    const snap = await td.operator.get<UiSnapshot>(td.operator.projectPath('/ui/snapshot'));
    const item = snap.inbox[0] as unknown as Record<string, unknown>;
    expect(item).not.toHaveProperty('body');
    expect(String(item.preview).length).toBe(200);
    const ready = snap.tasks.find((t) => t.task_id === loose.task_id);
    expect(ready?.status).toBe('READY');
    expect(typeof ready?.delegation_note === 'string' || ready?.delegation_note === null).toBe(true);
  });
});
