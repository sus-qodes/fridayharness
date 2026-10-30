import {
  type Actor,
  FridayError,
  type LearningOrigin,
  type LearningProposalView,
  LearningProposeRequest,
  type TaskView,
} from '@friday/protocol';
import type { z } from 'zod';
import type { CommandContext } from './bus.js';
import type { RecordResult } from './memory.js';
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
        const origin = req.from_failure ? this.originOf(task, req.from_failure) : null;
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
              ...(origin ? { origin } : {}),
            },
          },
          refs: [
            { kind: 'learning', id: proposal_id },
            { kind: 'task', id: taskId },
            ...(origin ? [{ kind: origin.kind, id: origin.id }] : []),
          ],
        });
        return this.state.q.learningProposal(projectId, proposal_id);
      },
    ).result;
  }

  /**
   * The failure a lesson is learned from (ADR-0038 §5), written from Friday's own records: a
   * verification of the task that FAILED (the latest, unless named) or an operation run of the
   * task that failed or was interrupted. Anything else is refused: a failure is a resolved fact.
   */
  private originOf(task: TaskView, from: { kind: 'verification' | 'operation'; id?: string }): LearningOrigin {
    const q = this.state.q;
    if (from.kind === 'verification') {
      const v = from.id ? q.verification(from.id) : q.latestVerification(task.task_id);
      if (!v || v.task_id !== task.task_id) {
        throw new FridayError(
          'invalid_request',
          `${from.id ?? 'no verification'} is not a verification of ${task.task_id}`,
        );
      }
      if (v.status !== 'FAILED') {
        throw new FridayError('invalid_request', `verification ${v.verification_id} is ${v.status}, not FAILED`);
      }
      const failed = v.checks
        .filter((c) => c.status === 'FAILED' || c.status === 'BLOCKED')
        .map((c) => `${c.name}: ${c.summary ?? c.status}${c.artifact_ref ? ` (${c.artifact_ref})` : ''}`);
      return {
        kind: 'verification',
        id: v.verification_id,
        detail: (failed.length ? failed.join('; ') : (v.summary ?? 'failed')).slice(0, 600),
      };
    }
    if (!from.id) throw new FridayError('invalid_request', 'name the operation run (operation_run_id)');
    const run = q.operationRun(from.id);
    if (!run || run.task_id !== task.task_id) {
      throw new FridayError('invalid_request', `${from.id} is not an operation run of ${task.task_id}`);
    }
    if (run.status !== 'failed' && run.status !== 'interrupted') {
      throw new FridayError('invalid_request', `operation run ${run.operation_run_id} is ${run.status}, not failed`);
    }
    return {
      kind: 'operation',
      id: run.operation_run_id,
      detail:
        `${run.operation} ${run.status}${run.exit_code !== null ? ` (exit ${run.exit_code})` : ''}${run.timed_out ? ', timed out' : ''}: ${run.summary ?? run.status}${run.artifact_ref ? ` (${run.artifact_ref})` : ''}`.slice(
          0,
          600,
        ),
    };
  }

  /**
   * A human promotes a proposal: it becomes project memory with the human's authority
   * (human-approved), through the ordinary memory pipeline (ADR-0034 §7).
   */
  approve(projectId: string, actor: Actor, proposalId: string, note?: string): LearningProposalView {
    if (actor.kind !== 'human') throw new FridayError('permission_denied', 'only a human approves a learning');
    return this.state.bus.execute(
      { name: 'learning.approve', project_id: projectId, actor, params: { proposalId, note: note ?? null } },
      (ctx) => {
        const p = this.state.q.learningProposal(projectId, proposalId);
        if (p.status !== 'proposed') {
          throw new FridayError('invalid_state_transition', `learning ${proposalId} is ${p.status}, not proposed`);
        }
        this.promoteWithin(ctx, projectId, p, { by: 'human', actor, note: note ?? null });
        return this.state.q.learningProposal(projectId, proposalId);
      },
    ).result;
  }

  /**
   * Every open proposal of a task whose verification passed becomes project memory with
   * verification's authority (`verified`), inside the command that records the verdict, so the
   * verdict and the learnings commit together. A failed verification promotes nothing.
   */
  promoteForVerification(ctx: CommandContext, projectId: string, taskId: string, verificationId: string): string[] {
    const open = this.state.q.learningProposals(projectId, { status: 'proposed', task_id: taskId, limit: 500 });
    const promoted: string[] = [];
    for (const p of [...open].reverse()) {
      this.promoteWithin(ctx, projectId, p, {
        by: 'verification',
        actor: { kind: 'system', id: `verification:${verificationId}` },
        note: `the task's verification ${verificationId} passed`,
        verificationId,
      });
      promoted.push(p.proposal_id);
    }
    return promoted;
  }

  /**
   * One promotion: the memory pipeline decides dedupe, supersession and contradiction (ADR-0021 §5).
   * A learning that contradicts a human-approved memory is recorded needing review, and no packet
   * shows it as a learning until a human settles it. The proposal's paths become path tags.
   */
  private promoteWithin(
    ctx: CommandContext,
    projectId: string,
    p: LearningProposalView,
    how: { by: 'verification' | 'human'; actor: Actor; note: string | null; verificationId?: string },
  ): RecordResult {
    const recorded = this.state.memory.recordWithin(
      ctx,
      projectId,
      how.by === 'human' ? { kind: 'human', actor: how.actor } : { kind: 'system', actor: how.actor },
      {
        scope_type: 'project',
        kind: p.kind,
        subject: p.subject,
        content: p.content,
        // The failure it was learned from stays with the memory (ADR-0038 §5).
        tags: [...new Set([...p.tags, ...p.paths, ...(p.origin ? [`origin:${p.origin.kind}:${p.origin.id}`] : [])])],
      },
    );
    ctx.emit({
      type: 'learning.promoted',
      actor: how.actor,
      payload: {
        proposal_id: p.proposal_id,
        memory_id: recorded.memory.memory_id,
        by: how.by,
        verification_id: how.verificationId ?? null,
        needs_review: recorded.memory.needs_review,
        note: how.note,
      },
      refs: [
        { kind: 'learning', id: p.proposal_id },
        { kind: 'task', id: p.task_id },
        { kind: 'memory', id: recorded.memory.memory_id },
      ],
    });
    return recorded;
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
