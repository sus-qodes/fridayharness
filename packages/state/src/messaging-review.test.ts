/**
 * Regressions for the M3 review (docs/reviews/2026-10-14-m3-review.md, R01–R05): every entry
 * point applies the same authority, only an authorized response changes a request, only the
 * session that received a delivery acknowledges it, escalation and answer survive a failed
 * commit, and a resolved question stops asking for work.
 */
import { sequentialIds } from '@friday/core';
import { openDatabase, type SqlDatabase } from '@friday/db';
import { replay } from '@friday/events';
import {
  type Actor,
  CommunicationRequestParams,
  FridayError,
  HarnessRegisterParams,
  type TaskView,
} from '@friday/protocol';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Caller, DOMAIN_TABLES, FridayState, type PlanTaskInput, type StateConfig } from './index.js';

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

type Agent = Caller & { key: string };

function register(key: string, role: string, harnessKey = `fake:${key}`): Agent & { shadow: boolean } {
  const r = state.registerHarness(
    PROJECT,
    HarnessRegisterParams.parse({
      protocol_version: '1.0',
      harness_key: harnessKey,
      vendor: 'generic',
      name: key,
      attach_mode: 'spawn',
      project_id: PROJECT,
      capabilities: { task_start: true },
      agent: { agent_key: key, role },
    }),
  );
  return { harness_id: r.harness_id, agent_id: r.agent_id, key, shadow: r.shadow };
}

/** The harness accepts what it is given, like a FakeHarness. */
function accept(a: Agent): void {
  const msgs = state.pollOutbox(PROJECT, a.harness_id, 10);
  state.ackOutbox(
    PROJECT,
    a.harness_id,
    msgs.map((m) => ({ message_id: m.message_id, accepted: true, session_ref: 's' })),
  );
}

function work(a: Agent, summary: string, dependsOn: string[] = []): TaskView {
  const t = state.createTask(PROJECT, human, {
    summary,
    scope: { write: [`${summary}/**`], read: [] },
    depends_on: dependsOn,
    ready: true,
  });
  state.assignTask(PROJECT, human, t.task_id, a.key);
  accept(a);
  return state.q.task(PROJECT, t.task_id);
}

const planTask = (key: string, role: string, write: string): PlanTaskInput => ({
  key,
  change: 'new',
  task_id: null,
  kind: 'implementation',
  summary: `do ${key}`,
  description: null,
  acceptance_criteria: ['done'],
  depends_on: [],
  scope: { write: [write], read: [] },
  role,
  priority: 'normal',
  risk_level: 'low',
  note: null,
});

