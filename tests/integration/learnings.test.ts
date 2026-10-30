/**
 * Learnings end to end (ADR-0034 §7; plan Phase 3.4): an agent proposes a lesson through Friday,
 * its task passes verification, and the next agent's packet carries it as a checked learning; a
 * human approves or rejects what verification did not decide.
 */
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { ContextPacket, LearningProposalView, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { TEST_HOST_MODELS } from '../helpers/fake-harness.js';

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

async function attach(td: TestDaemon, key: string) {
  const h = new GenericHarnessClient(td.bootstrap, {
    harness_key: `learnings:${key}`,
    vendor: 'generic',
    name: key,
    attach_mode: 'attach',
    project_id: td.project.project_id,
    agent_key: key,
    capabilities: { models: TEST_HOST_MODELS },
    enforcement_level: 'L1',
  });
  await h.register();
  return h;
}

const task = (td: TestDaemon, summary: string, write: string, agent: string) =>
  td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary,
    role: 'backend',
    scope: { write: [write], read: [] },
    assign_agent_key: agent,
  });

describe('learnings', () => {
  it('reach the next agent once the proposing task passes verification', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const one = await attach(td, 'be-1');
    const first = await task(td, 'Fix migrations', 'db/**', 'be-1');
    const claim = await one.claim({ next: true });
    expect(claim.task.task_id).toBe(first.task_id);

    const { proposal } = await one.call('learning.propose', {
      kind: 'bug-pattern',
      subject: 'Migrations',
      content: 'Back up the dev database before running migrations.',
      paths: ['db/**'],
    });
    expect(proposal).toMatchObject({ status: 'proposed', task_id: first.task_id });
    const waiting = await cli(['--project', dir, 'learnings']);
    expect(waiting.stdout).toContain(proposal.proposal_id);
    expect(waiting.stdout).toContain('waiting');

    await one.reportResult({
      task_id: first.task_id,
      run_id: claim.run_id,
      status: 'completed_claim',
      summary: 'fixed',
      changed_paths: [],
    });
    expect((await cli(['--project', dir, 'verify', first.task_id, '--result', 'passed'])).code).toBe(0);
    const learned = await td.operator.get<LearningProposalView>(
      td.operator.projectPath(`/learnings/${proposal.proposal_id}`),
    );
    expect(learned.status).toBe('promoted');
    expect(learned.memory_id).toMatch(/^mem_/);

    // The next agent working on the same area meets it as a checked learning.
    const two = await attach(td, 'be-2');
    await task(td, 'Add a migration', 'db/**', 'be-2');
    const next = await two.claim({ next: true });
    const packet = next.context as ContextPacket;
    const learnings = packet.sections.find((s) => s.kind === 'learnings.relevant')?.content ?? '';
    expect(learnings).toContain('Back up the dev database before running migrations.');
    expect(learnings).toContain('[verified, bug-pattern]');
  });

  it('lets a human approve or reject what verification did not decide', async () => {
    const td = await startTestDaemon(ws(), { git: true, brain: false });
    const dir = ws().projectDir;
    const one = await attach(td, 'be-1');
    await task(td, 'Tidy config', 'config/**', 'be-1');
    await one.claim({ next: true });
    const a = (
      await one.call('learning.propose', {
        kind: 'convention',
        subject: 'Config',
        content: 'Config keys are snake_case.',
      })
    ).proposal;
    const b = (
      await one.call('learning.propose', { kind: 'convention', subject: 'Logs', content: 'Log everything at debug.' })
    ).proposal;

    const approved = await cli(['--project', dir, 'learning', 'approve', a.proposal_id, '--note', 'yes']);
    expect(approved.code, approved.stderr).toBe(0);
    expect(approved.stdout).toContain('learned by');
    const rejected = await cli(['--project', dir, 'learning', 'reject', b.proposal_id, '--note', 'too noisy']);
    expect(rejected.code, rejected.stderr).toBe(0);
    expect(rejected.stdout).toContain('rejected by');

    const all = await cli(['--project', dir, '--json', 'learnings', '--all']);
    const { learnings } = JSON.parse(all.stdout) as { learnings: LearningProposalView[] };
    expect(Object.fromEntries(learnings.map((l) => [l.proposal_id, l.status]))).toEqual({
      [a.proposal_id]: 'promoted',
      [b.proposal_id]: 'rejected',
    });
    const memory = await td.operator.get<{ authority: string }>(
      td.operator.projectPath(`/memory/${learnings.find((l) => l.proposal_id === a.proposal_id)?.memory_id}`),
    );
    expect(memory.authority).toBe('human-approved');
    expect((await cli(['--project', dir, 'learnings'])).stdout).toContain('No learnings proposed.');
  });
});
