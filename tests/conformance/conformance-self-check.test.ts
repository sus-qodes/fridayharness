/**
 * The conformance suite must catch a host that ignores cancellation (M3.5): Codex 0.162.1 marks
 * an interrupted turn as interrupted while the command it started keeps running. A harness that
 * behaves like that keeps doing work after `task.cancel`, which case 9 measures.
 */
import type { TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

it('a harness that ignores cancellation keeps working after task.cancel, which case 9 detects', async () => {
  const td = await startTestDaemon(ws());
  const h = await FakeHarness.connect(td, { mode: 'spawn', ignoreCancel: true });
  ws().track({ close: () => h.close() });
  const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), { summary: 'stubborn', ready: true });
  await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'dev-1' });
  await h.waitFor('task.start');
  await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/cancel`), { reason: 'not needed' });
  await h.waitFor('task.cancel');
  // Friday's records say CANCELLED, yet the host is still working: the gap case 9 closes.
  const task = await td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${t.task_id}`));
  expect(task.task.status).toBe('CANCELLED');
  await sleep(100);
  const settled = h.workDone(t.task_id);
  await sleep(200);
  expect(h.workDone(t.task_id)).toBeGreaterThan(settled);
});
