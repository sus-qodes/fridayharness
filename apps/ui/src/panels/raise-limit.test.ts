import type { AgentProcessesView, AgentProfile, EscalationView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeEscalation, makeSnapshot, makeTask } from '../test/fixtures.js';
import { capStopOf, dollars, limitError, proposedLimit, raiseLimitModal } from './raise-limit.js';
import { buttonBy, choose, controlBy, flush, HOSTILE, type } from './test-support.js';

const TASK = 'task_0000000000000000000000aa01';

const stopped = (over: Partial<EscalationView> = {}, details: Record<string, unknown> = {}): EscalationView =>
  makeEscalation({
    kind: 'recovery_needed',
    requested_by_kind: 'system',
    task_id: TASK,
    question: 'claude-1 stopped at its spending limit',
    options: [],
    details: {
      reason: 'budget_exceeded',
      scope: 'agent',
      agent_key: 'claude-1',
      cap_usd: 5,
      cost_usd: 5.03,
      ...details,
    },
    ...over,
  });

const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  agent_key: 'claude-1',
  host: 'claude-code',
  role: 'developer',
  options: { max_budget_usd: 5, effort: 'high', models: ['claude-sonnet-5-5'] },
  autostart: true,
  updated_at: 'x',
  ...over,
});
const remembered = (profiles: AgentProfile[]): AgentProcessesView => ({ processes: [], profiles });

const amount = (el: HTMLElement) => el.querySelector('.pn-limit-amount input') as HTMLInputElement;

function open(
  answers: Record<string, unknown>,
  escalations: EscalationView[] = [stopped()],
  summary = 'Add discount codes',
) {
  const ctx = makeContext({
    snapshot: makeSnapshot({ tasks: [makeTask({ task_id: TASK, summary })], escalations }),
    answers,
  });
  let closed = 0;
  const m = raiseLimitModal(ctx, { kind: 'raise-limit', id: TASK }, () => {
    closed += 1;
  });
  return { ctx, m, closed: () => closed };
}

describe('a stop at an agent’s spending limit', () => {
  it('is read from the question’s details, and from no other question', () => {
    expect(capStopOf(stopped())).toEqual({ taskId: TASK, agentKey: 'claude-1', capUsd: 5, costUsd: 5.03 });
    expect(capStopOf(stopped({}, { cost_usd: null, agent_key: '' }))).toMatchObject({ agentKey: null, costUsd: null });
    // The task's own cap, another recovery, another kind, a question without a task.
    expect(capStopOf(stopped({}, { scope: undefined }))).toBeNull();
    expect(capStopOf(stopped({}, { reason: 'agent_error' }))).toBeNull();
    expect(capStopOf(stopped({ kind: 'routing_blocked' }))).toBeNull();
    expect(capStopOf(stopped({ task_id: null }))).toBeNull();
  });

  it('proposes twice the limit reached, more than the attempt cost, within what is allowed', () => {
    expect(proposedLimit({ capUsd: 5, costUsd: 5.03 })).toBe(10);
    expect(proposedLimit({ capUsd: 0.5, costUsd: 0.52 })).toBe(1);
    expect(proposedLimit({ capUsd: 1, costUsd: 3.2 })).toBe(6.4);
    expect(proposedLimit({ capUsd: 800, costUsd: 801 })).toBe(1000);
    expect(proposedLimit({ capUsd: null, costUsd: null })).toBe(10);
    expect(dollars(5)).toBe('$5');
    expect(dollars(0.1 + 0.2)).toBe('$0.3');
  });

  it('takes an amount above the limit reached, and nothing else', () => {
    expect(limitError('10', { capUsd: 5 })).toBeNull();
    expect(limitError('5', { capUsd: 5 })).toBe('more than $5, the limit it reached');
    expect(limitError('4', { capUsd: 5 })).toContain('more than $5');
    expect(limitError('', { capUsd: 5 })).toBe('between 0.01 and 1000 dollars');
    expect(limitError('abc', { capUsd: 5 })).toBe('between 0.01 and 1000 dollars');
    expect(limitError('1001', { capUsd: 5 })).toBe('between 0.01 and 1000 dollars');
    expect(limitError('3', { capUsd: null })).toBeNull();
  });
});