/** A goal whose plan has tasks for the given roles; returns the tasks by key. */
function goal(tasks: PlanTaskInput[]): Record<string, TaskView> {
  const g = state.createGoal(PROJECT, human, { request: 'A goal with parallel work', plan: false });
  const v = state.proposePlan(PROJECT, human, g.goal_id, {
    summary: 'parallel work',
    rationale: '',
    needs_human: null,
    trigger: 'test',
    tasks,
  });
  state.approvePlan(PROJECT, human, v.plan_id, v.version);
  return Object.fromEntries(state.q.goalTasks(PROJECT, g.goal_id).map((t) => [t.plan_key, t]));
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
  state.sendMessage(PROJECT, { kind: 'agent', caller: from }, { to, mode: 'request', content: `to ${to}`, ...extra });

describe('R01: one authority for direct, role and deferred addresses', () => {
  it('refuses an unrelated agent by role exactly as by name', () => {
    const a = register('a-1', 'backend');
    const b = register('b-1', 'frontend');
    work(a, 'alpha');
    work(b, 'beta');
    expect(code(() => send(a, 'b-1'))).toBe('COS-3000');
    expect(code(() => send(a, 'role:frontend'))).toBe('COS-3000');
    expect(state.q.messages(PROJECT)).toEqual([]);
  });

  it('refuses a role nobody related has, instead of waiting for any agent of that role', () => {
    const a = register('a-1', 'backend');
    work(a, 'alpha');
    expect(code(() => send(a, 'role:qa'))).toBe('COS-3000');
    // A qa agent arriving later with unrelated work never sees anything.
    const qa = register('qa-1', 'qa');
    work(qa, 'gamma');
    expect(state.inbox(PROJECT, qa).items).toEqual([]);
  });

  it('routes a role to a related task that nobody holds yet, and only its future holder receives it', () => {
    const be = register('be-1', 'backend');
    const tasks = goal([planTask('api', 'backend', 'backend/**'), planTask('tests', 'qa', 'tests/**')]);
    state.assignTask(PROJECT, human, tasks.api?.task_id as string, 'be-1');
    accept(be);
    const sent = send(be, 'role:qa', { subject: 'test data' });
    expect(sent.deliveries).toMatchObject([{ recipient: { kind: 'task', id: tasks.tests?.task_id } }]);
    // An unrelated qa agent cannot take it, also not by peeking.
    const stranger = register('qa-9', 'qa');
    work(stranger, 'unrelated');
    expect(state.inbox(PROJECT, stranger).items).toEqual([]);
    expect(state.peekInbox(PROJECT, stranger.agent_id).items).toEqual([]);
    // The agent that takes the related task gets it.
    const qa = register('qa-1', 'qa');
    state.assignTask(PROJECT, human, tasks.tests?.task_id as string, 'qa-1');
    accept(qa);
    expect(state.inbox(PROJECT, qa).items.map((i) => i.subject)).toEqual(['test data']);
  });

  it('lets a human reach any agent of a role', () => {
    const fe = register('fe-1', 'frontend');
    work(fe, 'beta');
    const m = state.sendMessage(
      PROJECT,
      { kind: 'human', actor: human },
      { to: 'role:frontend', mode: 'notification', content: 'hi' },
    );
    expect(m.deliveries).toMatchObject([{ recipient: { agent_key: 'fe-1' } }]);
  });
});

describe('R02: only an authorized response changes a request', () => {
  it('rejects response_to outside a response, in the schema and in the domain', () => {
    expect(
      CommunicationRequestParams.safeParse({ to: 'human', mode: 'notification', content: 'x', response_to: 'msg_1' })
        .success,
    ).toBe(false);
    const a = register('a-1', 'backend');
    const b = register('b-1', 'frontend');
    const c = register('c-1', 'qa');
    const api = work(a, 'alpha');
    work(b, 'beta', [api.task_id]);
    work(c, 'gamma');
    const req = send(b, 'a-1', { blocking: true });
    for (const mode of ['notification', 'request'] as const) {
      expect(
        code(() =>
          state.sendMessage(
            PROJECT,
            { kind: 'agent', caller: c },
            { to: 'human', mode, content: 'x', response_to: req.message_id },
          ),
        ),
      ).toBe('COS-1000');
    }
    expect(
      code(() =>
        state.sendMessage(
          PROJECT,
          { kind: 'agent', caller: c },
          { to: 'b-1', mode: 'response', content: 'x', response_to: req.message_id },
        ),
      ),
    ).toBe('COS-3000');
    expect(state.q.message(req.message_id)).toMatchObject({ status: 'open', deliveries: [{ state: 'queued' }] });
    // The recipient's answer settles it; so does a human's.
    state.inbox(PROJECT, a);
    state.sendMessage(
      PROJECT,
      { kind: 'agent', caller: a },
      { to: 'b-1', mode: 'response', content: 'ok', response_to: req.message_id },
    );
    expect(state.q.message(req.message_id)).toMatchObject({ status: 'settled', settled_reason: 'replied' });
  });
});

describe('R03: only the session that received a delivery acknowledges it', () => {
  it('refuses a shadow session, and makes a successor receive before it acknowledges', () => {
    const a = register('a-1', 'backend');
    const b = register('b-1', 'frontend');
    const api = work(a, 'alpha');
    work(b, 'beta', [api.task_id]);
    send(b, 'a-1');
    const delivery = state.inbox(PROJECT, a).items[0]?.delivery_id as string;
    const shadow = register('a-1', 'backend', 'fake:a-1:shadow');
    expect(shadow.shadow).toBe(true);
    expect(code(() => state.acknowledgeMessages(PROJECT, shadow, [delivery]))).toBe('COS-4006');
    expect(state.q.findDelivery(delivery)?.state).toBe('delivered');
    // The first session ends; its successor has not received the message yet.
    state.disconnectHarness(PROJECT, a.harness_id, 'restart', true);
    state.disconnectHarness(PROJECT, shadow.harness_id, 'restart', true);
    const next = register('a-1', 'backend', 'fake:a-1:new');
    expect(state.acknowledgeMessages(PROJECT, next, [delivery])).toMatchObject({
      acknowledged: [],
      refused: [delivery],
    });
    // Its first read takes the delivery over (attempt 2, recorded), then it may acknowledge.
    expect(state.inbox(PROJECT, next).items[0]).toMatchObject({ delivery_id: delivery, attempt: 2 });
    expect(state.acknowledgeMessages(PROJECT, next, [delivery])).toMatchObject({
      acknowledged: [delivery],
      refused: [],
    });
  });
});

/** Fails the next projection of an event type once, as a crash inside a command would. */
function failOnce(type: string): void {
  const apply = state.projector.apply.bind(state.projector);
  let armed = true;
  state.projector.apply = (e) => {
    if (armed && e.type === type) {
      armed = false;
      throw new Error(`injected failure at ${type}`);
    }
    apply(e);
  };
}

describe('R04: deadline escalation and its answer survive a failed commit', () => {
  function overdue() {
    const a = register('a-1', 'backend');
    const b = register('b-1', 'frontend');
    const api = work(a, 'alpha');
    work(b, 'beta', [api.task_id]);
    const req = send(b, 'a-1', { subject: 'currency', blocking: true, reply_within_s: 60 });
    clock.advance(60_001);
    state.heartbeat(PROJECT, a.harness_id);
    state.heartbeat(PROJECT, b.harness_id);
    return { a, b, req };
  }

  it('creates exactly one escalation when marking the request fails and the tick runs again', () => {
    const { req } = overdue();
    failOnce('communication.escalated');
    expect(() => state.tick(PROJECT)).toThrow(/injected/);
    state.tick(PROJECT);
    state.tick(PROJECT);
    const pending = state.q.escalations(PROJECT, 'pending').filter((e) => e.kind === 'unanswered_request');
    expect(pending).toHaveLength(1);
    expect(state.q.message(req.message_id).status).toBe('open');
  });

  it('records the answer and the reply together, or neither', () => {
    const { b, req } = overdue();
    state.tick(PROJECT);
    const esc = state.q.escalations(PROJECT, 'pending').find((e) => e.kind === 'unanswered_request');
    failOnce('communication.sent');
    expect(() => state.answerEscalation(PROJECT, human, String(esc?.escalation_id), 'Use ISO codes.')).toThrow(
      /injected/,
    );
    expect(state.q.escalation(String(esc?.escalation_id))?.status).toBe('pending');
    state.answerEscalation(PROJECT, human, String(esc?.escalation_id), 'Use ISO codes.');
    expect(state.q.message(req.message_id)).toMatchObject({ status: 'settled', settled_reason: 'replied' });
    expect(
      state
        .inbox(PROJECT, b)
        .items.filter((i) => i.mode === 'response')
        .map((i) => i.body),
    ).toEqual(['Use ISO codes.']);
  });

  it('sends a reply that an older daemon recorded as answered but never delivered', () => {
    const { b, req } = overdue();
    state.tick(PROJECT);
    const esc = state.q.escalations(PROJECT, 'pending').find((e) => e.kind === 'unanswered_request');
    // What a crash between the two commits of the old implementation left behind.
    state.bus.execute({ name: 'escalation.answer', project_id: PROJECT, actor: human }, (ctx) => {
      ctx.emit({
        type: 'escalation.answered',
        payload: { escalation_id: esc?.escalation_id, answer: 'Late, but here.' },
        refs: [{ kind: 'escalation', id: String(esc?.escalation_id) }],
      });
    });
    expect(state.q.message(req.message_id).status).toBe('open');
    state.tick(PROJECT);
    state.tick(PROJECT);
    expect(state.q.message(req.message_id).status).toBe('settled');
    expect(
      state
        .inbox(PROJECT, b)
        .items.filter((i) => i.mode === 'response')
        .map((i) => i.body),
    ).toEqual(['Late, but here.']);
  });
});

describe('R05: a resolved question stops asking for work', () => {
  it('ends the other deliveries of an answered request, and tells only those who saw it', () => {
    const be = register('be-1', 'backend');
    const fe = register('fe-1', 'frontend');
    const qa = register('qa-1', 'qa');
    const api = work(be, 'alpha');
    work(fe, 'beta', [api.task_id]);
    work(qa, 'gamma', [api.task_id]);
    // be-1 asks both dependents; fe-1 reads it, qa-1 does not.
    const req = send(be, 'dependents', { subject: 'schema change ok?', blocking: true, priority: 'urgent' });
    expect(req.deliveries).toHaveLength(2);
    expect(state.inbox(PROJECT, fe).items).toHaveLength(1);
    // A human answers for them.
    state.sendMessage(
      PROJECT,
      { kind: 'human', actor: human },
      { to: 'be-1', mode: 'response', content: 'Yes.', response_to: req.message_id },
    );
    expect(state.q.message(req.message_id).deliveries.map((d) => [d.agent_key, d.state])).toEqual([
      ['fe-1', 'resolved'],
      ['qa-1', 'resolved'],
    ]);
    // qa-1 never saw the question: nothing waits for it. fe-1 saw it: it learns it is resolved.
    expect(state.peekInbox(PROJECT, qa.agent_id).items).toEqual([]);
    const notice = state.inbox(PROJECT, fe).items;
    expect(notice).toMatchObject([
      {
        mode: 'notification',
        priority: 'low',
        blocking: false,
        trust: 'system',
        subject: 'Resolved: schema change ok?',
      },
    ]);
    expect(notice[0]?.body).toContain('was answered by a human');
    // Replay rebuilds the same lifecycle.
    const dump = () =>
      Object.fromEntries(DOMAIN_TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]));
    const before = dump();
    replay(db, state.store, PROJECT, state.projector);
    expect(dump()).toEqual(before);
  });

  it('does the same when one of the recipients answers', () => {
    const be = register('be-1', 'backend');
    const fe = register('fe-1', 'frontend');
    const qa = register('qa-1', 'qa');
    const api = work(be, 'alpha');
    work(fe, 'beta', [api.task_id]);
    work(qa, 'gamma', [api.task_id]);
    const req = send(be, 'dependents', { subject: 'schema change ok?', blocking: true });
    const asked = state.inbox(PROJECT, fe).items[0];
    state.inbox(PROJECT, qa);
    state.sendMessage(
      PROJECT,
      { kind: 'agent', caller: fe },
      { to: 'be-1', mode: 'response', content: 'Fine by me.', response_to: asked?.message_id as string },
    );
    // The answer acknowledges fe-1's own delivery; qa-1 had read it too, so it gets the notice.
    expect(state.q.message(req.message_id)).toMatchObject({ status: 'settled', settled_reason: 'replied' });
    expect(state.q.message(req.message_id).deliveries.map((d) => [d.agent_key, d.state])).toEqual([
      ['fe-1', 'acknowledged'],
      ['qa-1', 'resolved'],
    ]);
    const notice = state.inbox(PROJECT, qa).items;
    expect(notice).toMatchObject([{ subject: 'Resolved: schema change ok?', trust: 'system' }]);
    expect(notice[0]?.body).toContain('was answered by fe-1');
    expect(state.peekInbox(PROJECT, fe.agent_id).items).toEqual([]);
  });
});
