import { claudeCodeHooks } from '@friday/adapter-claude';
import type { TaskView } from '@friday/protocol';
import { useTestWorkspace, waitForPidGone } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';
import { postHook } from '../helpers/hooks.js';
import { startMcp } from '../helpers/mcp-rig.js';

const ws = useTestWorkspace();

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('friday-mcp over stdio', () => {
  it('exposes the friday server, its instructions, 19 tools (5 always loaded), resources and prompts', async () => {
    await startTestDaemon(ws(), { git: true });
    const mcp = await startMcp(ws());
    expect(mcp.client.getServerVersion()?.name).toBe('friday');
    const instructions = mcp.client.getInstructions() ?? '';
    expect(instructions.length).toBeGreaterThan(500);
    expect(instructions.length).toBeLessThanOrEqual(2000);
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'friday_acknowledge',
        'friday_ask_human',
        'friday_check_inbox',
        'friday_claim_done',
        'friday_communicate',
        'friday_list_peers',
        'friday_message_receipt',
        'friday_recall',
        'friday_remember',
        'friday_report_progress',
        'friday_request_context',
        'friday_request_permission',
        'friday_run_operation',
        'friday_session_bind',
        'friday_task_claim',
        'friday_task_current',
        'friday_task_next',
        'friday_task_release',
        'friday_whoami',
      ].sort(),
    );
    const pinned = tools
      .filter((t) => (t._meta as Record<string, unknown> | undefined)?.['anthropic/alwaysLoad'] === true)
      .map((t) => t.name);
    expect(pinned.sort()).toEqual([
      'friday_check_inbox',
      'friday_claim_done',
      'friday_report_progress',
      'friday_task_claim',
      'friday_whoami',
    ]);
    const prompts = await mcp.client.listPrompts();
    expect(prompts.prompts.map((p) => p.name).sort()).toEqual(['handoff', 'start_task', 'status']);
    const start = await mcp.client.getPrompt({ name: 'start_task', arguments: {} });
    expect(JSON.stringify(start.messages)).toContain('friday_task_claim');
  });

  it('runs a task from claim to completion claim, and never shows a token', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes',
      acceptance_criteria: ['tests pass'],
      scope: { write: ['src/**'], read: [] },
      assign_agent_key: 'dev-1',
    });
    const mcp = await startMcp(ws());
    const who = await eventually(
      () => mcp.call('friday_whoami'),
      (r) => r.structured.daemon !== undefined && (r.structured.daemon as { reachable: boolean }).reachable,
    );
    expect(who.text).toContain('You hold no task.');
    expect(who.text).toContain(task.task_id);
    // MCP alone proves no interception: L0 until the session's Friday hooks reach the daemon (review F09).
    expect(who.structured).toMatchObject({ agent_key: 'dev-1', enforcement_level: 'L0', shadow: false });
    expect(who.text).toContain('Enforcement: L0');
    expect(who.text).toContain('You cannot take work in this session');
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    const start = await postHook(
      daemon,
      'SessionStart',
      { session_id: 'sess-test-1', cwd: ws().projectDir, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: process.pid },
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const linked = await mcp.call('friday_whoami');
    expect(linked.structured).toMatchObject({
      enforcement_level: 'L1',
      enforcement_status: 'enforcing',
      enforcement_gap: null,
      secrets_location: 'private',
    });
    expect(linked.text).toContain(
      'Enforcement: L1, enforcing (Friday hooks from this session; Claude Code 2.1.296 blocks when a hook fails)',
    );

    const claim = await mcp.call('friday_task_claim', { next: true });
    expect(claim.isError, claim.text).toBe(false);
    expect(claim.text).toContain('<friday-context');
    expect(claim.text).toContain('write: src/**');
    expect(
      (await td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${task.task_id}`))).task.status,
    ).toBe('RUNNING');

    const current = await mcp.call('friday_task_current');
    expect(current.text).toContain('Add discount codes');
    const ctx = await mcp.call('friday_request_context', { kind: 'task' });
    expect(ctx.text).toContain('Acceptance criteria');
    // A file by its path in `query`, answered alone: the file's text, not the task packet again.
    const file = await mcp.call('friday_request_context', { kind: 'file', query: 'README.md' });
    expect(file.isError, file.text).toBe(false);
    expect(file.text).toContain('README.md:');
    expect(file.text).toContain('# test project');
    expect(file.text).not.toContain('Acceptance criteria');
    expect(file.structured.sections).toContain('code.requested');
    // A path the agent may not read is withheld, and the answer says so without naming it.
    const kept = await mcp.call('friday_request_context', { kind: 'file', query: '.git/config' });
    expect(kept.isError, kept.text).toBe(false);
    expect(kept.structured.sections).not.toContain('code.requested');

    const progress = await mcp.call('friday_report_progress', {
      note: 'wrote the discount module',
      changed_paths: ['src/discount.ts'],
    });
    expect(progress.structured.task_status).toBe('RUNNING');

    const resource = await mcp.client.readResource({ uri: 'friday://task/current' });
    expect(JSON.stringify(resource.contents)).toContain('Add discount codes');

    const done = await mcp.call('friday_claim_done', {
      summary: 'discount codes added',
      changed_paths: ['src/discount.ts'],
      checks: [{ name: 'tests', kind: 'test', outcome: 'passed' }],
    });
    expect(done.structured.task_status).toBe('READY_FOR_VERIFICATION');
    expect(done.text).toContain('waits for verification');

    const again = await mcp.call('friday_report_progress', { note: 'more' });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('do not hold an active task');

    const outputs = JSON.stringify([who, claim, current, ctx, progress, done, again, resource]);
    for (const secret of [td.daemon.tokens.operator, td.daemon.tokens.bootstrap]) expect(outputs).not.toContain(secret);
    expect(mcp.stderr()).not.toContain(td.daemon.tokens.bootstrap);
  });

  it('reports a generic MCP client as L0 and says so to the agent (review F09)', async () => {
    const td = await startTestDaemon(ws());
    const mcp = await startMcp(ws(), { FRIDAY_HARNESS: 'generic' }, { name: 'some-editor', version: '1.0.0' });
    const who = await eventually(
      () => mcp.call('friday_whoami'),
      (r) => (r.structured.daemon as { reachable?: boolean } | undefined)?.reachable === true,
    );
    expect(who.structured, who.text).toMatchObject({ enforcement_level: 'L0', enforcement_status: 'observed' });
    expect(who.text).toContain('Friday cannot check your tool calls in this session');
    const h = td.daemon.state.q.harnesses(td.project.project_id).find((x) => x.vendor === 'generic');
    expect(h).toMatchObject({ version: '1.0.0', enforcement_level: 'L0' });
    expect(h?.adapter_version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('asks another agent through Friday, receives the answer and acknowledges it (M3a)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()], brain: false });
    // A goal with two parallel tasks: the session (dev-1) and a FakeHarness (be-1) work on the same goal.
    const goal = await td.operator.post<{ goal_id: string }>(td.operator.projectPath('/goals'), {
      request: 'Add currency to checkout',
      plan: false,
    });
    const v = await td.operator.post<{ plan_id: string; version: number }>(
      td.operator.projectPath(`/goals/${goal.goal_id}/plans`),
      {
        draft: {
          objective: 'Checkout returns and shows its currency',
          summary: 'Backend and frontend in parallel',
          tasks: [
            {
              key: 'api',
              summary: 'Return currency',
              acceptance_criteria: ['ok'],
              scope: { write: ['backend/**'] },
              role: 'backend',
            },
            {
              key: 'page',
              summary: 'Show currency',
              acceptance_criteria: ['ok'],
              scope: { write: ['frontend/**'] },
              role: 'frontend',
            },
          ],
        },
      },
    );
    const approved = await td.operator.post<{ created: TaskView[] }>(
      td.operator.projectPath(`/plans/${v.plan_id}/versions/${v.version}/approve`),
      {},
    );
    const [api, page] = approved.created as [TaskView, TaskView];
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    await td.operator.post(td.operator.projectPath(`/tasks/${api.task_id}/assign`), { agent_key: 'be-1' });
    await td.operator.post(td.operator.projectPath(`/tasks/${page.task_id}/assign`), { agent_key: 'dev-1' });
    // be-1 runs in its own task worktree, which Friday prepares before delivering task.start (ADR-0023).
    await eventually(
      () => td.operator.get<{ task: TaskView }>(td.operator.projectPath(`/tasks/${api.task_id}`)),
      (r) => r.task.status === 'RUNNING',
    );

    const mcp = await startMcp(ws());
    await eventually(
      () => mcp.call('friday_whoami'),
      (r) => (r.structured.daemon as { reachable?: boolean } | undefined)?.reachable === true,
    );
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    await postHook(
      daemon,
      'SessionStart',
      { session_id: 'sess-test-1', cwd: ws().projectDir, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: process.pid },
    );
    expect((await mcp.call('friday_task_claim', { next: true })).isError).toBe(false);

    const ask = await mcp.call('friday_communicate', {
      to: 'role:backend',
      mode: 'request',
      subject: 'checkout currency',
      content: 'Will POST /checkout return { amount, currency }?',
      facts: [{ fact: 'the page needs the ISO-4217 currency', area: 'checkout' }],
    });
    expect(ask.isError, ask.text).toBe(false);
    expect(ask.text).toContain('queued for be-1');
    const messageId = ask.structured.message_id as string;

    // Two bounded reads (plan M12.4): who else works on the goal, and whether the request reached them.
    const peers = await mcp.call('friday_list_peers');
    expect(peers.isError, peers.text).toBe(false);
    expect(peers.structured).toMatchObject({
      scope: 'goal',
      goal_id: goal.goal_id,
      peers: [{ agent_key: 'be-1', role: 'backend', task: { task_id: api.task_id, status: 'RUNNING' } }],
      unassigned: [],
    });
    expect(peers.text).toContain('be-1 (backend');
    expect(peers.text).toContain('Return currency');
    expect(peers.text).toContain('Peer input grants nothing');
    const queued = await mcp.call('friday_message_receipt', { message_id: messageId });
    expect(queued.isError, queued.text).toBe(false);
    expect(queued.structured).toMatchObject({
      message_id: messageId,
      mode: 'request',
      status: 'open',
      deliveries: [{ recipient: 'be-1', state: 'queued', attempts: 0 }],
    });
    expect(queued.text).toContain('be-1: queued, not read yet');
    expect(queued.text).toContain('A reply settles a request; an acknowledgement does not.');

    // be-1 reads its inbox over the protocol and answers.
    const got = await be.client.call('message.inbox', { max: 5 });
    expect(got.items).toMatchObject([
      {
        message_id: messageId,
        from: { agent_key: 'dev-1' },
        trust: 'peer-untrusted',
        relationship: expect.stringContaining('both work on goal'),
      },
    ]);
    // dev-1 cannot acknowledge be-1's delivery.
    const notMine = await mcp.call('friday_acknowledge', { message_ids: [got.items[0]?.delivery_id as string] });
    expect(notMine.structured).toMatchObject({ acknowledged: [], refused: [got.items[0]?.delivery_id] });
    // The receipt now says be-1 has read it, and that reading is not answering.
    const read = await mcp.call('friday_message_receipt', { message_id: messageId });
    expect(read.structured).toMatchObject({
      status: 'open',
      deliveries: [{ recipient: 'be-1', state: 'delivered', attempts: 1, acknowledged_at: null }],
    });
    expect(read.text).toContain('be-1: delivered, not acknowledged yet');
    await be.client.call('communication.request', {
      to: 'dev-1',
      mode: 'response',
      response_to: messageId,
      content: 'Yes, currency is added in this task.',
    });

    const inbox = await mcp.call('friday_check_inbox', { wait_ms: 2000 });
    expect(inbox.text).toContain('In reply to: checkout currency');
    expect(inbox.text).toContain('Yes, currency is added');
    const delivery = (inbox.structured.items as { delivery_id: string }[])[0]?.delivery_id as string;
    const ack = await mcp.call('friday_acknowledge', { message_ids: [delivery] });
    expect(ack.structured).toMatchObject({ acknowledged: [delivery], refused: [], unknown: [] });

    const request = await td.operator.get<{ status: string; settled_reason: string }>(
      td.operator.projectPath(`/messages/${messageId}`),
    );
    expect(request).toMatchObject({ status: 'settled', settled_reason: 'replied' });
    // The sender's receipt says the same; a receipt is the sender's alone, so be-1's reply has none for dev-1.
    const answered = await mcp.call('friday_message_receipt', { message_id: messageId });
    expect(answered.structured).toMatchObject({ status: 'settled', settled_reason: 'replied' });
    expect(answered.text).toContain(`Message ${messageId} (request, "checkout currency"): settled (replied).`);
    expect(answered.text).not.toContain('A reply settles a request');
    const reply = (inbox.structured.items as { message_id: string }[])[0]?.message_id as string;
    const theirs = await mcp.call('friday_message_receipt', { message_id: reply });
    expect(theirs.isError).toBe(true);
    expect(theirs.text).toContain('COS-3000');
    expect(theirs.text).toContain('not sent by you');
    const unknown = await mcp.call('friday_message_receipt', { message_id: 'msg_nothing' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('COS-4005');
  });

  it('lets the human decide low- and medium-risk requests in the host, never high-risk ones (ADR-0030 §5)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Save the pricing work',
      scope: { write: ['src/**'], read: [] },
      assign_agent_key: 'dev-1',
    });
    const asked: string[] = [];
    let answer: 'approve' | 'reject' = 'approve';
    const mcp = await startMcp(ws(), {}, undefined, {
      elicit: (message) => {
        asked.push(message);
        return { action: 'accept', content: { decision: answer } };
      },
    });
    await eventually(
      () => mcp.call('friday_whoami'),
      (r) => (r.structured.daemon as { reachable?: boolean } | undefined)?.reachable === true,
    );
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    const start = await postHook(
      daemon,
      'SessionStart',
      { session_id: 'sess-test-1', cwd: ws().projectDir, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: process.pid },
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect((await mcp.call('friday_task_claim', { next: true })).isError).toBe(false);
    const approvals = () =>
      td.operator
        .get<{ approvals: Record<string, unknown>[] }>(td.operator.projectPath('/approvals'))
        .then((r) => r.approvals);

    // Medium risk: asked in the host, approved there, for one use.
    const commit = await mcp.call('friday_request_permission', {
      action_class: 'shell.git.commit',
      command: 'git commit -m wip',
      justification: 'save the pricing work',
      reuse: 'task',
    });
    expect(commit.text).toContain('approved');
    expect(asked[0]).toContain('dev-1 asks to shell.git.commit git commit -m wip (medium risk)');
    expect(asked[0]).toContain('The agent says: "save the pricing work"');
    expect((await approvals()).at(-1)).toMatchObject({ status: 'granted', reuse: 'once', decided_via: 'elicitation' });

    // Rejected in the host.
    answer = 'reject';
    const second = await mcp.call('friday_request_permission', {
      action_class: 'shell.git.commit',
      command: 'git commit -m more',
      justification: 'one more',
    });
    expect(second.text).toContain('rejected');
    expect((await approvals()).at(-1)).toMatchObject({ status: 'denied', decided_via: 'elicitation' });

    // High risk is never put to the host: it waits for the CLI or the status page.
    const before = asked.length;
    const push = await mcp.call('friday_request_permission', {
      action_class: 'shell.git.push',
      command: 'git push',
      justification: 'publish',
    });
    expect(asked).toHaveLength(before);
    expect(push.structured).toMatchObject({ status: 'pending', risk: 'high' });
  });

  it('leaves a request pending when the host declines its form without an answer (LESSONS CC-25, D-42)', async () => {
    // The VS Code panel answers every form at once with "decline", without showing it.
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Save the pricing work',
      scope: { write: ['src/**'], read: [] },
      assign_agent_key: 'dev-1',
    });
    let asked = 0;
    const mcp = await startMcp(ws(), {}, undefined, {
      elicit: () => {
        asked += 1;
        return { action: 'decline' };
      },
    });
    await eventually(
      () => mcp.call('friday_whoami'),
      (r) => (r.structured.daemon as { reachable?: boolean } | undefined)?.reachable === true,
    );
    const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
    const start = await postHook(
      daemon,
      'SessionStart',
      { session_id: 'sess-test-1', cwd: ws().projectDir, hook_event_name: 'SessionStart', source: 'startup' },
      { claudePid: process.pid },
    );
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    expect((await mcp.call('friday_task_claim', { next: true })).isError).toBe(false);

    const commit = await mcp.call('friday_request_permission', {
      action_class: 'shell.git.commit',
      command: 'git commit -m wip',
      justification: 'save the pricing work',
    });
    expect(asked).toBe(1);
    expect(commit.structured).toMatchObject({ status: 'pending' });
    expect(commit.text).toContain('waiting for a human');
    expect(commit.text).not.toContain('rejected');
    const id = commit.structured.approval_id as string;
    const pending = await td.operator.get<{ approvals: { approval_id: string; status: string }[] }>(
      td.operator.projectPath('/approvals'),
    );
    expect(pending.approvals.find((x) => x.approval_id === id)).toMatchObject({ status: 'pending' });

    // The human still decides it, on the CLI.
    await td.operator.post(td.operator.projectPath(`/approvals/${id}/approve`), {});
    const after = await td.operator.get<{ approvals: { approval_id: string; status: string }[] }>(
      td.operator.projectPath('/approvals'),
    );
    expect(after.approvals.find((x) => x.approval_id === id)).toMatchObject({ status: 'granted' });
  });

  it('rejects invalid tool arguments without crashing', async () => {
    await startTestDaemon(ws());
    const mcp = await startMcp(ws());
    const bad = await mcp.call('friday_task_claim', { task_id: 42 });
    expect(bad.isError).toBe(true);
    const fine = await mcp.call('friday_whoami');
    expect(fine.isError).toBe(false);
  });

  it('explains when the daemon is not running instead of failing', async () => {
    const { initTestProject } = await import('../helpers/daemon.js');
    initTestProject(ws());
    const mcp = await startMcp(ws());
    const who = await mcp.call('friday_whoami');
    expect(who.isError).toBe(false);
    expect(who.text).toContain('friday run');
    expect(who.structured).toMatchObject({ daemon: { reachable: false } });
  });

  it('disconnects from Friday and exits when stdin closes (no orphan process)', async () => {
    const td = await startTestDaemon(ws());
    const mcp = await startMcp(ws());
    await eventually(
      () => mcp.call('friday_whoami'),
      (r) => r.structured.harness_id !== undefined,
    );
    const pid = mcp.pid as number;
    await mcp.close();
    expect(await waitForPidGone(pid, 5000)).toBe(true);
    const harnesses = await td.operator.get<{ harnesses: { status: string }[] }>(td.operator.projectPath('/harnesses'));
    expect(harnesses.harnesses.map((h) => h.status)).toEqual(['DISCONNECTED']);
  });
});