describe('raise the limit and continue', () => {
  it('says what happened in a person’s words, saves the new limit and lets the task continue', async () => {
    const { ctx, m, closed } = open({
      'GET /agent-processes': remembered([profile()]),
      'POST /agent-processes/claude-1/update': { profile: profile(), running: true },
      [`POST /tasks/${TASK}/recover`]: { task: {}, preserved_ref: null },
    });
    expect(m.title).toBe('Raise the limit');
    expect(m.el.textContent).toContain(
      'claude-1 stopped “Add discount codes” at its spending limit of $5 per attempt. The attempt had cost $5.03. The work so far is kept: the next attempt continues from it.',
    );
    const go = buttonBy(m.el, 'Raise the limit and continue');
    // Nothing can be sent before Friday knows what it remembers of the agent.
    expect(go.disabled).toBe(true);
    await flush();
    expect(go.disabled).toBe(false);
    expect(controlBy<HTMLSelectElement>(m.el, 'New spending limit per attempt').value).toBe('set');
    expect(amount(m.el).value).toBe('10');
    // The same limit again would stop at the same place: said, and not sent.
    type(amount(m.el), '5');
    expect(m.el.textContent).toContain('more than $5, the limit it reached');
    expect(go.disabled).toBe(true);
    type(amount(m.el), '12.5');
    expect(go.disabled).toBe(false);
    go.click();
    await flush();
    expect(ctx.transport.to('POST', '/agent-processes/claude-1/update')[0]?.body).toEqual({
      // Only the limit changes: the effort and the models it was made with are kept.
      options: { max_budget_usd: 12.5, effort: 'high', models: ['claude-sonnet-5-5'] },
    });
    expect(ctx.transport.to('POST', `/tasks/${TASK}/recover`)[0]?.body).toEqual({
      action: 'reassign',
      reason: "the agent's spending limit per attempt was raised: a limit of $12.5",
    });
    // The limit first, the task after: a task continued at the old limit would stop again.
    const order = ctx.transport.calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/').at(-1));
    expect(order).toEqual(['update', 'recover']);
    expect(ctx.toasts.at(-1)).toEqual({
      kind: 'success',
      text: 'claude-1 now runs with a limit of $12.5; the task continues',
    });
    expect(closed()).toBe(1);
    m.destroy();
  });

  it('can remove the limit', async () => {
    const { ctx, m } = open({
      'GET /agent-processes': remembered([profile()]),
      'POST /agent-processes/claude-1/update': { profile: profile(), running: true },
      [`POST /tasks/${TASK}/recover`]: { task: {}, preserved_ref: null },
    });
    await flush();
    choose(controlBy<HTMLSelectElement>(m.el, 'New spending limit per attempt'), 'none');
    expect(amount(m.el).disabled).toBe(true);
    // A wrong amount left in the box does not hold back "No limit".
    buttonBy(m.el, 'Raise the limit and continue').click();
    await flush();
    expect(ctx.transport.to('POST', '/agent-processes/claude-1/update')[0]?.body).toMatchObject({
      options: { max_budget_usd: null },
    });
    expect(ctx.toasts.at(-1)?.text).toBe('claude-1 now runs with no limit; the task continues');
    m.destroy();
  });

  it('says so when the limit is saved and the task could not continue, and stays open', async () => {
    const { ctx, m, closed } = open({
      'GET /agent-processes': remembered([profile()]),
      'POST /agent-processes/claude-1/update': { profile: profile(), running: false },
      [`POST /tasks/${TASK}/recover`]: () => {
        throw new ApiError(409, 'COS-2002', 'conflict', `the task was cancelled ${HOSTILE}`);
      },
    });
    await flush();
    buttonBy(m.el, 'Raise the limit and continue').click();
    await flush();
    const error = m.el.querySelector('.pn-server-error') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe(
      `The new limit is saved, but the task could not continue: the task was cancelled ${HOSTILE}`,
    );
    expect(m.el.querySelector('img')).toBeNull();
    expect(ctx.toasts.at(-1)?.kind).toBe('error');
    expect(closed()).toBe(0);
    expect(buttonBy(m.el, 'Raise the limit and continue').disabled).toBe(false);
    m.destroy();
  });

  it('changes nothing and does not continue the task when the limit could not be saved', async () => {
    const { ctx, m, closed } = open({
      'GET /agent-processes': remembered([profile()]),
      'POST /agent-processes/claude-1/update': () => {
        throw new ApiError(400, 'COS-1001', 'invalid_request', 'option max_budget_usd is not valid for claude-code');
      },
    });
    await flush();
    buttonBy(m.el, 'Raise the limit and continue').click();
    await flush();
    expect(m.el.querySelector('.pn-server-error')?.textContent).toBe(
      'option max_budget_usd is not valid for claude-code',
    );
    expect(ctx.transport.to('POST', `/tasks/${TASK}/recover`)).toHaveLength(0);
    expect(closed()).toBe(0);
    m.destroy();
  });

  it('offers only to continue for an agent Friday did not start, and says why', async () => {
    const { ctx, m, closed } = open({
      // Remembered under the same key for another host: not the agent that stopped.
      'GET /agent-processes': remembered([profile({ host: 'codex', options: { sandbox: 'read-only' } })]),
      [`POST /tasks/${TASK}/recover`]: { task: {}, preserved_ref: null },
    });
    await flush();
    expect(m.el.textContent).toContain('claude-1 was not started from Friday');
    expect(m.el.textContent).toContain('Start it again with a higher limit, then let the task continue.');
    expect(m.el.querySelector('.pn-limit-amount')).toBeNull();
    buttonBy(m.el, 'Continue the task').click();
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path.includes('/update'))).toHaveLength(0);
    expect(ctx.transport.to('POST', `/tasks/${TASK}/recover`)[0]?.body).toEqual({
      action: 'reassign',
      reason: 'continued after a stop at the spending limit',
    });
    expect(closed()).toBe(1);
    m.destroy();
  });

  it('sends nothing while the agents cannot be read, and reads them again on request', async () => {
    let fail = true;
    const { ctx, m } = open({
      'GET /agent-processes': () => {
        if (fail) throw new ApiError(500, 'COS-5000', 'internal', 'boom');
        return remembered([profile()]);
      },
    });
    await flush();
    expect(m.el.textContent).toContain('Friday could not read its agents. Nothing was changed.');
    expect(buttonBy(m.el, 'Raise the limit and continue').disabled).toBe(true);
    fail = false;
    buttonBy(m.el, 'Try again').click();
    await flush();
    expect(amount(m.el).value).toBe('10');
    expect(buttonBy(m.el, 'Raise the limit and continue').disabled).toBe(false);
    expect(ctx.transport.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    m.destroy();
  });

  it('shows hostile names as text, and says when the task no longer waits at a limit', async () => {
    const hostile = open(
      { 'GET /agent-processes': remembered([]) },
      [stopped({}, { agent_key: `x${HOSTILE}` })],
      `Fix ${HOSTILE}`,
    );
    await flush();
    expect(hostile.m.el.textContent).toContain(`x${HOSTILE}`);
    expect(hostile.m.el.textContent).toContain(`Fix ${HOSTILE}`);
    expect(hostile.m.el.querySelector('img')).toBeNull();
    hostile.m.destroy();

    for (const escalations of [[], [stopped({ status: 'answered' })], [stopped({}, { scope: undefined })]]) {
      const gone = open({}, escalations);
      expect(gone.m.el.textContent).toContain('This task no longer waits at a spending limit.');
      expect(gone.m.el.querySelector('button')).toBeNull();
      expect(gone.ctx.transport.calls).toHaveLength(0);
      gone.m.destroy();
    }
  });
});
