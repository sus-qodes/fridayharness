import type { AnswerView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeGoal, makeSnapshot } from '../test/fixtures.js';
import { answerModal, waitingWords } from './answer-panel.js';
import { buttonBy, flush, HOSTILE } from './test-support.js';

const GID = 'goal_0000000000000000000000gg01';
const QUESTION = 'How do menu price revisions work?';

const view = (over: Partial<AnswerView> = {}): AnswerView => ({
  goal_id: GID,
  question: QUESTION,
  state: 'ready',
  task_id: 'task_1',
  agent_key: 'claude-1',
  summary: 'Each change is a new row',
  preview: 'A price is kept per outlet.',
  answer: '# Prices\n\nA price is kept **per outlet**.\n\n- every change is a new row',
  note: null,
  at: '2026-10-17T09:00:00.000Z',
  read: false,
  ...over,
});

const board = (a: AnswerView) =>
  makeSnapshot({
    goals: [makeGoal({ mode: 'ask', status: a.state === 'ready' ? 'COMPLETED' : 'ACTIVE', request: QUESTION })],
    answers: { [GID]: { ...a, answer: undefined } },
  });

describe('the answer to a question (2026-11-18)', () => {
  it('shows the question, who answered, and the answer laid out; opening it marks it read', async () => {
    const a = view();
    const ctx = makeContext({
      snapshot: board(a),
      answers: { [`GET /goals/${GID}/answer`]: a, [`POST /goals/${GID}/answer/read`]: { ok: true } },
    });
    const m = answerModal(ctx, { kind: 'answer', id: GID }, () => undefined);
    await flush();
    expect(m.title).toBe('Your question');
    expect(m.el.querySelector('.pn-answer-question')?.textContent).toBe(QUESTION);
    expect(m.el.textContent).toContain('claude-1 answered');
    expect(m.el.textContent).toContain('Nothing in your project was changed.');
    // Laid out for reading, not shown as raw marks.
    expect(m.el.querySelector('.pr h3')?.textContent).toBe('Prices');
    expect(m.el.querySelector('.pr strong')?.textContent).toBe('per outlet');
    expect(m.el.querySelector('.pr')?.textContent).not.toContain('**');
    expect(ctx.transport.to('POST', `/goals/${GID}/answer/read`)).toHaveLength(1);
    expect(ctx.refreshes).toBe(1);
    buttonBy(m.el, 'Copy the answer').click();
    await flush();
    expect(ctx.toasts.at(-1)?.text).toMatch(/Copied the answer|select the text/);
    m.destroy();
  });

  it('does not mark an answer read twice, and shows a hostile answer as text', async () => {
    const a = view({ read: true, answer: `${HOSTILE}\n\n- item`, question: `Why ${HOSTILE}?` });
    const ctx = makeContext({ snapshot: board(a), answers: { [`GET /goals/${GID}/answer`]: a } });
    const m = answerModal(ctx, { kind: 'answer', id: GID }, () => undefined);
    await flush();
    expect(ctx.transport.to('POST', `/goals/${GID}/answer/read`)).toHaveLength(0);
    expect(m.el.querySelector('img, script')).toBeNull();
    expect(m.el.querySelector('.pn-answer-question')?.textContent).toContain(HOSTILE);
    m.destroy();
  });

  it('says an agent is at work, and fills in when the board says the answer is there', async () => {
    let now = view({ state: 'answering', answer: null, summary: null, preview: null, at: null });
    const ctx = makeContext({
      snapshot: board(now),
      answers: { [`GET /goals/${GID}/answer`]: () => now, [`POST /goals/${GID}/answer/read`]: { ok: true } },
    });
    const m = answerModal(ctx, { kind: 'answer', id: GID }, () => undefined);
    await flush();
    expect(m.el.textContent).toContain('claude-1 is reading the project and writing the answer.');
    expect(ctx.transport.to('POST', `/goals/${GID}/answer/read`)).toHaveLength(0);
    expect(() => buttonBy(m.el, 'Copy the answer')).toThrow();
    now = view();
    ctx.store.setState({ board: board(now) });
    await flush();
    expect(m.el.querySelector('.pr h3')?.textContent).toBe('Prices');
    expect(ctx.transport.to('POST', `/goals/${GID}/answer/read`)).toHaveLength(1);
    m.destroy();
  });

  it('says when a question got no answer, and asks it again as a new question', async () => {
    const a = view({ state: 'failed', answer: null, summary: null, preview: null });
    let closed = 0;
    const ctx = makeContext({
      snapshot: board(a),
      answers: {
        [`GET /goals/${GID}/answer`]: a,
        [`POST /goals/${GID}/answer/read`]: { ok: true },
        'POST /goals': { goal_id: 'goal_again' },
      },
    });
    const m = answerModal(ctx, { kind: 'answer', id: GID }, () => {
      closed += 1;
    });
    await flush();
    expect(m.el.textContent).toContain('claude-1 ended without an answer.');
    expect(m.el.textContent).toContain('Nothing in your project was changed.');
    // Seen, so it no longer waits for the person.
    expect(ctx.transport.to('POST', `/goals/${GID}/answer/read`)).toHaveLength(1);
    buttonBy(m.el, 'Ask again').click();
    await flush();
    expect(ctx.transport.to('POST', '/goals').map((c) => c.body)).toMatchObject([
      { request: QUESTION, mode: 'ask', plan: false },
    ]);
    expect(closed).toBe(1);
    m.destroy();
  });

  it('has words for every state before the answer is there', () => {
    expect(waitingWords({ state: 'waiting', agent_key: null })).toContain('No agent has taken the question yet');
    expect(waitingWords({ state: 'answering', agent_key: null })).toBe(
      'An agent is reading the project and writing the answer.',
    );
    expect(waitingWords({ state: 'cancelled', agent_key: 'claude-1' })).toBe('This question was cancelled.');
    expect(waitingWords({ state: 'ready', agent_key: 'claude-1' })).toBe('');
  });
});
