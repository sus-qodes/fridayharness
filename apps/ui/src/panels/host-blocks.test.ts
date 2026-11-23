/**
 * What keeps a host out of work is said in plain words, with one button that tries it again: before,
 * a host that once said "not signed in" was refused every task until a terminal command.
 */
import type { HostBlockView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { blockSentence, hostBlocks, hostName, liftLabel } from '../model/host-blocks.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot } from '../test/fixtures.js';
import { Teardown } from './common.js';
import { hostBlocksNotice } from './host-blocks.js';
import { buttonBy, flush, HOSTILE } from './test-support.js';

const signIn: HostBlockView = {
  host: 'claude-code',
  model: null,
  kind: 'sign_in',
  detail: `auth: Not logged in ${HOSTILE}`,
  since: '2026-11-17T09:00:00.000Z',
  until: null,
};
const bench: HostBlockView = {
  host: 'codex',
  model: 'openai/gpt-6.1-sol',
  kind: 'benched',
  detail: 'rate_limit: usage limit reached',
  since: '2026-11-17T09:00:00.000Z',
  until: '2026-11-17T12:30:00.000Z',
};

describe('what keeps a host out, in words', () => {
  it('names the host as a person knows it, a failed sign-in first', () => {
    expect(hostName('claude-code')).toBe('Claude Code');
    expect(hostName('gemini')).toBe('Gemini CLI');
    expect(hostName(`x${HOSTILE}`)).toBe(`x${HOSTILE}`);
    const board = makeSnapshot({ host_blocks: [bench, signIn] });
    expect(hostBlocks(board).map((b) => b.kind)).toEqual(['sign_in', 'benched']);
    expect(hostBlocks(board, 'codex')).toEqual([bench]);
    // An older daemon says nothing: nothing is shown.
    expect(hostBlocks(makeSnapshot())).toEqual([]);
    expect(hostBlocks(null)).toEqual([]);
  });

  it('says what to do about each', () => {
    expect(blockSentence(signIn)).toContain('Claude Code is not signed in, so Friday gives it no work');
    expect(blockSentence(signIn)).toContain('then say so here');
    expect(liftLabel(signIn)).toBe('I signed in: try again');
    const text = blockSentence(bench);
    expect(text).toContain('Codex (openai/gpt-6.1-sol) is left out for now until ');
    expect(text).toContain('Friday tries it again by itself');
    expect(liftLabel(bench)).toBe('Try again now');
    // A bench without an end, or with one that is no date, says no time.
    expect(blockSentence({ ...bench, until: null })).toContain('is left out for now: it hit a limit');
    expect(blockSentence({ ...bench, until: 'soon' })).toContain('is left out for now: it hit a limit');
  });
});

describe('the notice', () => {
  it('is hidden while nothing is kept out, and follows the board', () => {
    const ctx = makeContext();
    const td = new Teardown();
    const el = hostBlocksNotice(ctx, td);
    expect(el.hidden).toBe(true);
    ctx.board(makeSnapshot({ host_blocks: [signIn] }));
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain('Claude Code is not signed in');
    expect(el.textContent).toContain(`It said: auth: Not logged in ${HOSTILE}`);
    expect(el.querySelector('img')).toBeNull();
    ctx.board(makeSnapshot());
    expect(el.hidden).toBe(true);
    td.run();
  });

  it('lifts a block when the person says they signed in, and shows a refusal as any failed action', async () => {
    const ctx = makeContext({
      snapshot: makeSnapshot({ host_blocks: [signIn, bench] }),
      answers: { 'POST /readiness/clear': { ended: [{ evidence_id: 'rdy_1' }] } },
    });
    const td = new Teardown();
    const el = hostBlocksNotice(ctx, td);
    buttonBy(el, 'I signed in: try again').click();
    await flush();
    expect(ctx.transport.to('POST', '/readiness/clear').map((c) => c.body)).toEqual([
      { host: 'claude-code', model: null },
    ]);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Claude Code is tried again with the next task' });
    expect(ctx.refreshes).toBe(1);
    buttonBy(el, 'Try again now').click();
    await flush();
    expect(ctx.transport.to('POST', '/readiness/clear').at(-1)?.body).toEqual({
      host: 'codex',
      model: 'openai/gpt-6.1-sol',
    });
    td.run();

    const failing = makeContext({
      snapshot: makeSnapshot({ host_blocks: [signIn] }),
      answers: {
        'POST /readiness/clear': () => {
          throw new Error('only a human clears readiness');
        },
      },
    });
    const td2 = new Teardown();
    const el2 = hostBlocksNotice(failing, td2);
    buttonBy(el2, 'I signed in: try again').click();
    await flush();
    expect(failing.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Try the sign-in again' });
    expect(failing.refreshes).toBe(0);
    // Still offered.
    expect(buttonBy(el2, 'I signed in: try again').disabled).toBe(false);
    td2.run();
  });

  it('shows only one host’s blocks when asked for one', () => {
    const ctx = makeContext({ snapshot: makeSnapshot({ host_blocks: [signIn, bench] }) });
    const td = new Teardown();
    const el = hostBlocksNotice(ctx, td, 'codex');
    expect(el.textContent).toContain('Codex');
    expect(el.textContent).not.toContain('Claude Code');
    td.run();
  });
});
