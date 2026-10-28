/**
 * Agent messaging (plan M3a, ADR-0017): the communication authority, recipient resolution, the
 * acknowledgement ladder per delivery, redelivery and dead letters, and replay.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import { type Actor, FridayError, HarnessRegisterParams, type TaskView } from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, DOMAIN_TABLES, FridayState, type StateConfig } from './index.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };

let db: SqlDatabase;
let clock: FakeClock;
let state: FridayState;

function boot(config: Partial<StateConfig> = {}) {
  db = openDatabase(':memory:');
  clock = new FakeClock('2026-10-14T10:00:00.000Z');
  state = new FridayState({ db, clock, ids: sequentialIds(), config });
  state.ensureProject({ project_id: PROJECT, name: 'shop', root_path: 'C:/demo/shop' });
}
beforeEach(() => boot());

/** A spawn-mode agent that accepts what it is given, like a FakeHarness. */
function agent(key: string, role = 'developer'): Caller & { key: string } {
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: `fake:${key}`,
      vendor: 'generic',
      name: key,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: key, role },
    }),
  );
  return { harness_id: r.harness_id, agent_id: r.agent_id, key };
}

/** Creates a task and has `a` start it. */
function work(a: Caller & { key: string }, summary: string, dependsOn: string[] = []): TaskView {
  const t = state.createTask(PROJECT, human, {
    summary,
    scope: { write: [`${summary}/**`], read: [] },
    depends_on: dependsOn,
    ready: true,
  });
  state.assignTask(PROJECT, human, t.task_id, a.key);
  const msgs = state.pollOutbox(PROJECT, a.harness_id, 10);
  state.ackOutbox(
    PROJECT,
    a.harness_id,
    msgs.map((m) => ({ message_id: m.message_id, accepted: true, session_ref: 'fake' })),
  );
  return state.q.task(PROJECT, t.task_id);
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    return (e as FridayError).code;
  }
  throw new Error('expected an error');
}

const send = (from: Caller, to: string, extra: Record<string, unknown> = {}) =>
  state.sendMessage(
    PROJECT,
    { kind: 'agent', caller: from },
    {
      to,
      mode: 'request',
      content: `hello ${to}`,
      ...extra,
    },
  );

describe('request and reply between related agents', () => {
  it('routes, delivers, answers with the same correlation, and settles', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);

    const req = send(fe, 'be-1', {
      subject: 'checkout contract',
      content: 'Does POST /checkout return currency?',
      facts: [{ fact: 'the checkout response has no currency', area: 'api' }],
      blocking: true,
    });
    expect(req.deliveries).toMatchObject([{ recipient: { kind: 'agent', agent_key: 'be-1' } }]);
    expect(state.q.message(req.message_id)).toMatchObject({
      status: 'open',
      blocking: true,
      reply_by: expect.any(String),
    });

    // The backend reads its inbox: the message is reserved and counted as delivery 1.
    const inbox = state.inbox(PROJECT, be);
    expect(inbox.items).toMatchObject([
      {
        message_id: req.message_id,
        mode: 'request',
        trust: 'peer-untrusted',
        attempt: 1,
        from: { agent_key: 'fe-1', role: 'frontend' },
        relationship: expect.stringContaining('depends on your task'),
        facts: [{ fact: 'the checkout response has no currency', status: 'unverified', source: 'fe-1' }],
      },
    ]);
    // Reading again inside the reservation returns it without a new attempt or event.
    const head = state.store.head(PROJECT);
    expect(state.inbox(PROJECT, be).items[0]?.attempt).toBe(1);
    expect(state.store.head(PROJECT)).toBe(head);

    // The answer goes back to the sender whatever "to" says, shares the correlation, and settles the request.
    const reply = state.sendMessage(
      PROJECT,
      { kind: 'agent', caller: be },
      {
        to: 'anyone',
        mode: 'response',
        response_to: req.message_id,
        content: 'Yes: { amount, currency }.',
      },
    );
    expect(reply.correlation_id).toBe(req.correlation_id);
    expect(reply.deliveries).toMatchObject([{ recipient: { agent_key: 'fe-1' } }]);
    expect(state.q.message(req.message_id)).toMatchObject({ status: 'settled', settled_reason: 'replied' });
    expect(state.q.message(req.message_id).deliveries[0]).toMatchObject({ state: 'acknowledged' });

    const answer = state.inbox(PROJECT, fe).items[0];
    expect(answer).toMatchObject({
      mode: 'response',
      in_reply_to: 'checkout contract',
      correlation_id: req.correlation_id,
    });
    expect(state.acknowledgeMessages(PROJECT, fe, [answer?.delivery_id as string])).toEqual({
      acknowledged: [answer?.delivery_id],
      unknown: [],
      refused: [],
    });
    expect(state.q.message(reply.message_id)).toMatchObject({ status: 'settled', settled_reason: 'acknowledged' });
    // Both sides of the exchange share the correlation id on the event envelope.
    const corr = state.store.readByCorrelation(PROJECT, req.correlation_id).map((e) => e.type);
    expect(corr).toEqual(expect.arrayContaining(['communication.sent', 'communication.settled']));
  });
});

