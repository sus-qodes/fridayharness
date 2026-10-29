import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { decisionItems, mountDecisionsTray } from './tray.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const NOW = Date.parse('2026-10-17T10:00:00.000Z');

describe('decisionItems', () => {
  it('lists pending approvals (not expired), questions, waiting agents and proposed plans, in that order', () => {
    const board = makeScenario();
    board.approvals.push(makeApproval({ approval_id: 'apr_old', expired: true }));
    board.plans[board.goals[0]?.goal_id as string] = {
      active: makePlan(),
      proposed: makePlan({ version: 2, status: 'PROPOSED' }),
    };
    const items = decisionItems(board, NOW);
    expect(items.map((i) => i.kind)).toEqual(['approval', 'question', 'waiting', 'plan']);
    expect(items.map((i) => i.key)).not.toContain('approval:apr_old');
  });

  it('skips a task waiting for an approval that is in the list, but not one whose approval is gone', () => {
    const t = makeTask({ status: 'WAITING', waiting_reason: 'human_approval' });
    const withApproval = makeSnapshot({ tasks: [t], approvals: [makeApproval({ task_id: t.task_id })] });
    expect(decisionItems(withApproval, NOW).map((i) => i.kind)).toEqual(['approval']);
    expect(decisionItems(makeSnapshot({ tasks: [t] }), NOW).map((i) => i.kind)).toEqual(['waiting']);
    const dep = makeTask({ status: 'WAITING', waiting_reason: 'dependency_wait' });
    expect(decisionItems(makeSnapshot({ tasks: [dep] }), NOW)).toEqual([]);
  });

  it('lists a spawned agent once when its approval or question is listed (it waits as blocked; review M9i)', () => {
    const t = makeTask({ status: 'WAITING', waiting_reason: 'blocked' });
    const asked = makeSnapshot({ tasks: [t], approvals: [makeApproval({ task_id: t.task_id })] });
    expect(decisionItems(asked, NOW).map((i) => i.kind)).toEqual(['approval']);
    const question = makeSnapshot({ tasks: [t], escalations: [makeEscalation({ task_id: t.task_id })] });
    expect(decisionItems(question, NOW).map((i) => i.kind)).toEqual(['question']);
  });

  it('ignores proposals of finished goals and answered questions', () => {
    const goal = makeGoal({ status: 'CANCELLED' });
    const board = makeSnapshot({
      goals: [goal],
      plans: { [goal.goal_id]: { active: null, proposed: makePlan({ status: 'PROPOSED' }) } },
      escalations: [makeEscalation({ status: 'answered' })],
    });
    expect(decisionItems(board, NOW)).toEqual([]);
    expect(decisionItems(null, NOW)).toEqual([]);
  });

  it('adds a message that waits for a reply, the memories to review and an untrusted policy (review §4, decision 6)', () => {
    const board = makeSnapshot({
      approvals: [makeApproval()],
      inbox: [
        makeInboxItem({ delivery_id: 'dlv_note', mode: 'notification' }),
        makeInboxItem({ delivery_id: 'dlv_req', mode: 'request', subject: 'Which plan names?' }),
        makeInboxItem({ delivery_id: 'dlv_blk', mode: 'notification', blocking: true, subject: null }),
      ],
      memories_to_review: 2,
      policy_untrusted: true,
    });
    const items = decisionItems(board, NOW);
    expect(items.map((i) => [i.kind, i.key])).toEqual([
      ['approval', 'approval:apr_000000000000000000000ap01'],
      ['message', 'message:dlv_req'],
      ['message', 'message:dlv_blk'],
      ['memory', 'memory:review'],
      ['policy', 'policy:untrusted'],
    ]);
    expect(items[3]).toMatchObject({ kind: 'memory', count: 2 });
    // The same rule the header, the title and the Notch chip read: nothing when nothing applies.
    expect(decisionItems(makeSnapshot({ inbox: [makeInboxItem()] }), NOW)).toEqual([]);
  });
});

