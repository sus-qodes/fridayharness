/**
 * Cancelling a task: when unfinished tasks depend on it the person says what becomes of them, then
 * confirms; backing out changes nothing; the desktop's own dialog asks the second question.
 */
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeSnapshot, makeTask } from '../test/fixtures.js';
import { cancelTask, openDependents } from './cancel-task.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

/** api ← page ← docs, a finished task that depended on api, and one that depends on nothing. */
function board() {
  return makeSnapshot({
    tasks: [
      makeTask({ task_id: 'api', summary: 'Build the API', status: 'RUNNING' }),
      makeTask({ task_id: 'page', summary: `Build the page ${HOSTILE}`, status: 'PROPOSED', dependencies: ['api'] }),
      makeTask({ task_id: 'docs', summary: 'Write the docs', status: 'PROPOSED', dependencies: ['page'] }),
      makeTask({ task_id: 'old', summary: 'Done long ago', status: 'COMPLETED', dependencies: ['api'] }),
      makeTask({ task_id: 'ci', summary: 'Set up CI', status: 'READY' }),
    ],
  });
}
const api = { task_id: 'api', summary: 'Build the API' };
const sent = (ctx: ReturnType<typeof makeContext>, id = 'api') =>
  ctx.transport.to('POST', `/tasks/${id}/cancel`).map((c) => c.body);

describe('the tasks that wait for one', () => {
  it('are those that depend on it, through every level, and not finished', () => {
    expect(openDependents(board(), 'api').map((t) => t.task_id)).toEqual(['page', 'docs']);
    expect(openDependents(board(), 'page').map((t) => t.task_id)).toEqual(['docs']);
    expect(openDependents(board(), 'ci')).toEqual([]);
    expect(openDependents(null, 'api')).toEqual([]);
  });
});

describe('cancelling a task', () => {
  it('asks once when nothing depends on it, and sends no word about dependents', async () => {
    const ctx = makeContext({ snapshot: board() });
    ctx.confirmAnswer = false;
    expect(await cancelTask(ctx, { task_id: 'ci', summary: 'Set up CI' })).toBe(false);
    expect(ctx.confirms.map((c) => c.title)).toEqual(['Cancel this task?']);
    expect(sent(ctx, 'ci')).toEqual([]);
    ctx.confirmAnswer = true;
    expect(await cancelTask(ctx, { task_id: 'ci', summary: 'Set up CI' }, { reason: 'not needed' })).toBe(true);
    expect(sent(ctx, 'ci')).toEqual([{ reason: 'not needed' }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Task cancelled' });
    expect(ctx.refreshes).toBe(1);
  });

  it('first asks what becomes of the tasks that wait for it, naming them, then confirms with that choice', async () => {
    const ctx = makeContext({ snapshot: board() });
    expect(await cancelTask(ctx, api)).toBe(true);
    expect(ctx.confirms.map((c) => c.title)).toEqual(['2 other tasks wait for this one', 'Cancel this task?']);
    const first = [ctx.confirms[0]?.body].flat();
    expect(first).toContain(`• Build the page ${HOSTILE}`);
    expect(first).toContain('• Write the docs');
    expect(first.join(' ')).toContain('can never start');
    expect(ctx.confirms[0]).toMatchObject({ confirmLabel: 'Cancel them too', cancelLabel: 'Keep them' });
    expect([ctx.confirms[1]?.body].flat().join(' ')).toContain('2 tasks that depend on it are cancelled too.');
    expect(sent(ctx)).toEqual([{ dependents: 'cancel' }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Task cancelled, and 2 tasks that waited for it' });
  });

  it('keeps them without it when the person says so, and changes nothing when they back out', async () => {
    const ctx = makeContext({ snapshot: board() });
    // "Keep them", then "Cancel task".
    const answers = [false, true];
    ctx.confirm = async (o) => {
      ctx.confirms.push(o);
      return answers.shift() ?? false;
    };
    expect(await cancelTask(ctx, api)).toBe(true);
    expect([ctx.confirms[1]?.body].flat().join(' ')).toContain(
      '2 tasks that depend on it are kept and no longer wait for it.',
    );
    expect(sent(ctx)).toEqual([{ dependents: 'release' }]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Task cancelled' });

    // Whatever was said about the others, "Keep it" at the last step cancels nothing.
    const back = makeContext({ snapshot: board() });
    const no = [true, false];
    back.confirm = async (o) => {
      back.confirms.push(o);
      return no.shift() ?? false;
    };
    expect(await cancelTask(back, api)).toBe(false);
    expect(sent(back)).toEqual([]);
    expect(back.refreshes).toBe(0);
  });

  it('on the desktop asks only about the others: the shell confirms the cancellation itself', async () => {
    const ctx = makeContext({ snapshot: board() });
    (ctx as { platform: unknown }).platform = { ...ctx.platform, kind: 'tauri', desktop: {} };
    expect(await cancelTask(ctx, { task_id: 'page', summary: 'Build the page' })).toBe(true);
    expect(ctx.confirms.map((c) => c.title)).toEqual(['1 other task waits for this one']);
    expect(ctx.confirms[0]).toMatchObject({ confirmLabel: 'Cancel it too', cancelLabel: 'Keep it' });
    expect(sent(ctx, 'page')).toEqual([{ dependents: 'cancel' }]);
    // With nothing waiting, the page asks nothing at all there.
    const alone = makeContext({ snapshot: board() });
    (alone as { platform: unknown }).platform = { ...alone.platform, kind: 'tauri', desktop: {} };
    expect(await cancelTask(alone, { task_id: 'ci', summary: 'Set up CI' })).toBe(true);
    expect(alone.confirms).toEqual([]);
  });

  it('answers false when Friday refuses, and shows the refusal as any failed action', async () => {
    const ctx = makeContext({
      snapshot: board(),
      answers: {
        'POST /tasks/ci/cancel': () => {
          throw new Error('task ci is COMPLETED');
        },
      },
    });
    expect(await cancelTask(ctx, { task_id: 'ci', summary: 'Set up CI' })).toBe(false);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Cancel the task' });
    expect(ctx.refreshes).toBe(0);
  });
});