describe('communication authority', () => {
  it('refuses unrelated agents, self-messages, broadcast by default, and taskless senders', () => {
    const a = agent('a-1', 'backend');
    const b = agent('b-1', 'frontend');
    work(a, 'alpha');
    work(b, 'beta'); // no shared goal, no dependency
    expect(code(() => send(a, 'b-1'))).toBe('COS-3000');
    expect(code(() => send(a, 'a-1'))).toBe('COS-1000');
    expect(code(() => send(a, 'broadcast'))).toBe('COS-3000');
    expect(code(() => send(a, 'nobody'))).toBe('COS-2003');
    const idle = agent('idle-1');
    expect(code(() => send(idle, 'role:frontend'))).toBe('COS-3000');
    // master and human are always reachable; a request to master also reaches a human.
    expect(send(idle, 'master').deliveries.map((d) => d.recipient.kind)).toEqual(['master_brain', 'human']);
    expect(send(idle, 'human', { mode: 'notification' }).deliveries.map((d) => d.recipient.kind)).toEqual(['human']);
  });

  it('lets an agent answer only messages it received', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const qa = agent('qa-1', 'qa');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    work(qa, 'tests', [api.task_id]);
    const req = send(fe, 'be-1');
    expect(
      code(() =>
        state.sendMessage(
          PROJECT,
          { kind: 'agent', caller: qa },
          {
            to: 'fe-1',
            mode: 'response',
            response_to: req.message_id,
            content: 'not mine to answer',
          },
        ),
      ),
    ).toBe('COS-3000');
  });

  it('broadcasts to the goal only when the project allows it', () => {
    boot({ allowBroadcast: true });
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    // Tasks outside a goal have no goal to broadcast to.
    expect(code(() => send(be, 'broadcast'))).toBe('COS-2003');
  });

  it("never acknowledges another agent's delivery", () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    const req = send(fe, 'be-1');
    const delivery = req.deliveries[0]?.delivery_id as string;
    expect(state.acknowledgeMessages(PROJECT, fe, [delivery, req.message_id, 'dlv_missing'])).toEqual({
      acknowledged: [],
      unknown: ['dlv_missing'],
      refused: [delivery, req.message_id],
    });
    expect(state.q.message(req.message_id).deliveries[0]?.state).toBe('queued');
  });
});

describe('recipient resolution', () => {
  it('turns a role into the best-fit related agent, and waits for a role nobody has yet', () => {
    const be = agent('be-1', 'backend');
    const fe1 = agent('fe-1', 'frontend');
    const fe2 = agent('fe-2', 'frontend');
    const api = work(be, 'backend');
    work(fe2, 'frontend', [api.task_id]); // fe-2 is related, fe-1 is not
    expect(send(be, 'role:frontend')).toMatchObject({
      deliveries: [{ recipient: { kind: 'agent', agent_key: 'fe-2' } }],
      note: 'role:frontend reached fe-2',
    });
    expect(fe1).toBeTruthy();
    const qaWait = send(be, 'role:qa');
    expect(qaWait.deliveries).toMatchObject([{ recipient: { kind: 'role', id: 'qa', agent_key: null } }]);
    // The first qa agent to read its inbox takes it.
    const qa = agent('qa-1', 'qa');
    expect(state.inbox(PROJECT, qa).items.map((i) => i.message_id)).toEqual([qaWait.message_id]);
    expect(state.q.message(qaWait.message_id).deliveries[0]).toMatchObject({ agent_key: 'qa-1', state: 'delivered' });
    const qa2 = agent('qa-2', 'qa');
    expect(state.inbox(PROJECT, qa2).items).toEqual([]);
  });

  it('reaches the agents of dependencies and dependents, and a task nobody holds yet', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    const page = work(fe, 'frontend', [api.task_id]);
    expect(send(fe, 'dependencies').deliveries.map((d) => d.recipient.agent_key)).toEqual(['be-1']);
    expect(send(be, 'dependents').deliveries.map((d) => d.recipient.agent_key)).toEqual(['fe-1']);
    const later = state.createTask(PROJECT, human, { summary: 'docs', depends_on: [page.task_id] });
    const toTask = send(fe, `task:${later.task_id}`);
    expect(toTask).toMatchObject({ deliveries: [{ recipient: { kind: 'task', id: later.task_id } }] });
    expect(toTask.note).toContain('whoever takes it');
  });
});

