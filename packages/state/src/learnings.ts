import { type Actor, FridayError, type LearningProposalView, LearningProposeRequest } from '@friday/protocol';
import type { z } from 'zod';
import type { Caller, FridayState } from './service.js';

const normalized = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * Learnings agents propose for the whole project (ADR-0034 §7). Agents still never write project
 * memory (ADR-0021 §3): a proposal is its own record, tied to the task it came from, and reaches
 * other agents only once a passed verification or a human promotes it into project memory.
 */
export class LearningService {
  constructor(private readonly state: FridayState) {}

  /**
   * An agent proposes a learning from a task it holds or has reserved. The same open proposal for
   * the same task (kind, subject and content, whitespace ignored) is returned instead of repeated.
   */
  propose(
    projectId: string,
    caller: Caller,
    input: z.input<typeof LearningProposeRequest>,
    opts: { idempotency_key?: string } = {},
  ): LearningProposalView {
    const req = LearningProposeRequest.parse(input);
    const actor: Actor = { kind: 'agent', id: caller.agent_id };
    return this.state.bus.execute(
      { name: 'learning.propose', project_id: projectId, actor, idempotency_key: opts.idempotency_key, params: req },
      (ctx) => {
        if (this.state.q.harness(caller.harness_id).shadow) {
          throw new FridayError('harness_shadowed', 'a shadow session cannot propose learnings');
        }
        const agent = this.state.q.agent(caller.agent_id);
        const taskId = req.task_id ?? agent.current_task_id;
        if (!taskId) throw new FridayError('invalid_request', 'name the task the learning comes from');
        const task = this.state.q.task(projectId, taskId);
        const holds = task.assigned_agent_id === agent.agent_id || task.reserved_for_agent_key === agent.agent_key;
        if (!holds || task.status === 'COMPLETED' || task.status === 'CANCELLED') {
          throw new FridayError('permission_denied', `a learning comes from a task you hold; ${taskId} is not yours`, {
            rule: 'learning.task_held',
          });
        }
        const subject = normalized(req.subject);
        const content = normalized(req.content);
        const same = this.state.q
          .learningProposals(projectId, { status: 'proposed', task_id: taskId, limit: 500 })
          .find(
            (p) =>
              p.kind === req.kind &&
              p.subject.toLowerCase() === subject.toLowerCase() &&
              normalized(p.content) === content,
          );
        if (same) return same;
        const proposal_id = this.state.ids.next('lrn');
        ctx.emit({
          type: 'learning.proposed',
          payload: {
            proposal: {
              proposal_id,
              task_id: taskId,
              run_id: agent.current_task_id === taskId ? agent.current_run_id : null,
              agent_id: agent.agent_id,
              agent_key: agent.agent_key,
              kind: req.kind,
              subject,
              content,
              tags: [...new Set(req.tags)],
              paths: [...new Set(req.paths)],
            },
          },
          refs: [
            { kind: 'learning', id: proposal_id },
            { kind: 'task', id: taskId },
          ],
        });
        return this.state.q.learningProposal(projectId, proposal_id);
      },
    ).result;
  }

  /** A human closes a proposal; it stays queryable and never reaches a packet. */
  reject(projectId: string, actor: Actor, proposalId: string, note?: string): LearningProposalView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human rejects a learning');
    return this.state.bus.execute(
      { name: 'learning.reject', project_id: projectId, actor, params: { proposalId, note: note ?? null } },
      (ctx) => {
        const p = this.state.q.learningProposal(projectId, proposalId);
        if (p.status !== 'proposed') {
          throw new FridayError('invalid_state_transition', `learning ${proposalId} is ${p.status}, not proposed`);
        }
        ctx.emit({
          type: 'learning.rejected',
          payload: { proposal_id: proposalId, note: note ?? null },
          refs: [
            { kind: 'learning', id: proposalId },
            { kind: 'task', id: p.task_id },
          ],
        });
        return this.state.q.learningProposal(projectId, proposalId);
      },
    ).result;
  }
}
