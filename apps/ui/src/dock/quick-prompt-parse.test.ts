import { describe, expect, it } from 'vitest';
import { EMPTY_HINT, goalLine } from './quick-prompt-parse.js';

/** The words the line once understood as commands (review §6): each is a goal now, like any other text. */
const FORMER_COMMANDS = ['pause', 'resume', 'halt', 'status', 'approve', 'deny', 'open', 'start', 'goal'];

describe('goalLine', () => {
  it('offers the trimmed text as a goal, and asks for text when there is none', () => {
    expect(goalLine('  Add Stripe subscriptions  ')).toEqual({ kind: 'goal', text: 'Add Stripe subscriptions' });
    expect(goalLine('')).toEqual({ kind: 'empty' });
    expect(goalLine('   ')).toEqual({ kind: 'empty' });
    expect(EMPTY_HINT).toMatch(/press Enter/);
  });

  it('parses no command word: each former command is text for a goal', () => {
    for (const word of FORMER_COMMANDS) {
      expect(goalLine(word)).toEqual({ kind: 'goal', text: word });
      expect(goalLine(`${word} something`)).toEqual({ kind: 'goal', text: `${word} something` });
      expect(goalLine(word.toUpperCase())).toEqual({ kind: 'goal', text: word.toUpperCase() });
    }
    expect(goalLine('deny not in this task')).toEqual({ kind: 'goal', text: 'deny not in this task' });
    expect(goalLine('start claude-code claude-2')).toEqual({ kind: 'goal', text: 'start claude-code claude-2' });
    expect(goalLine('goal Add subscriptions')).toEqual({ kind: 'goal', text: 'goal Add subscriptions' });
  });

  it('keeps a goal within the length the New goal dialog allows', () => {
    expect(goalLine('ab')).toMatchObject({ kind: 'invalid', message: expect.stringMatching(/at least 3 characters/) });
    expect(goalLine('x'.repeat(4000)).kind).toBe('goal');
    expect(goalLine('x'.repeat(4001))).toMatchObject({
      kind: 'invalid',
      message: expect.stringMatching(/at most 4000 characters/),
    });
  });
});