describe('the "Waiting for you" tray', () => {
  let ctx: TestContext;
  let host: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it('shows an empty state', () => {
    ctx = makeContext({ snapshot: makeSnapshot() });
    const tray = mountDecisionsTray(ctx, host);
    expect(host.textContent).toContain('Nothing waits for you.');
    expect(host.querySelector('.gv-tray-count')?.hasAttribute('hidden')).toBe(true);
    // Focusable: the header's count and the Notch's chip hand it the keyboard.
    expect(host.querySelector<HTMLElement>('.gv-tray')?.tabIndex).toBe(-1);
    tray.destroy();
    expect(host.children).toHaveLength(0);
  });

  it('renders rows with hostile text as text and opens each card in place', () => {
    const board = makeScenario();
    board.approvals = [makeApproval({ task_id: board.tasks[0]?.task_id ?? null, target: `${HOSTILE}‮` })];
    ctx = makeContext({ snapshot: board });
    const tray = mountDecisionsTray(ctx, host);
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.gv-tray-count')?.textContent).toBe('3');
    const approvalRow = host.querySelector('.gv-tray-approval') as HTMLElement;
    expect(approvalRow.textContent).toContain('⟨U+202E⟩');
    const toggle = approvalRow.querySelector('.gv-tray-row') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(approvalRow.querySelector('.gv-approval')).not.toBeNull();
    (host.querySelector('.gv-tray-question .gv-tray-row') as HTMLButtonElement).click();
    expect(host.querySelector('.gv-tray-question .gv-question')).not.toBeNull();
    (host.querySelector('.gv-tray-waiting .gv-tray-row') as HTMLButtonElement).click();
    expect(host.querySelector('.gv-tray-waiting .gv-waiting')).not.toBeNull();
    toggle.click();
    expect(approvalRow.querySelector('.gv-approval')).toBeNull();
    tray.destroy();
  });

  it('opens the plan review for a proposed plan and the full view for an approval', () => {
    const goal = makeGoal();
    ctx = makeContext({
      snapshot: makeSnapshot({
        goals: [goal],
        plans: { [goal.goal_id]: { active: null, proposed: makePlan({ status: 'PROPOSED' }) } },
        approvals: [makeApproval()],
      }),
    });
    const tray = mountDecisionsTray(ctx, host);
    (host.querySelector('.gv-tray-plan .gv-tray-row') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-review', id: goal.goal_id });
    (host.querySelector('.gv-tray-full') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'approval', id: 'apr_000000000000000000000ap01' });
    tray.destroy();
  });

  it('shows a message that waits for a reply and opens the Messages drawer on it', () => {
    ctx = makeContext({
      snapshot: makeSnapshot({
        inbox: [
          makeInboxItem({
            delivery_id: 'dlv_req',
            mode: 'request',
            subject: `Which plan names? ${HOSTILE}‮`,
            from: { kind: 'agent', id: 'agent_x', agent_key: `claude-1${HOSTILE}`, role: 'developer' },
          }),
        ],
      }),
    });
    const tray = mountDecisionsTray(ctx, host);
    expect(host.querySelector('.gv-tray-count')?.textContent).toBe('1');
    const row = host.querySelector('.gv-tray-message') as HTMLElement;
    expect(row.querySelector('.gv-tray-label')?.textContent).toBe('A message waits for your reply');
    expect(row.querySelector('.gv-tray-sub')?.textContent).toContain('claude-1');
    expect(row.querySelector('.gv-tray-sub')?.textContent).toContain('Which plan names?');
    expect(row.textContent).not.toContain('‮');
    expect(host.querySelector('img')).toBeNull();
    const toggle = row.querySelector('.gv-tray-row') as HTMLButtonElement;
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
    toggle.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inbox', id: 'dlv_req' });
    // Replied (the delivery left the inbox): the row leaves and the count follows.
    ctx.board(makeSnapshot());
    expect(host.querySelector('.gv-tray-message')).toBeNull();
    expect(host.textContent).toContain('Nothing waits for you.');
    tray.destroy();
  });

  it('shows the memories that need review and opens Project memory at Needs review', () => {
    ctx = makeContext({ snapshot: makeSnapshot({ memories_to_review: 1 }) });
    const tray = mountDecisionsTray(ctx, host);
    const row = host.querySelector('.gv-tray-memory') as HTMLElement;
    expect(row.querySelector('.gv-tray-label')?.textContent).toBe('1 memory needs review');
    (row.querySelector('.gv-tray-row') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'memory', tab: 'review' });
    ctx.board(makeSnapshot({ memories_to_review: 3 }));
    expect(host.querySelector('.gv-tray-memory .gv-tray-label')?.textContent).toBe('3 memories need review');
    expect(host.querySelector('.gv-tray-count')?.textContent).toBe('1');
    ctx.board(makeSnapshot({ memories_to_review: 0 }));
    expect(host.querySelector('.gv-tray-memory')).toBeNull();
    tray.destroy();
  });

  it('shows an untrusted policy loosening and opens Settings → Policy', () => {
    ctx = makeContext({ snapshot: makeSnapshot({ policy_untrusted: true }) });
    const tray = mountDecisionsTray(ctx, host);
    const row = host.querySelector('.gv-tray-policy') as HTMLElement;
    expect(row.querySelector('.gv-tray-label')?.textContent).toBe('Policy change not yet trusted');
    (row.querySelector('.gv-tray-row') as HTMLButtonElement).click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'policy' });
    ctx.board(makeSnapshot({ policy_untrusted: false }));
    expect(host.querySelector('.gv-tray-policy')).toBeNull();
    tray.destroy();
  });

  it('keeps an open card across snapshot re-reads, so it stays armed', () => {
    ctx = makeContext({ snapshot: makeSnapshot({ approvals: [makeApproval()] }) });
    const tray = mountDecisionsTray(ctx, host);
    (host.querySelector('.gv-tray-row') as HTMLButtonElement).click();
    const card = host.querySelector('.gv-approval');
    ctx.board(makeSnapshot({ approvals: [makeApproval()] }));
    expect(host.querySelector('.gv-approval')).toBe(card);
    ctx.board(makeSnapshot({ approvals: [] }));
    expect(host.querySelector('.gv-approval')).toBeNull();
    expect(host.textContent).toContain('Nothing waits for you.');
    tray.destroy();
  });

  it('Later on a question folds it', () => {
    ctx = makeContext({ snapshot: makeSnapshot({ escalations: [makeEscalation()] }) });
    const tray = mountDecisionsTray(ctx, host);
    (host.querySelector('.gv-tray-row') as HTMLButtonElement).click();
    const later = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Later') as HTMLButtonElement;
    later.click();
    expect(host.querySelector('.gv-question')).toBeNull();
    tray.destroy();
  });

  it('drops an approval from the list when it expires', () => {
    ctx = makeContext({
      snapshot: makeSnapshot({ approvals: [makeApproval({ expires_at: '2026-10-17T10:00:05.000Z' })] }),
    });
    const tray = mountDecisionsTray(ctx, host);
    expect(host.querySelectorAll('.gv-tray-item')).toHaveLength(1);
    ctx.clock.now += 6000;
    vi.advanceTimersByTime(6000);
    expect(host.querySelectorAll('.gv-tray-item')).toHaveLength(0);
    tray.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
