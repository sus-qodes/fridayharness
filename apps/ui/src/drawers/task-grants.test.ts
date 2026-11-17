/**
 * What a person allowed for a task and still holds, in the task inspector, with "Take back".
 */
import type { ApprovalRow } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeApproval } from '../test/fixtures.js';
import { grantReach, standingGrants, taskGrants } from './task-grants.js';

const TID = 'task_0000000000000000000000aa01';
const HOSTILE = '<img src=x onerror=alert(1)>';
const NOW = Date.parse('2026-10-17T10:00:00.000Z');

const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function grant(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return makeApproval({
    approval_id: 'apr_task',
    status: 'granted',
    reuse: 'task',
    capability: 'package.install',
    target: 'npm install zod',
    expires_at: null,
    ...over,
  });
}

describe('which allowances still hold', () => {
  it('keeps what was given for the task or the attempt, and drops once, taken back and lapsed', () => {
    const rows = [
      grant(),
      grant({ approval_id: 'apr_run', reuse: 'run' }),
      grant({ approval_id: 'apr_once', reuse: 'once' }),
      grant({ approval_id: 'apr_revoked', status: 'revoked' }),
      grant({ approval_id: 'apr_used', status: 'used' }),
      grant({ approval_id: 'apr_lapsed', expires_at: '2026-10-17T09:59:59.000Z' }),
      grant({ approval_id: 'apr_later', expires_at: '2026-10-17T10:05:00.000Z' }),
    ];
    expect(standingGrants(rows, NOW).map((a) => a.approval_id)).toEqual(['apr_task', 'apr_run', 'apr_later']);
  });

  it('says how long one holds', () => {
    expect(grantReach({ reuse: 'task', expires_at: null }, NOW)).toBe('until the task ends');
    expect(grantReach({ reuse: 'run', expires_at: null }, NOW)).toBe('for the current attempt');
    expect(grantReach({ reuse: 'task', expires_at: '2026-10-17T10:05:00.000Z' }, NOW)).toBe(
      'until the task ends (lapses in 5 min)',
    );
  });
});

describe('Allowed for this task (2026-11-17)', () => {
  it('shows nothing, and says so to the inspector, while nothing is in force', async () => {
    const ctx = makeContext({
      answers: { [`GET /tasks/${TID}/approvals`]: { approvals: [grant({ reuse: 'once' })] } },
    });
    const counts: number[] = [];
    const g = taskGrants(ctx, TID, (n) => counts.push(n));
    await settle();
    expect(g.el.childElementCount).toBe(0);
    expect(counts).toEqual([0]);
    // The list is asked for this task alone.
    expect(ctx.transport.to('GET', `/tasks/${TID}/approvals`)).toHaveLength(1);
    g.destroy();
  });

  it('lists each allowance as the act it allows and exactly what, as text', async () => {
    const ctx = makeContext({
      answers: {
        [`GET /tasks/${TID}/approvals`]: {
          approvals: [
            grant({ target: `npm install ${HOSTILE}` }),
            grant({ approval_id: 'apr_2', capability: 'future.thing', target: null, reuse: 'run' }),
          ],
        },
      },
    });
    const counts: number[] = [];
    const g = taskGrants(ctx, TID, (n) => counts.push(n));
    await settle();
    const rows = [...g.el.querySelectorAll<HTMLElement>('.dr-grant')];
    expect(rows).toHaveLength(2);
    expect(counts).toEqual([2]);
    expect(rows[0]?.querySelector('.dr-grant-act')?.textContent).toBe('Install packages');
    expect(rows[0]?.querySelector<HTMLElement>('.dr-grant-act')?.title).toBe('package.install');
    expect(rows[0]?.textContent).toContain(`npm install ${HOSTILE}`);
    expect(rows[0]?.textContent).toContain('until the task ends');
    expect(rows[1]?.textContent).toContain('future.thing');
    expect(rows[1]?.textContent).toContain('for the current attempt');
    expect(g.el.querySelector('img')).toBeNull();
    g.destroy();
  });

  it('Take back revokes it, and the list is read again', async () => {
    let rows = [grant()];
    const ctx = makeContext({
      answers: {
        [`GET /tasks/${TID}/approvals`]: () => ({ approvals: rows }),
        'POST /approvals/apr_task/revoke': () => {
          rows = [];
          return { ok: true };
        },
      },
    });
    const counts: number[] = [];
    const g = taskGrants(ctx, TID, (n) => counts.push(n));
    await settle();
    (g.el.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(ctx.transport.to('POST', '/approvals/apr_task/revoke').map((c) => c.body)).toEqual([
      { note: 'taken back in the task inspector' },
    ]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Taken back: the agent asks again next time' });
    expect(g.el.childElementCount).toBe(0);
    expect(counts).toEqual([1, 0]);
    g.destroy();
  });

  it('shows nothing when the list cannot be read, and keeps the allowance when taking back fails', async () => {
    const failing = makeContext({
      answers: {
        [`GET /tasks/${TID}/approvals`]: () => {
          throw new Error('offline');
        },
      },
    });
    const none = taskGrants(failing, TID);
    await settle();
    expect(none.el.childElementCount).toBe(0);
    none.destroy();

    const ctx = makeContext({
      answers: {
        [`GET /tasks/${TID}/approvals`]: { approvals: [grant()] },
        'POST /approvals/apr_task/revoke': () => {
          throw new Error('approval is not granted any more');
        },
      },
    });
    const g = taskGrants(ctx, TID);
    await settle();
    (g.el.querySelector('button') as HTMLButtonElement).click();
    await settle();
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', detail: 'approval is not granted any more' });
    expect(g.el.querySelectorAll('.dr-grant')).toHaveLength(1);
    expect((g.el.querySelector('button') as HTMLButtonElement).disabled).toBe(false);
    g.destroy();
  });
});
