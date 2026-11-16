import { describe, expect, it } from 'vitest';
import { classifyHostFailure, retryAfterSeconds } from './host-failure.js';

describe('classifyHostFailure (ADR-0035 §3)', () => {
  it('sees a sign-in problem wherever it appears', () => {
    expect(classifyHostFailure('Not logged in. Please run claude login', 'turn')).toEqual({ kind: 'auth' });
    expect(classifyHostFailure('HTTP 401 Unauthorized', 'exit')).toEqual({ kind: 'auth' });
    expect(classifyHostFailure('invalid api key provided', 'start')).toEqual({ kind: 'auth' });
  });

  it('sees a rate limit, with the wait the host asked for', () => {
    expect(classifyHostFailure('HTTP 429 Too Many Requests', 'turn')).toEqual({ kind: 'rate_limit' });
    expect(classifyHostFailure('rate limit reached; Retry-After: 120', 'turn')).toEqual({
      kind: 'rate_limit',
      retry_after_s: 120,
    });
    expect(classifyHostFailure('Overloaded. Try again in 5 minutes.', 'exit')).toEqual({
      kind: 'rate_limit',
      retry_after_s: 300,
    });
    expect(retryAfterSeconds('retry after 999999')).toBe(86_400);
    expect(retryAfterSeconds('try again in 2 hours')).toBe(7200);
    expect(retryAfterSeconds('nothing said')).toBeUndefined();
  });

  it("sees a subscription's usage limit as a limit that passes, with the wait until it lifts (2026-11-17)", () => {
    // Local time: "resets 3pm" is read as this machine's clock shows it.
    const now = new Date(2026, 10, 17, 10, 0, 0);
    const epoch = Math.floor(now.getTime() / 1000) + 5400;
    expect(
      classifyHostFailure(`the Claude Code turn ended: success: Claude AI usage limit reached|${epoch}`, 'turn', now),
    ).toEqual({ kind: 'rate_limit', retry_after_s: 5400 });
    expect(classifyHostFailure('5-hour limit reached ∙ resets 3pm', 'turn', now)).toEqual({
      kind: 'rate_limit',
      retry_after_s: 5 * 3600,
    });
    expect(classifyHostFailure("You've hit your limit · resets at 10:30", 'turn', now)).toEqual({
      kind: 'rate_limit',
      retry_after_s: 1800,
    });
    // A time of day that has passed is tomorrow's.
    expect(classifyHostFailure('weekly limit reached, resets 9am', 'exit', now)).toEqual({
      kind: 'rate_limit',
      retry_after_s: 23 * 3600,
    });
    expect(retryAfterSeconds('resets 12am', now)).toBe(14 * 3600);
    // A moment already past, or no time at all: a limit, with the default wait.
    expect(classifyHostFailure('Claude AI usage limit reached|1000000000', 'turn', now)).toEqual({
      kind: 'rate_limit',
    });
    expect(classifyHostFailure('You have hit your usage limit.', 'turn', now)).toEqual({ kind: 'rate_limit' });
    expect(retryAfterSeconds('resets 25:00', now)).toBeUndefined();
  });

  it("sees a subscription's expired sign-in, and not what a task's own tests print", () => {
    expect(classifyHostFailure('OAuth token has expired. Please run /login', 'turn')).toEqual({ kind: 'auth' });
    expect(classifyHostFailure('API Error: OAuth access token expired', 'exit')).toEqual({ kind: 'auth' });
    // A turn that ended in an error of the work's own is nobody's sign-in and nobody's limit.
    for (const text of [
      'tests failed: expected "session expired" to equal "ok"',
      'AssertionError: token expired should redirect to the sign-in page',
      'RangeError: recursion limit reached in parse()',
      'the context limit reached; the conversation was compacted',
      'the Claude Code turn ended: error_max_turns',
    ]) {
      expect(classifyHostFailure(text, 'turn'), text).toBeNull();
    }
  });

  it('is a runtime failure when the host cannot serve the model it was given (the live check of 2026-10-22)', () => {
    expect(
      classifyHostFailure(
        `the Codex turn failed: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'openai/gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}`,
        'turn',
      ),
    ).toEqual({ kind: 'runtime_unavailable' });
    expect(classifyHostFailure('unknown model: gpt-9', 'turn')).toEqual({ kind: 'runtime_unavailable' });
    expect(classifyHostFailure('model_not_found', 'exit')).toEqual({ kind: 'runtime_unavailable' });
  });

  it('is a start failure when the host could not be launched or given its task', () => {
    expect(classifyHostFailure('the turn could not start: EPIPE', 'start')).toEqual({ kind: 'start' });
    expect(classifyHostFailure('spawn claude ENOENT', 'exit')).toEqual({ kind: 'start' });
  });

  it('is a transport failure when the process died mid-turn, and nothing when the host ended its own turn in error', () => {
    expect(classifyHostFailure('it exited (1)', 'exit')).toEqual({ kind: 'transport' });
    expect(classifyHostFailure('the Claude Code turn ended: error_max_turns', 'turn')).toBeNull();
    expect(classifyHostFailure('', 'turn')).toBeNull();
  });
});
