import { claudeCodeHooks } from '@friday/adapter-claude';
import type { ContinueResult, EscalationView, TaskView } from '@friday/protocol';
import { FakeClock, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { attachedSession, NO_WORKTREES, nextMessage, noMessage, raw, spawnedSession } from '../helpers/ui.js';

/**
 * Spawned agents carry on after a human decides (docs/frontend/PLAN.md §5.6, FD-22), denials reach
 * the agent, and Friday's own questions settle when their cause is resolved (§5.7, FD-21).
 */

const ws = useTestWorkspace();

const taskOf = async (td: TestDaemon, id: string) =>
  (await td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${id}`))).task;

/** The spawned agent asks for a commit, Friday says a human decides, and it ends its turn blocked. */
async function blockedOnApproval(td: TestDaemon) {
  const s = await spawnedSession(td, { hooks: true });
  const asked = await s.client.requestPermission({
    task_id: s.task.task_id,
    run_id: s.run_id,
    action_class: 'git.mutate',
    command: 'git commit -m "docs"',
    justification: 'commit the docs',
  });
  const approvalId = (asked as { approval_id: string | null }).approval_id as string;
  expect(approvalId).toMatch(/^apr_/);
  await s.client.reportResult({
    task_id: s.task.task_id,
    run_id: s.run_id,
    status: 'blocked',
    summary: 'waiting for the commit approval',
    blocked_reason: `needs ${approvalId}`,
    changed_paths: [],
    checks: [],
    notes: [],
  });
  const t = await taskOf(td, s.task.task_id);
  expect(t).toMatchObject({ status: 'WAITING', waiting_reason: 'blocked' });
  return { ...s, approvalId };
}

describe('a spawned agent after an approval decision', () => {
  it('continues in the same run and session when the request is granted', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const s = await blockedOnApproval(td);
    await td.operator.post(td.operator.projectPath(`/approvals/${s.approvalId}/approve`), { reuse: 'once', via: 'ui' });
    const resume = await nextMessage(s.client, 'task.resume');
    const p = resume.params as { run_id: string; session_ref: string | null; note: string | null };
    expect(p.run_id).toBe(s.run_id);
    expect(p.session_ref).toBe('sess-sp-1');
    expect(p.note).toContain('granted');
    const acked = await s.client.ack([{ message_id: resume.message_id, accepted: true, session_ref: 'sess-sp-1' }]);
    expect(acked.current).toContain(resume.message_id);
    const t = await taskOf(td, s.task.task_id);
    expect(t.status).toBe('RUNNING');
    expect(t.current_run_id).toBe(s.run_id);
  });

  it('continues with the denial, whose reason also reaches the agent as a message', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const s = await blockedOnApproval(td);
    await td.operator.post(td.operator.projectPath(`/approvals/${s.approvalId}/reject`), {
      via: 'ui',
      note: 'do not commit yet; leave it uncommitted',
    });
    const resume = await nextMessage(s.client, 'task.resume');
    const note = (resume.params as { note: string }).note;
    expect(note).toContain('denied');
    expect(note).toContain('do not commit yet');
    const inbox = await s.client.call('message.inbox', { wait_ms: 0, max: 10 });
    const items = (inbox as { items: { subject: string | null; body: string }[] }).items;
    expect(items.some((i) => i.subject === 'Request denied' && i.body.includes('do not commit yet'))).toBe(true);
  });
});

describe('an attached agent after a denial', () => {
  it('gets the reason in its inbox and its task runs again', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const a = await attachedSession(td);
    const asked = await a.client.requestPermission({
      task_id: a.task.task_id,
      run_id: a.run_id,
      action_class: 'git.mutate',
      command: 'git push',
      justification: 'publish',
    });
    const approvalId = (asked as { approval_id: string }).approval_id;
    await a.client.update({
      task_id: a.task.task_id,
      run_id: a.run_id,
      status: 'waiting',
      waiting_reason: 'human_approval',
      note: 'waiting',
    });
    expect((await taskOf(td, a.task.task_id)).waiting_reason).toBe('human_approval');
    await td.operator.post(td.operator.projectPath(`/approvals/${approvalId}/reject`), {
      via: 'ui',
      note: 'no pushing',
    });
    expect((await taskOf(td, a.task.task_id)).status).toBe('RUNNING');
    const inbox = await a.client.call('message.inbox', { wait_ms: 0, max: 10 });
    const items = (inbox as { items: { body: string }[] }).items;
    expect(items.some((i) => i.body.includes('no pushing'))).toBe(true);
  });
});

describe('Continue and resume', () => {
  it('continues a spawned task that blocked while Friday was paused, once Friday resumes', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const s = await spawnedSession(td, { hooks: true });
    await raw(td, 'POST', td.operator.projectPath('/control/pause'), { token: td.daemon.tokens.operator, body: '{}' });
    await s.client.reportResult({
      task_id: s.task.task_id,
      run_id: s.run_id,
      status: 'blocked',
      summary: 'my tool calls are refused: Friday is paused',
      changed_paths: [],
      checks: [],
      notes: [],
    });
    await raw(td, 'POST', td.operator.projectPath('/control/resume'), { token: td.daemon.tokens.operator, body: '{}' });
    const resume = await nextMessage(s.client, 'task.resume');
    expect((resume.params as { note: string }).note).toContain('Friday was paused and runs again');
  });

  it('lets a human answer and continue a spawned task, and says when an attached one must be asked in its editor', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()], extraConfig: NO_WORKTREES });
    const s = await spawnedSession(td, { hooks: true });
    await s.client.reportResult({
      task_id: s.task.task_id,
      run_id: s.run_id,
      status: 'blocked',
      summary: 'which title?',
      blocked_reason: 'Which title should the page use?',
      changed_paths: [],
      checks: [],
      notes: [],
    });
    const snap = await td.operator.get<{ tasks: { task_id: string; waiting_note: string | null }[] }>(
      td.operator.projectPath('/ui/snapshot'),
    );
    expect(snap.tasks.find((t) => t.task_id === s.task.task_id)?.waiting_note).toBe('Which title should the page use?');
    const r = await td.operator.post<ContinueResult>(td.operator.projectPath(`/tasks/${s.task.task_id}/continue`), {
      note: 'Use "Plans and pricing"',
    });
    expect(r.continued).toBe(true);
    const resume = await nextMessage(s.client, 'task.resume');
    expect((resume.params as { note: string }).note).toContain('Plans and pricing');

    const a = await attachedSession(td, { agentKey: 'dev-2', pid: 8302, sessionId: 'sess-ui-2' });
    await a.client.update({
      task_id: a.task.task_id,
      run_id: a.run_id,
      status: 'waiting',
      waiting_reason: 'blocked',
      note: 'stuck',
    });
    const att = await td.operator.post<ContinueResult>(td.operator.projectPath(`/tasks/${a.task.task_id}/continue`), {
      note: 'go on',
    });
    expect(att.continued).toBe(false);
    expect(att.reason).toContain('editor');
  });
});

describe("an agent's own question", () => {
  it('continues the spawned agent that waited for the answer, with the answer', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const s = await spawnedSession(td, { hooks: true });
    const asked = (await s.client.escalate({
      task_id: s.task.task_id,
      run_id: s.run_id,
      question: 'Which currency should prices use?',
      options: ['EUR', 'USD'],
    })) as { escalation_id: string };
    await s.client.reportResult({
      task_id: s.task.task_id,
      run_id: s.run_id,
      status: 'blocked',
      summary: 'waiting for the answer',
      blocked_reason: `needs ${asked.escalation_id}`,
      changed_paths: [],
      checks: [],
      notes: [],
    });
    await td.operator.post(td.operator.projectPath(`/escalations/${asked.escalation_id}/answer`), { answer: 'EUR' });
    const resume = await nextMessage(s.client, 'task.resume');
    expect((resume.params as { note: string }).note).toContain('EUR');
  });

  it('does not restart a later run when a question of an earlier run is answered (review M9i)', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const s = await spawnedSession(td, { hooks: true });
    const asked = (await s.client.escalate({
      task_id: s.task.task_id,
      run_id: s.run_id,
      question: 'EUR or USD?',
      options: ['EUR', 'USD'],
    })) as { escalation_id: string };
    const blocked = (run_id: string, summary: string) =>
      s.client.reportResult({
        task_id: s.task.task_id,
        run_id,
        status: 'blocked',
        summary,
        changed_paths: [],
        checks: [],
        notes: [],
      });
    await blocked(s.run_id, 'waiting for the answer');
    // The task goes to a second run, which asks for an approval and waits for it.
    await td.operator.post(td.operator.projectPath(`/tasks/${s.task.task_id}/release`), {});
    await td.operator.post(td.operator.projectPath(`/tasks/${s.task.task_id}/assign`), { agent_key: 'sp-1' });
    const start = await nextMessage(s.client, 'task.start');
    await s.client.ack([{ message_id: start.message_id, accepted: true, session_ref: 'sess-sp-2' }]);
    const run2 = String((start.params as { run_id: string }).run_id);
    expect(run2).not.toBe(s.run_id);
    await s.client.requestPermission({
      task_id: s.task.task_id,
      run_id: run2,
      action_class: 'git.mutate',
      command: 'git push',
      justification: 'publish',
    });
    await blocked(run2, 'waiting for the push approval');
    await td.operator.post(td.operator.projectPath(`/escalations/${asked.escalation_id}/answer`), { answer: 'EUR' });
    expect(await noMessage(s.client, 'task.resume')).toBe(true);
  });

  it('sends a resume held through a pause longer than its expiry once Friday resumes (review M9i)', async () => {
    const clock = new FakeClock(new Date().toISOString());
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES, clock });
    const s = await blockedOnApproval(td);
    const op = (route: string) =>
      raw(td, 'POST', td.operator.projectPath(route), { token: td.daemon.tokens.operator, body: '{}' });
    await op('/control/pause');
    await td.operator.post(td.operator.projectPath(`/approvals/${s.approvalId}/approve`), { reuse: 'once', via: 'ui' });
    // Ten minutes: twice the five a queued message lives.
    clock.advance(10 * 60_000);
    await op('/control/resume');
    const resume = await nextMessage(s.client, 'task.resume');
    expect((resume.params as { note: string }).note).toContain('granted');
  });
});

describe("Friday's own questions", () => {
  it('settles a recovery question when a human performs a recovery action', async () => {
    const td = await startTestDaemon(ws(), { extraConfig: NO_WORKTREES });
    const s = await spawnedSession(td, { hooks: true });
    await s.client.reportError({
      task_id: s.task.task_id,
      run_id: s.run_id,
      message: 'the host crashed',
      fatal: true,
    });
    await td.operator.post(td.operator.projectPath(`/tasks/${s.task.task_id}/recover`), {
      action: 'needs_human',
      reason: 'ask me',
    });
    const pending = () =>
      td.operator
        .get<{ escalations: EscalationView[] }>(td.operator.projectPath('/escalations?status=pending'))
        .then((r) => r.escalations.filter((e) => e.task_id === s.task.task_id && e.kind === 'recovery_needed'));
    expect((await pending()).length).toBe(1);
    // Reassigning it (not cancelling, which settles every question of the task anyway).
    await td.operator.post(td.operator.projectPath(`/tasks/${s.task.task_id}/recover`), {
      action: 'reassign',
      reason: 'try again',
    });
    expect((await taskOf(td, s.task.task_id)).status).toBe('READY');
    expect((await pending()).length).toBe(0);
  });
});
