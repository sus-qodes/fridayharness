import type { UiSnapshot } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realTimers } from '../notch/island-fsm.js';
import { makeContext, type TestContext } from '../test/context.js';
import {
  makeApproval,
  makeEscalation,
  makeGoal,
  makeInboxItem,
  makePlan,
  makeScenario,
  makeSnapshot,
  makeTask,
} from '../test/fixtures.js';
import {
  baseTitle,
  diffNotices,
  MAX_PER_UPDATE,
  type NotificationCtor,
  type NotifierEnv,
  pageTitle,
  remember,
  startNotifier,
  startNotifierWith,
} from './notifier.js';

const NOW = Date.parse('2026-10-17T10:00:00.000Z');
const HOSTILE = '<img src=x onerror=alert(1)>';

interface Shown {
  title: string;
  options: NotificationOptions | undefined;
  closed: boolean;
  onclick: ((this: never, ev: Event) => unknown) | null;
  close(): void;
}

function fakeEnv(
  opts: { permission?: NotificationPermission; visibility?: DocumentVisibilityState; throws?: boolean } = {},
) {
  const shown: Shown[] = [];
  let permission: NotificationPermission = opts.permission ?? 'granted';
  class FakeNotification {
    onclick: ((this: never, ev: Event) => unknown) | null = null;
    closed = false;
    constructor(
      readonly title: string,
      readonly options?: NotificationOptions,
    ) {
      if (opts.throws) throw new TypeError('Illegal constructor');
      shown.push(this as unknown as Shown);
    }
    static get permission(): NotificationPermission {
      return permission;
    }
    close(): void {
      this.closed = true;
    }
  }
  const target = new EventTarget();
  const doc = {
    title: 'Friday Studio',
    visibilityState: opts.visibility ?? ('hidden' as DocumentVisibilityState),
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const focusWindow = vi.fn();
  const env: NotifierEnv = {
    Notification: FakeNotification as unknown as NotificationCtor,
    document: doc as unknown as NotifierEnv['document'],
    focusWindow,
    timers: realTimers,
  };
  return {
    env,
    shown,
    doc,
    focusWindow,
    setPermission: (p: NotificationPermission) => {
      permission = p;
    },
    setVisibility: (v: DocumentVisibilityState) => {
      doc.visibilityState = v;
      target.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

function ctxWith(snapshot: UiSnapshot = makeSnapshot(), notifications = true): TestContext {
  const ctx = makeContext({ snapshot });
  ctx.store.patch('prefs', { notifications });
  return ctx;
}

let stops: (() => void)[] = [];

function start(ctx: TestContext, env: NotifierEnv, opts: { title?: string } = {}): () => void {
  const stop = startNotifierWith(ctx, opts, env);
  stops.push(stop);
  return stop;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

describe('the title badge (plan §7.1)', () => {
  it('formats the count and the base', () => {
    expect(pageTitle('Friday — shop', 0)).toBe('Friday — shop');
    expect(pageTitle('Friday — shop', 3)).toBe('(3) Friday — shop');
    expect(baseTitle(null)).toBe('Friday');
    expect(baseTitle(makeSnapshot())).toBe('Friday — shop');
    expect(baseTitle(makeSnapshot(), 'Friday Notch')).toBe('Friday Notch');
    const hostile = makeSnapshot({ project: { ...makeSnapshot().project, name: `a‮${'x'.repeat(5000)}` } });
    expect(baseTitle(hostile)).not.toContain('‮');
    expect(baseTitle(hostile).length).toBeLessThanOrEqual(70);
  });

  it('counts approvals, questions and blocked agents waiting, and keeps it current', () => {
    const f = fakeEnv();
    const ctx = ctxWith(makeScenario());
    start(ctx, f.env);
    expect(f.doc.title).toBe('(3) Friday — shop');
    ctx.board(makeSnapshot());
    expect(f.doc.title).toBe('Friday — shop');
  });

  it('uses the title option as the base', () => {
    const f = fakeEnv();
    const ctx = ctxWith(makeSnapshot({ escalations: [makeEscalation()] }));
    start(ctx, f.env, { title: 'Friday Notch' });
    expect(f.doc.title).toBe('(1) Friday Notch');
  });

  it('drops an approval from the count when it expires', () => {
    const f = fakeEnv();
    const ctx = ctxWith(makeSnapshot({ approvals: [makeApproval({ expires_at: '2026-10-17T10:00:30.000Z' })] }));
    start(ctx, f.env);
    expect(f.doc.title).toBe('(1) Friday — shop');
    ctx.clock.now += 31_000;
    vi.advanceTimersByTime(31_000);
    expect(f.doc.title).toBe('Friday — shop');
  });

  it('restores the previous title and stops listening when stopped', () => {
    const f = fakeEnv();
    const ctx = ctxWith(makeScenario());
    const stop = start(ctx, f.env);
    stop();
    expect(f.doc.title).toBe('Friday Studio');
    ctx.board(makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_x' })] }));
    expect(f.doc.title).toBe('Friday Studio');
    expect(f.shown).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('starts against the real browser globals', () => {
    const ctx = ctxWith(makeScenario(), false);
    const before = document.title;
    const stop = startNotifier(ctx);
    expect(document.title).toBe('(3) Friday — shop');
    stop();
    expect(document.title).toBe(before);
  });
});

describe('notifications (plan FD-25)', () => {
  it('announces a new approval once, not the items present at the start', () => {
    const f = fakeEnv();
    const ctx = ctxWith(makeScenario());
    start(ctx, f.env);
    expect(f.shown).toHaveLength(0);
    const next = {
      ...makeScenario(),
      approvals: [...makeScenario().approvals, makeApproval({ approval_id: 'apr_2' })],
    };
    ctx.board(next);
    ctx.board({ ...next });
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0]?.title).toBe('Approval needed — Friday — shop');
    expect(f.shown[0]?.options).toMatchObject({
      body: 'shell.git.commit: git commit -m "pricing"',
      tag: 'approval:apr_2',
    });
  });

  it('seeds from the first board when it arrives after the start', () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    ctx.store.setState({ board: null });
    start(ctx, f.env);
    expect(f.doc.title).toBe('Friday');
    ctx.board(makeScenario());
    expect(f.shown).toHaveLength(0);
    expect(f.doc.title).toBe('(3) Friday — shop');
  });

  it('shows nothing unless the setting is on, permission granted and the tab hidden — but still marks items seen', () => {
    for (const setup of [
      { notifications: false },
      { permission: 'denied' as const },
      { permission: 'default' as const },
      { visibility: 'visible' as const },
    ]) {
      const f = fakeEnv(setup);
      const ctx = ctxWith(makeSnapshot(), setup.notifications ?? true);
      const stop = start(ctx, f.env);
      // An approval and a message awaiting a reply: the one gate holds both back.
      const board = makeSnapshot({ approvals: [makeApproval()], inbox: [makeInboxItem({ mode: 'request' })] });
      ctx.board(board);
      expect(f.shown).toHaveLength(0);
      // Allowed later: the items already seen are not announced.
      ctx.store.patch('prefs', { notifications: true });
      f.setPermission('granted');
      f.doc.visibilityState = 'hidden';
      ctx.board({ ...board });
      expect(f.shown).toHaveLength(0);
      stop();
    }
  });

  it('announces questions, proposed plans, blocked agents, failures and lost agents', () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    start(ctx, f.env);
    const goal = makeGoal();
    ctx.board(
      makeSnapshot({
        goals: [goal],
        escalations: [makeEscalation({ question: `Stack? ${HOSTILE}` })],
        plans: { [goal.goal_id]: { active: null, proposed: makePlan({ status: 'PROPOSED' }) } },
        tasks: [
          makeTask({
            task_id: 'tb',
            status: 'WAITING',
            waiting_reason: 'blocked',
            agent_key: 'codex-1',
            waiting_note: 'Which names?',
          }),
          makeTask({ task_id: 'tf', status: 'FAILED', summary: 'Broken build' }),
          makeTask({ task_id: 'tl', status: 'HARNESS_LOST', summary: 'Lost one' }),
        ],
      }),
    );
    // Five notices, three shown, one summary.
    expect(f.shown.map((n) => n.title)).toEqual([
      'A question for you — Friday — shop',
      'A plan waits for your review — Friday — shop',
      'An agent is blocked — Friday — shop',
      'Friday — shop: 2 more items need you',
    ]);
    expect(f.shown[0]?.options?.body).toBe(`Stack? ${HOSTILE}`);
    expect(f.shown[2]?.options?.body).toBe('codex-1: Which names?');
  });

  it('announces a task each time it fails again, and an agent blocking again', () => {
    const memory = remember(makeSnapshot(), NOW);
    const failed = makeSnapshot({ tasks: [makeTask({ task_id: 't', status: 'FAILED' })] });
    expect(diffNotices(memory, failed, NOW).map((n) => n.title)).toEqual(['A task failed']);
    expect(diffNotices(memory, failed, NOW)).toEqual([]);
    diffNotices(memory, makeSnapshot({ tasks: [makeTask({ task_id: 't', status: 'REWORK' })] }), NOW);
    expect(diffNotices(memory, failed, NOW)).toHaveLength(1);
    const blocked = makeSnapshot({ tasks: [makeTask({ task_id: 'b', status: 'WAITING', waiting_reason: 'blocked' })] });
    expect(diffNotices(memory, blocked, NOW).map((n) => n.title)).toEqual(['An agent is blocked']);
    expect(diffNotices(memory, blocked, NOW)).toEqual([]);
    diffNotices(memory, makeSnapshot({ tasks: [makeTask({ task_id: 'b', status: 'RUNNING' })] }), NOW);
    expect(diffNotices(memory, blocked, NOW)).toHaveLength(1);
  });

  it('does not announce a blocked agent whose approval is already announced', () => {
    const memory = remember(makeSnapshot(), NOW);
    const board = makeSnapshot({
      approvals: [makeApproval({ task_id: 'b' })],
      tasks: [makeTask({ task_id: 'b', status: 'WAITING', waiting_reason: 'blocked' })],
    });
    expect(diffNotices(memory, board, NOW).map((n) => n.title)).toEqual(['Approval needed']);
    // The approval decided, the agent still blocked: still one decision, no new notice.
    const after = makeSnapshot({ tasks: [makeTask({ task_id: 'b', status: 'WAITING', waiting_reason: 'blocked' })] });
    expect(diffNotices(memory, after, NOW)).toEqual([]);
  });

  it('names a high-risk approval and shows hidden characters in its target', () => {
    const memory = remember(makeSnapshot(), NOW);
    const [n] = diffNotices(
      memory,
      makeSnapshot({ approvals: [makeApproval({ risk: 'high', target: `rm -rf /‮txt.exe${'y'.repeat(5000)}` })] }),
      NOW,
    );
    expect(n?.title).toBe('High-risk approval needed');
    expect(n?.body).toContain('⟨U+202E⟩');
    expect(n?.body.length).toBeLessThan(220);
  });

  it('announces Friday stopping once', () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    start(ctx, f.env);
    ctx.store.patch('system', { connection: 'live' });
    ctx.store.patch('system', { connection: 'stopped' });
    ctx.store.patch('system', { sequence: 5 });
    expect(f.shown.map((n) => n.title)).toEqual(['Friday stopped — Friday — shop']);
  });

  it('a click focuses the window, selects the task and closes the notification', () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    start(ctx, f.env);
    ctx.board(makeSnapshot({ approvals: [makeApproval({ task_id: 'task_x' })] }));
    const n = f.shown[0];
    n?.onclick?.call(undefined as never, new Event('click'));
    expect(f.focusWindow).toHaveBeenCalledOnce();
    expect(ctx.store.select('ui').selectedTaskId).toBe('task_x');
    expect(ctx.store.select('ui').drawer).toBeNull();
    expect(n?.closed).toBe(true);
  });

  it('announces a message awaiting a reply as it does an approval; its click opens Messages at the delivery', () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    start(ctx, f.env);
    // A message that waits for nobody announces nothing.
    const note = makeInboxItem({ delivery_id: 'dlv_note' });
    ctx.board(makeSnapshot({ inbox: [note] }));
    expect(f.shown).toHaveLength(0);
    const request = makeInboxItem({
      delivery_id: 'dlv_req',
      mode: 'request',
      subject: `Which plan names? ${HOSTILE}`,
      task_id: 'task_x',
    });
    const board = makeSnapshot({ inbox: [note, request] });
    ctx.board(board);
    ctx.board({ ...board });
    expect(f.shown).toHaveLength(1);
    expect(f.shown[0]?.title).toBe('A message waits for your reply — Friday — shop');
    expect(f.shown[0]?.options).toMatchObject({
      body: `claude-1: Which plan names? ${HOSTILE}`,
      tag: 'message:dlv_req',
    });
    f.shown[0]?.onclick?.call(undefined as never, new Event('click'));
    expect(f.focusWindow).toHaveBeenCalledOnce();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inbox', id: 'dlv_req' });
    expect(ctx.store.select('ui').selectedTaskId).toBe('task_x');
    expect(f.shown[0]?.closed).toBe(true);
  });

  it('a message present at the start is not announced; one replied to closes its notification', () => {
    const f = fakeEnv();
    const first = makeInboxItem({ delivery_id: 'dlv_first', mode: 'request' });
    const ctx = ctxWith(makeSnapshot({ inbox: [first] }));
    start(ctx, f.env);
    expect(f.doc.title).toBe('(1) Friday — shop');
    expect(f.shown).toHaveLength(0);
    // A blocking message from the Master Brain without a subject: the preview stands in.
    const blocking = makeInboxItem({
      delivery_id: 'dlv_block',
      blocking: true,
      subject: null,
      preview: 'Choose the plan to keep.',
      from: { kind: 'master_brain', id: 'master', agent_key: null, role: null },
    });
    ctx.board(makeSnapshot({ inbox: [first, blocking] }));
    expect(f.shown.map((n) => n.options?.tag)).toEqual(['message:dlv_block']);
    expect(f.shown[0]?.options?.body).toBe('Master Brain: Choose the plan to keep.');
    // Replied to (or acknowledged): the delivery leaves the inbox and the notification closes.
    ctx.board(makeSnapshot({ inbox: [first] }));
    expect(f.shown[0]?.closed).toBe(true);
  });

  it('closes a notification when its item is decided, and all of them when the tab is shown', () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    start(ctx, f.env);
    ctx.board(makeSnapshot({ approvals: [makeApproval()], escalations: [makeEscalation()] }));
    expect(f.shown).toHaveLength(2);
    ctx.board(makeSnapshot({ escalations: [makeEscalation()] }));
    expect(f.shown[0]?.closed).toBe(true);
    expect(f.shown[1]?.closed).toBe(false);
    f.setVisibility('visible');
    expect(f.shown[1]?.closed).toBe(true);
  });

  it(`shows at most ${MAX_PER_UPDATE} per update, messages counted with the rest, and sums up what is over`, () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    start(ctx, f.env);
    ctx.board(
      makeSnapshot({
        approvals: Array.from({ length: 4 }, (_, i) =>
          makeApproval({ approval_id: `apr_${i}`, created_at: `2026-10-17T09:0${i}:00.000Z` }),
        ),
        inbox: [
          makeInboxItem({ delivery_id: 'dlv_1', mode: 'request' }),
          makeInboxItem({ delivery_id: 'dlv_2', blocking: true }),
        ],
      }),
    );
    expect(f.shown).toHaveLength(MAX_PER_UPDATE + 1);
    expect(f.shown.map((n) => n.options?.tag)).toEqual([
      'approval:apr_0',
      'approval:apr_1',
      'approval:apr_2',
      'more:approval:apr_3',
    ]);
    expect(f.shown.at(-1)?.title).toBe('Friday — shop: 3 more items need you');
  });

  it('keeps working when the browser refuses page notifications', () => {
    const f = fakeEnv({ throws: true });
    const ctx = ctxWith();
    start(ctx, f.env);
    expect(() => ctx.board(makeSnapshot({ approvals: [makeApproval()] }))).not.toThrow();
    expect(f.doc.title).toBe('(1) Friday — shop');
  });

  it('works without any Notification support', () => {
    const f = fakeEnv();
    const ctx = ctxWith();
    start(ctx, { ...f.env, Notification: undefined });
    expect(() => ctx.board(makeSnapshot({ approvals: [makeApproval()] }))).not.toThrow();
    expect(f.doc.title).toBe('(1) Friday — shop');
  });
});
