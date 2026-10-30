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