describe('delivery under failure', () => {
  it('delivers again after the reservation ends, then dead-letters', () => {
    boot({ messageReservationMs: 60_000, messageMaxAttempts: 2 });
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    const req = send(fe, 'be-1', { mode: 'notification' });
    expect(state.inbox(PROJECT, be).items[0]?.attempt).toBe(1);
    clock.advance(60_001);
    expect(state.inbox(PROJECT, be).items[0]?.attempt).toBe(2);
    clock.advance(60_001);
    expect(state.inbox(PROJECT, be).items).toEqual([]);
    expect(state.q.message(req.message_id)).toMatchObject({
      status: 'settled',
      settled_reason: 'ended',
      deliveries: [{ state: 'dead', attempts: 2, end_reason: 'delivered 2 times without an acknowledgement' }],
    });
  });

  it('keeps a delivery reserved for the session that read it, and lets a restarted session have it later', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    send(fe, 'be-1');
    expect(state.inbox(PROJECT, be).items).toHaveLength(1);
    const session = (key: string) => {
      const r = state.registerHarness(
        PROJECT,
        HarnessRegisterParams.parse({
          protocol_version: '1.0',
          harness_key: key,
          vendor: 'generic',
          name: 'be-1',
          attach_mode: 'spawn',
          project_id: PROJECT,
          agent: { agent_key: 'be-1', role: 'backend' },
        }),
      );
      return { shadow: r.shadow, caller: { harness_id: r.harness_id, agent_id: r.agent_id } };
    };
    // A second live session for the same agent is a shadow and cannot take its messages.
    const shadow = session('fake:be-1:shadow');
    expect(shadow.shadow).toBe(true);
    expect(code(() => state.inbox(PROJECT, shadow.caller))).toBe('COS-4006');
    // The real session ends and a new one starts: the old reservation still holds for a while.
    state.disconnectHarness(PROJECT, be.harness_id, 'restart', true);
    state.disconnectHarness(PROJECT, shadow.caller.harness_id, 'restart', true);
    const next = session('fake:be-1:new');
    expect(next.shadow).toBe(false);
    expect(state.inbox(PROJECT, next.caller).items).toEqual([]);
    clock.advance(state.config.messageReservationMs + 1);
    expect(state.inbox(PROJECT, next.caller).items[0]?.attempt).toBe(2);
  });

  it('returns the first result for a retried send with the same idempotency key', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    const input = { to: 'be-1', mode: 'notification' as const, content: 'once' };
    const a = state.sendMessage(PROJECT, { kind: 'agent', caller: fe }, input, { idempotency_key: 'k1' });
    const b = state.sendMessage(PROJECT, { kind: 'agent', caller: fe }, input, { idempotency_key: 'k1' });
    expect(b.message_id).toBe(a.message_id);
    expect(state.q.messages(PROJECT)).toHaveLength(1);
  });
});

describe('humans and the Master Brain', () => {
  it('lets a human message anyone and answer what reached humans', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    work(be, 'backend');
    work(fe, 'frontend');
    const fromHuman = state.sendMessage(
      PROJECT,
      { kind: 'human', actor: human },
      {
        to: 'role:frontend',
        mode: 'notification',
        content: 'Prices include VAT.',
      },
    );
    expect(state.inbox(PROJECT, fe).items[0]).toMatchObject({ message_id: fromHuman.message_id, trust: 'human' });
    const ask = send(fe, 'human', { content: 'May I change the checkout API?' });
    const open = state.q.openDeliveriesFor(PROJECT, 'human');
    expect(open.map((d) => d.message_id)).toEqual([ask.message_id]);
    state.sendMessage(
      PROJECT,
      { kind: 'human', actor: human },
      {
        to: 'fe-1',
        mode: 'response',
        response_to: ask.message_id,
        content: 'No; ask the backend agent.',
      },
    );
    expect(state.q.message(ask.message_id)).toMatchObject({ status: 'settled', settled_reason: 'replied' });
    expect(state.q.openDeliveriesFor(PROJECT, 'human')).toEqual([]);
  });

  it('stores long bodies outside the event and keeps the event small', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    const m = send(fe, 'be-1', { content: 'x'.repeat(20_000) });
    const view = state.q.message(m.message_id);
    expect(view.body.length).toBeLessThan(8_100);
    expect(view.body).toContain('more characters');
  });
});

