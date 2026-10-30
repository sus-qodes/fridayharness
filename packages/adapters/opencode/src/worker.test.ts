import { describe, expect, it } from 'vitest';
import { OPENCODE_RULES, openCodeOutcome } from './worker.js';

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  info: {
    role: 'assistant',
    time: { created: 1, completed: 2 },
    modelID: 'qwen2.5:7b',
    cost: 0,
    tokens: { input: 5123, output: 30, reasoning: 0, cache: { read: 1843, write: 0 } },
    ...extra,
  },
  parts: [{ type: 'step-start' }, { type: 'text', text }],
});

describe('how an OpenCode session ended its work (plan M14.4)', () => {
  it('reads the last line of JSON as the final answer, the text before it as the fallback summary', () => {
    const r = openCodeOutcome([
      { info: { role: 'user' }, parts: [{ type: 'text', text: 'task' }] },
      assistant('Wrote src/a.ts.\n{"status":"completed","summary":"added src/a.ts"}'),
    ]);
    expect(r.final).toEqual({ status: 'completed', summary: 'added src/a.ts', blocked_reason: '' });
    const blocked = openCodeOutcome([assistant('{"status":"blocked","blocked_reason":"which file?"}')]);
    expect(blocked.final).toMatchObject({ status: 'blocked', blocked_reason: 'which file?' });
    const bare = openCodeOutcome([assistant('All done.\n{"status":"completed"}')]);
    expect(bare.final).toMatchObject({ status: 'completed', summary: 'All done.' });
  });

  it('takes prose as a completion claim with the prose as its summary', () => {
    expect(openCodeOutcome([assistant('I changed nothing; the file was already right.')]).final).toEqual({
      status: 'completed',
      summary: 'I changed nothing; the file was already right.',
      blocked_reason: '',
    });
  });

  it("sums what the session's model calls cost, and leaves what the host did not count unknown", () => {
    const step = assistant('', { time: { created: 1, completed: 2 } });
    const r = openCodeOutcome([step, assistant('{"status":"completed","summary":"s"}')]);
    expect(r.usage).toEqual({
      cost_usd: 0,
      input_tokens: 10246,
      output_tokens: 60,
      cache_read_input_tokens: 3686,
      cache_creation_input_tokens: 0,
      turns: 2,
      model: 'qwen2.5:7b',
    });
    expect(openCodeOutcome([]).usage).toEqual({
      cost_usd: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      turns: 0,
      model: null,
    });
  });

  it('reads only finished answers: one still being written is not the final answer', () => {
    const r = openCodeOutcome([
      assistant('{"status":"completed","summary":"first"}'),
      assistant('still working', { time: { created: 3 } }),
    ]);
    expect(r.final.summary).toBe('first');
  });

  it('tells the session how to end, and nothing about tools it does not have', () => {
    expect(OPENCODE_RULES).toContain('{"status":"completed","summary":"what you did"}');
    expect(OPENCODE_RULES).not.toMatch(/friday_/);
  });
});
