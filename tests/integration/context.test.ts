/**
 * The context compiler through the daemon (plan M4d, ADR-0022): the M4 gate's
 * `friday context explain <task>` on fixture-shop (Part 12 §13), and agent memory over the protocol.
 */
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ContextPacket, TaskView } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

describe('friday context explain (M4 gate, Part 12 §13)', () => {
  it('lists the files a backend task receives with their reasons, and agents remember through Friday', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    for (const part of ['backend', 'frontend', 'shared', 'infra', 'tsconfig.json']) {
      cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop', part), path.join(dir, part), {
        recursive: true,
      });
    }
    // Committed before the task starts: a spawned agent works in a task worktree made from HEAD,
    // and uncommitted files in the main checkout are not in it (LESSONS UI-73).
    await deterministicGit(dir).commitAll('fixture-shop');
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes to checkout',
      scope: { write: ['backend/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    await td.operator.post(td.operator.projectPath('/memory'), {
      scope_type: 'project',
      kind: 'decision',
      subject: 'money',
      content: 'Money is integer minor units with an ISO-4217 currency.',
    });

    const explained = await cli(['--project', dir, 'context', 'explain', task.task_id]);
    expect(explained.code, explained.stderr).toBe(0);
    const out = explained.stdout;
    // The first packet names the task's scope and the project's memory, no list of files (plan M14.7).
    expect(out).toContain('Files: none related through the code graph.');
    expect(out).toContain('task.scope');
    expect(out).not.toContain('infra/');
    expect(out).toContain('memory.relevant');
    expect(out).toContain('Semantic fallback: off.');

    // The agent's own packet arrives with the claim, and it can remember and recall through Friday.
    const claim = await be.client.call('task.claim', { task_id: task.task_id });
    const packet = claim.context as ContextPacket;
    expect(packet.sections.map((s) => s.kind)).toContain('memory.relevant');
    expect(packet.sections.map((s) => s.kind)).not.toContain('code.related');
    // The files of the scope and the code related to them come on request, answered alone.
    const files = await be.client.requestContext({ task_id: task.task_id, kind: 'scope_files' });
    const related = files.sections.find((s) => s.kind === 'code.related')?.content ?? '';
    expect(related).toContain('backend/src/checkout.service.ts — in your write scope');
    expect(related).toMatch(/shared\/src\/api\.ts — .*shared contract used by backend, frontend/);
    expect(related).toMatch(/frontend\/src\/api-client\.ts — uses the shared contract shared\/src\/api\.ts/);
    expect(JSON.stringify(files)).not.toContain('infra/');
    expect(files.sections.map((s) => s.kind)).not.toContain('task.contract');
    const fresh = await td.operator.get<ContextPacket>(td.operator.projectPath(`/context/${packet.context_id}`));
    expect(fresh.staleness.is_stale).toBe(false);
    const remembered = await be.client.call('memory.record', {
      kind: 'convention',
      subject: 'discount codes',
      content: 'Discount codes are case-insensitive.',
    });
    expect(remembered.memory).toMatchObject({ scope_type: 'task', scope_id: task.task_id, authority: 'agent' });
    const recalled = await be.client.call('memory.search', { query: 'discount money' });
    expect(recalled.memories.map((m) => m.subject)).toEqual(expect.arrayContaining(['discount codes', 'money']));
    // What the agent just remembered changes what a packet would hold: the stored one says it is stale.
    const stored = await td.operator.get<ContextPacket>(td.operator.projectPath(`/context/${packet.context_id}`));
    expect(stored.staleness).toMatchObject({ is_stale: true, reason: expect.stringContaining('memory') });
  });

  it("explains the packet a task's agent was given, not what a human may read (LESSONS D-49)", async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    for (const part of ['backend', 'frontend', 'shared', 'tsconfig.json']) {
      cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop', part), path.join(dir, part), {
        recursive: true,
      });
    }
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const other = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Choose the launch discount codes',
      scope: { write: ['frontend/**'], read: [] },
    });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes to checkout',
      scope: { write: ['backend/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    // A decision kept in another task's memory: be-1 holds no scope that reads it.
    const kept = await td.operator.post<{ memory: { memory_id: string } }>(td.operator.projectPath('/memory'), {
      scope_type: 'task',
      scope_id: other.task_id,
      kind: 'decision',
      subject: 'launch discount codes',
      content: 'The launch discount codes are WELCOME10 and FIVEOFF.',
    });
    const memoryId = kept.memory.memory_id;
    await be.client.call('task.claim', { task_id: task.task_id });

    const explained = await cli(['--project', dir, 'context', 'explain', task.task_id]);
    expect(explained.code, explained.stderr).toBe(0);
    expect(explained.stdout).toContain('Delivered to be-1');
    expect(explained.stdout).not.toContain(memoryId);

    // A preview on request says whose view it is.
    const preview = await cli(['--project', dir, 'context', 'explain', task.task_id, '--fresh']);
    expect(preview.code, preview.stderr).toBe(0);
    expect(preview.stdout).toContain('compiled for you');
    // A human may read every memory, so the preview shows what the agent was not given.
    expect(preview.stdout).toContain(memoryId);
  });

  it('never names what the project policy keeps from agents, also after a tightening, except a path a human approved (review F02)', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    for (const part of ['backend', 'frontend', 'shared', 'infra', 'tsconfig.json']) {
      cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop', part), path.join(dir, part), {
        recursive: true,
      });
    }
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes to checkout',
      scope: { write: ['backend/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    await be.client.call('task.claim', { task_id: task.task_id });
    const client = 'frontend/src/api-client.ts';
    const first = (await be.client.requestContext({ task_id: task.task_id, kind: 'task' })) as ContextPacket;
    expect(JSON.stringify(first.sections)).toContain(client);

    // The project now keeps the frontend from agents; tightening applies at once.
    mkdirSync(path.join(ws().fridayDir, 'policies'), { recursive: true });
    writeFileSync(path.join(ws().fridayDir, 'policies', 'private.yaml'), 'deny:\n  read: ["frontend/**"]\n');
    await td.operator.post(td.operator.projectPath('/policy/reload'), {});
    const second = (await be.client.requestContext({ task_id: task.task_id, kind: 'task' })) as ContextPacket;
    expect(second.context_id).not.toBe(first.context_id);
    expect(JSON.stringify(second.sections)).not.toContain('frontend/');
    const explained = await cli(['--project', dir, 'context', 'explain', second.context_id]);
    expect(explained.stdout).not.toContain('frontend/');
    // The packet compiled before says it no longer stands.
    const stored = await td.operator.get<ContextPacket>(td.operator.projectPath(`/context/${first.context_id}`));
    expect(stored.staleness).toMatchObject({ is_stale: true, reason: expect.stringContaining('policy') });

    // A human approves reading that one file for this task: it is back, and nothing else of the frontend.
    const asked = await be.client.requestPermission({
      action_class: 'file.read',
      resource: client,
      justification: 'the client shows how the contract is used',
      reuse: 'task',
    });
    expect(asked.status).toBe('pending');
    expect((await cli(['--project', dir, 'approve', asked.approval_id as string])).code).toBe(0);
    const third = (await be.client.requestContext({ task_id: task.task_id, kind: 'task' })) as ContextPacket;
    const text = JSON.stringify(third.sections);
    expect(text).toContain(client);
    expect([...new Set(text.match(/frontend\/[\w./-]+/g))]).toEqual([client]);

    // The approval is revoked: the file is gone again, and the packet that showed it is stale.
    expect((await cli(['--project', dir, 'approvals', 'revoke', asked.approval_id as string])).code).toBe(0);
    const fourth = (await be.client.requestContext({ task_id: task.task_id, kind: 'task' })) as ContextPacket;
    expect(fourth.context_id).not.toBe(third.context_id);
    expect(JSON.stringify(fourth.sections)).not.toContain('frontend/');
    const shown = await td.operator.get<ContextPacket>(td.operator.projectPath(`/context/${third.context_id}`));
    expect(shown.staleness.is_stale).toBe(true);
  });

  it('answers a context request with what it asks for, or says it cannot fit (review F12, F17)', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    for (const part of ['backend', 'frontend', 'shared', 'tsconfig.json']) {
      cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop', part), path.join(dir, part), {
        recursive: true,
      });
    }
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Add discount codes to checkout',
      scope: { write: ['backend/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    await be.client.call('task.claim', { task_id: task.task_id });
    // 500 characters cannot hold the task's protected context: the answer says what it needs.
    await expect(
      be.client.requestContext({ task_id: task.task_id, kind: 'task', max_chars: 500 }),
    ).rejects.toMatchObject({ code: 'COS-5002' });
    // Two different files asked for: two different answers, each within its advertised budget.
    const service = (await be.client.requestContext({
      task_id: task.task_id,
      kind: 'file',
      paths: ['backend/src/checkout.service.ts'],
    })) as ContextPacket;
    const api = (await be.client.requestContext({
      task_id: task.task_id,
      kind: 'file',
      paths: ['shared/src/api.ts'],
    })) as ContextPacket;
    expect(service.context_id).not.toBe(api.context_id);
    const requested = (p: ContextPacket) => p.sections.find((s) => s.kind === 'code.requested')?.content ?? '';
    expect(requested(service)).toMatch(/^backend\/src\/checkout\.service\.ts:\n/);
    expect(requested(api)).toMatch(/^shared\/src\/api\.ts:\n/);
    for (const p of [service, api]) expect(JSON.stringify(p).length).toBeLessThanOrEqual(p.budget.chars ?? 0);
  });

  it('spends a read approval on each packet that shows the file, once for a one-use approval (review M7.1 R01)', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    const pid = td.project.project_id;
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Follow the private notes',
      scope: { write: ['src/**'], read: [] },
      assign_agent_key: 'be-1',
    });
    await be.client.call('task.claim', { task_id: task.task_id });
    const runId = td.daemon.state.q.task(pid, task.task_id).current_run_id as string;
    const root = td.daemon.state.q.findRun(runId)?.execution_root ?? dir;
    mkdirSync(path.join(root, 'private'), { recursive: true });
    const file = path.join(root, 'private', 'data.txt');
    mkdirSync(path.join(ws().fridayDir, 'policies'), { recursive: true });
    writeFileSync(path.join(ws().fridayDir, 'policies', 'private.yaml'), 'deny:\n  read: ["private/**"]\n');
    await td.operator.post(td.operator.projectPath('/policy/reload'), {});
    const ask = (maxChars?: number) =>
      be.client.requestContext({
        task_id: task.task_id,
        kind: 'file',
        paths: ['private/data.txt'],
        ...(maxChars ? { max_chars: maxChars } : {}),
      }) as Promise<ContextPacket>;
    const shows = (p: ContextPacket, marker: string) => JSON.stringify(p.sections).includes(marker);
    const approve = async (reuse: 'once' | 'task') => {
      const asked = await be.client.requestPermission({
        action_class: 'file.read',
        resource: 'private/data.txt',
        justification: 'the notes say how to do the task',
        reuse,
      });
      expect(asked.status).toBe('pending');
      expect((await cli(['--project', dir, 'approve', asked.approval_id as string])).code).toBe(0);
      return asked.approval_id as string;
    };
    const approval = (id: string) =>
      td.daemon.state.q.approvals(pid).find((a) => a.approval_id === id) as { status: string; uses: number };
    const usedEvents = (id: string) =>
      td.daemon.state.store.readByRef(pid, 'approval', id).filter((e) => e.type === 'approval.used');

    writeFileSync(file, 'FIRST_PRIVATE_CONTENT\n');
    expect(shows(await ask(), 'FIRST_PRIVATE_CONTENT')).toBe(false);

    // One use: the first packet that shows the file spends it, with the use recorded.
    const once = await approve('once');
    expect(shows(await ask(), 'FIRST_PRIVATE_CONTENT')).toBe(true);
    expect(approval(once)).toMatchObject({ status: 'used', uses: 1 });
    expect(usedEvents(once).map((e) => (e.payload as { tool: string }).tool)).toEqual(['context']);
    // The file changes: reading it again needs another approval.
    writeFileSync(file, 'SECOND_PRIVATE_CONTENT\n');
    expect(shows(await ask(), 'SECOND_PRIVATE_CONTENT')).toBe(false);
    expect(approval(once).uses).toBe(1);

    // Two requests at once under one new one-use approval: only one of them shows the file.
    const twice = await approve('once');
    writeFileSync(file, 'THIRD_PRIVATE_CONTENT\n');
    const both = await Promise.all([ask(), ask()]);
    expect(both.filter((p) => shows(p, 'THIRD_PRIVATE_CONTENT'))).toHaveLength(1);
    expect(approval(twice)).toMatchObject({ status: 'used', uses: 1 });

    // An approval for the whole task: each packet that shows fresh content records a use.
    const whole = await approve('task');
    writeFileSync(file, 'FOURTH_PRIVATE_CONTENT\n');
    expect(shows(await ask(), 'FOURTH_PRIVATE_CONTENT')).toBe(true);
    writeFileSync(file, 'FIFTH_PRIVATE_CONTENT\n');
    expect(shows(await ask(), 'FIFTH_PRIVATE_CONTENT')).toBe(true);
    expect(approval(whole)).toMatchObject({ status: 'granted', uses: 2 });
    await cli(['--project', dir, 'approvals', 'revoke', whole]);

    // Cut by the budget: the file is not shown, and the approval is not spent.
    const cut = await approve('once');
    writeFileSync(file, `SIXTH_PRIVATE_CONTENT\n${'x'.repeat(2400)}\n`);
    const need = await ask(500).then(
      () => 0,
      (e: { details?: { required_chars?: number } }) => e.details?.required_chars ?? 0,
    );
    expect(need).toBeGreaterThan(500);
    const small = await ask(need + 200);
    expect(shows(small, 'SIXTH_PRIVATE_CONTENT')).toBe(false);
    expect(approval(cut)).toMatchObject({ status: 'granted', uses: 0 });
  });
});