describe('replay', () => {
  it('rebuilds messages and deliveries exactly', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    const req = send(fe, 'be-1', { facts: [{ fact: 'f1' }] });
    state.inbox(PROJECT, be);
    state.sendMessage(
      PROJECT,
      { kind: 'agent', caller: be },
      {
        to: 'fe-1',
        mode: 'response',
        response_to: req.message_id,
        content: 'done',
      },
    );
    const answer = state.inbox(PROJECT, fe).items[0]?.delivery_id as string;
    state.acknowledgeMessages(PROJECT, fe, [answer]);
    send(fe, 'role:qa', { mode: 'notification' });
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });
});

describe('timeouts, backpressure and offline recipients (M3b)', () => {
  it('expires what nobody acknowledged in time, visibly', () => {
    boot({ messageTtlMs: 60 * 60 * 1000 });
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    const m = send(fe, 'be-1', { mode: 'notification' });
    clock.advance(60 * 60 * 1000 + 1);
    state.heartbeat(PROJECT, be.harness_id);
    state.heartbeat(PROJECT, fe.harness_id);
    expect(state.tick(PROJECT).messages_expired).toEqual([m.message_id]);
    expect(state.q.message(m.message_id)).toMatchObject({ status: 'expired', deliveries: [{ state: 'expired' }] });
    expect(state.inbox(PROJECT, be).items).toEqual([]);
  });

  it('escalates an unanswered blocking request once, and turns the human answer into the reply', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    const req = send(fe, 'be-1', { subject: 'currency', blocking: true, reply_within_s: 600 });
    clock.advance(600_001);
    state.heartbeat(PROJECT, be.harness_id);
    state.heartbeat(PROJECT, fe.harness_id);
    expect(state.tick(PROJECT).messages_escalated).toEqual([req.message_id]);
    expect(state.tick(PROJECT).messages_escalated).toEqual([]);
    const esc = state.q.escalations(PROJECT, 'pending').find((e) => e.kind === 'unanswered_request');
    expect(esc?.question).toContain('fe-1 is waiting for an answer from be-1 to "currency"');
    expect(state.q.message(req.message_id).status).toBe('open');
    state.answerEscalation(PROJECT, human, String(esc?.escalation_id), 'Yes, with ISO-4217 codes.');
    expect(state.q.message(req.message_id)).toMatchObject({ status: 'settled', settled_reason: 'replied' });
    expect(state.inbox(PROJECT, fe).items[0]).toMatchObject({
      trust: 'human',
      mode: 'response',
      in_reply_to: 'currency',
    });
  });

  it('refuses low and normal notifications to a full inbox, but not what matters', () => {
    boot({ maxOpenPerRecipient: 2 });
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    send(fe, 'be-1', { mode: 'notification' });
    send(fe, 'be-1', { mode: 'notification' });
    expect(code(() => send(fe, 'be-1', { mode: 'notification' }))).toBe('COS-2005');
    expect(send(fe, 'be-1', { mode: 'notification', priority: 'high' }).deliveries).toHaveLength(1);
    expect(send(fe, 'be-1', { mode: 'request' }).deliveries).toHaveLength(1);
  });

  it('says when a recipient is offline, and keeps the message for it', () => {
    const be = agent('be-1', 'backend');
    const fe = agent('fe-1', 'frontend');
    const api = work(be, 'backend');
    work(fe, 'frontend', [api.task_id]);
    clock.advance(state.config.leaseTtlMs + 1);
    state.heartbeat(PROJECT, fe.harness_id);
    state.tick(PROJECT);
    const m = send(fe, 'be-1', { mode: 'notification' });
    expect(m.note).toContain('be-1 is not attached right now');
    expect(state.q.message(m.message_id).deliveries[0]?.state).toBe('queued');
  });

  it('keeps durable consumer cursors in event_consumers', () => {
    state.setBrainCursor(PROJECT, 7);
    state.setConsumerCursor(PROJECT, 'audit-export', 3);
    expect(state.q.brainCursor(PROJECT)).toBe(7);
    expect(state.q.consumerCursor(PROJECT, 'audit-export')).toBe(3);
    expect(state.q.consumerCursor(PROJECT, 'unknown')).toBe(0);
  });
});
