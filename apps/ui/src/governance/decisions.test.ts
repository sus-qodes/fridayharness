import { describe, expect, it } from 'vitest';
import type { Reach } from '../api/client.js';
import { ApiError } from '../platform/transport.js';
import { makeContext } from '../test/context.js';
import { makeApproval, makeSnapshot } from '../test/fixtures.js';
import { decideApproval, grantPath, isDeciding, modalReason, needsHold, pendingApprovals } from './decisions.js';

describe('decision mapping (plan FD-15)', () => {
  const table: [risk: 'low' | 'medium' | 'high' | null, reach: Reach, path: 'one-click' | 'modal', hold: boolean][] = [
    ['low', 'once', 'one-click', false],
    ['low', 'run', 'one-click', false],
    ['low', 'task', 'modal', true],
    ['medium', 'once', 'one-click', false],
    ['medium', 'run', 'one-click', false],
    ['medium', 'task', 'modal', true],
    ['high', 'once', 'modal', true],
    ['high', 'run', 'modal', true],
    ['high', 'task', 'modal', true],
    [null, 'once', 'modal', true],
  ];
  it.each(table)('risk %s, reach %s → %s (hold %s)', (risk, reach, path, hold) => {
    const a = makeApproval({ risk });
    expect(grantPath(a, reach)).toBe(path);
    expect(needsHold(a, reach)).toBe(hold);
    expect(modalReason(a, reach) === null).toBe(path === 'one-click');
  });

  it('a target that does not fit the card is never one click', () => {
    const long = makeApproval({ risk: 'low', target: `npm run x -- ${'a'.repeat(400)}` });
    expect(grantPath(long, 'once')).toBe('modal');
    expect(modalReason(long, 'once')).toMatch(/too long/);
    const lines = makeApproval({ risk: 'low', target: Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n') });
    expect(grantPath(lines, 'once')).toBe('modal');
  });
});

describe('pendingApprovals', () => {
  it('lists pending approvals that have not expired, oldest first', () => {
    const now = Date.parse('2026-10-17T10:00:00.000Z');
    const board = makeSnapshot({
      approvals: [
        makeApproval({ approval_id: 'apr_b', created_at: '2026-10-17T09:59:00.000Z' }),
        makeApproval({ approval_id: 'apr_a', created_at: '2026-10-17T09:58:00.000Z' }),
        makeApproval({ approval_id: 'apr_x', expired: true }),
        makeApproval({ approval_id: 'apr_y', expires_at: '2026-10-17T09:59:59.000Z' }),
        makeApproval({ approval_id: 'apr_z', status: 'granted' }),
      ],
    });
    expect(pendingApprovals(board, now).map((a) => a.approval_id)).toEqual(['apr_a', 'apr_b']);
    expect(pendingApprovals(null, now)).toEqual([]);
  });
});

describe('decideApproval: optimistic, with rollback (plan §7.2)', () => {
  const approval = makeApproval({ approval_id: 'apr_1' });
  const other = makeApproval({ approval_id: 'apr_2', created_at: '2026-10-17T10:01:00.000Z' });

  function setup(answer: unknown) {
    let seen: string[] | null = null;
    const ctx = makeContext({
      snapshot: makeSnapshot({ approvals: [approval, other] }),
      answers: {
        'POST /approvals/apr_1/approve': () => {
          seen = ctx.store.select('board')?.approvals.map((a) => a.approval_id) ?? null;
          if (answer instanceof Error) throw answer;
          return answer;
        },
        'POST /approvals/apr_1/reject': () => {
          seen = ctx.store.select('board')?.approvals.map((a) => a.approval_id) ?? null;
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    });
    return { ctx, seen: () => seen };
  }

  it('removes the approval at once, sends an explicit reuse via ui, reacts and refreshes', async () => {
    const { ctx, seen } = setup({ ok: true, status: 'granted' });
    const outcome = await decideApproval(ctx, approval, { allow: true, reuse: 'run' });
    expect(outcome).toBe('done');
    expect(seen()).toEqual(['apr_2']);
    const [call] = ctx.transport.to('POST', '/approvals/apr_1/approve');
    expect(call?.body).toEqual({ reuse: 'run', via: 'ui' });
    expect(ctx.store.select('board')?.approvals.map((a) => a.approval_id)).toEqual(['apr_2']);
    expect(ctx.reactions).toEqual([{ kind: 'approved', label: 'shell.git.commit' }]);
    expect(ctx.refreshes).toBe(1);
    expect(isDeciding('apr_1')).toBe(false);
  });

  it('a denial sends its note', async () => {
    const { ctx } = setup({ ok: true, status: 'denied' });
    expect(await decideApproval(ctx, approval, { allow: false, note: '  use the env  ' })).toBe('done');
    expect(ctx.transport.to('POST', '/approvals/apr_1/reject')[0]?.body).toEqual({ via: 'ui', note: 'use the env' });
    expect(ctx.reactions[0]?.kind).toBe('denied');
  });

  it('a denial without a reason sends no note', async () => {
    const { ctx } = setup({ ok: true });
    await decideApproval(ctx, approval, { allow: false, note: '   ' });
    expect(ctx.transport.to('POST', '/approvals/apr_1/reject')[0]?.body).toEqual({ via: 'ui' });
  });

  it('a 500 brings the approval back where it was and shows the error', async () => {
    const { ctx, seen } = setup(new ApiError(500, 'COS-9000', 'internal', 'boom'));
    const outcome = await decideApproval(ctx, approval, { allow: true, reuse: 'once' });
    expect(outcome).toBe('failed');
    expect(seen()).toEqual(['apr_2']);
    expect(ctx.store.select('board')?.approvals.map((a) => a.approval_id)).toEqual(['apr_1', 'apr_2']);
    expect(ctx.toasts.some((t) => t.kind === 'error' && t.detail === 'boom')).toBe(true);
    expect(ctx.reactions).toEqual([]);
  });

  it('a 409 (already decided) keeps it removed', async () => {
    const { ctx } = setup(new ApiError(409, 'COS-2002', 'invalid_state_transition', 'already decided'));
    expect(await decideApproval(ctx, approval, { allow: true, reuse: 'once' })).toBe('already');
    expect(ctx.store.select('board')?.approvals.map((a) => a.approval_id)).toEqual(['apr_2']);
    expect(ctx.toasts.some((t) => t.kind === 'error')).toBe(false);
    expect(ctx.toasts.some((t) => t.kind === 'info')).toBe(true);
  });

  it('COS-2002 under another status keeps it removed too', async () => {
    const { ctx } = setup(new ApiError(400, 'COS-2002', 'invalid_state_transition', 'not pending'));
    expect(await decideApproval(ctx, approval, { allow: false })).toBe('already');
    expect(ctx.store.select('board')?.approvals).toHaveLength(1);
  });

  it('does not put it back twice when a snapshot re-read already did', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ approvals: [approval] }),
      answers: {
        'POST /approvals/apr_1/approve': () => {
          ctx.board(makeSnapshot({ approvals: [approval] }));
          throw new ApiError(500, 'COS-9000', 'internal', 'boom');
        },
      },
    });
    await decideApproval(ctx, approval, { allow: true, reuse: 'once' });
    expect(ctx.store.select('board')?.approvals).toHaveLength(1);
  });

  it('a second decision while one is in flight is refused', async () => {
    let release: (v: unknown) => void = () => undefined;
    const ctx = makeContext({
      snapshot: makeSnapshot({ approvals: [approval] }),
      answers: { 'POST /approvals/apr_1/approve': () => new Promise((r) => (release = r)) },
    });
    const first = decideApproval(ctx, approval, { allow: true, reuse: 'once' });
    expect(isDeciding('apr_1')).toBe(true);
    expect(pendingApprovals(makeSnapshot({ approvals: [approval] }), Date.parse('2026-10-17T10:00:00Z'))).toEqual([]);
    expect(await decideApproval(ctx, approval, { allow: false })).toBe('busy');
    release({ ok: true });
    expect(await first).toBe('done');
    expect(ctx.transport.calls).toHaveLength(1);
  });
});
