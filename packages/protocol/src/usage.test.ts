import { describe, expect, it } from 'vitest';
import { allTokens, promptTokens } from './usage.js';

describe('one way to count an agent’s tokens (2026-11-18)', () => {
  it('counts Claude Code’s cache, which it reports apart from its input', () => {
    // A planner call of the trial: input 2, output 2,121, cache creation 12,389.
    const claude = {
      input_tokens: 2,
      output_tokens: 2121,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 12389,
    };
    expect(allTokens(claude)).toBe(14512);
    expect(promptTokens(claude)).toBe(12391);
  });

  it('counts Codex’s cache once: its input holds it already', () => {
    const codex = {
      input_tokens: 64178,
      output_tokens: 688,
      cache_read_input_tokens: 39936,
      cache_creation_input_tokens: 0,
      input_includes_cache: true,
    };
    expect(allTokens(codex)).toBe(64866);
    expect(promptTokens(codex)).toBe(64178);
  });

  it('is unknown, never 0, when the host reported nothing; a report without cache fields counts what it has', () => {
    expect(allTokens({ input_tokens: null, output_tokens: null })).toBeNull();
    expect(promptTokens({ input_tokens: null, output_tokens: 5 })).toBeNull();
    expect(allTokens({ input_tokens: null, output_tokens: 5 })).toBe(5);
    expect(allTokens({ input_tokens: 100, output_tokens: 10 })).toBe(110);
  });
});
