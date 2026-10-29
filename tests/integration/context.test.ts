/**
 * The context compiler through the daemon (plan M4d, ADR-0022): the M4 gate's
 * `friday context explain <task>` on fixture-shop (Part 12 §13), and agent memory over the protocol.
 */
import { cpSync } from 'node:fs';
import path from 'node:path';
import type { ContextPacket, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
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
    expect(out).toMatch(/Files \(\d+\):/);
    expect(out).toMatch(/backend\/src\/checkout\.service\.ts\n\s+reason: in your write scope/);
    expect(out).toMatch(/shared\/src\/api\.ts\n\s+reason: .*shared contract used by backend, frontend/);
    expect(out).toMatch(/frontend\/src\/api-client\.ts\n\s+reason: uses the shared contract shared\/src\/api\.ts/);
    expect(out).not.toContain('infra/');
    expect(out).toContain('memory.relevant');
    expect(out).toContain('Semantic fallback: off.');

    // The agent's own packet arrives with the claim, and it can remember and recall through Friday.
    const claim = await be.client.call('task.claim', { task_id: task.task_id });
    const packet = claim.context as ContextPacket;
    expect(packet.sections.map((s) => s.kind)).toEqual(expect.arrayContaining(['code.related', 'memory.relevant']));
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
});
