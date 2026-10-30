import type { GenericHarnessClient } from '@friday/adapter-generic';
import { describe, expect, it } from 'vitest';
import { SPAWNED_AGENT_TOOLS, spawnedAgentTools } from './spawned.js';

/** A client that records its calls and answers learning.propose as the daemon does. */
function recordingClient() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const client = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      return {
        proposal: { proposal_id: 'lrn_1', status: 'proposed', kind: params.kind, task_id: 'task_1' },
      };
    },
  } as unknown as GenericHarnessClient;
  return { client, calls };
}

describe('friday_remember for a spawned agent (ADR-0034 §7)', () => {
  it('is one of the spawned tools and always proposes a lesson for the whole project', async () => {
    expect(SPAWNED_AGENT_TOOLS).toContain('friday_remember');
    const { client, calls } = recordingClient();
    const tools = spawnedAgentTools({ client: () => client, agentKey: 'be-1', taskId: 'task_1', runId: 'run_1' });
    const remember = tools.find((t) => t.name === 'friday_remember');
    if (!remember) throw new Error('friday_remember missing');
    expect(Object.keys(remember.shape)).toEqual(['kind', 'subject', 'content', 'paths']);
    expect(remember.description.length).toBeLessThan(260);
    const res = await remember.handler({
      kind: 'bug-pattern',
      subject: 'Migrations',
      content: 'Back up first.',
      paths: ['db/**'],
    });
    expect(calls.map((c) => c.method)).toEqual(['learning.propose']);
    expect(calls[0]?.params).toMatchObject({ kind: 'bug-pattern', paths: ['db/**'] });
    expect(res.text).toContain('Proposed lrn_1 for the whole project');
  });

  it('refuses a kind that cannot be a project lesson', async () => {
    const { client, calls } = recordingClient();
    const remember = spawnedAgentTools({
      client: () => client,
      agentKey: 'be-1',
      taskId: 'task_1',
      runId: 'run_1',
    }).find((t) => t.name === 'friday_remember');
    await expect(remember?.handler({ kind: 'summary', subject: 's', content: 'c' })).rejects.toThrow(/project lesson/);
    expect(calls).toEqual([]);
  });
});
