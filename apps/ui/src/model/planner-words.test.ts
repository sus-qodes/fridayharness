import { describe, expect, it } from 'vitest';
import {
  fixedInSettings,
  keyWords,
  PLANNER_FAILURES,
  plannerTrouble,
  plannerTroubleWords,
  plannerWords,
} from './planner-words.js';

describe('why the planner could not plan', () => {
  it('reads the trouble from the kind and from what the provider said', () => {
    const cases: [string, string, string][] = [
      ['planner_unavailable', 'Claude Code said: Not logged in · Please run /login', 'sign_in'],
      ['planner_unavailable', 'OAuth token has expired', 'sign_in'],
      ['planner_unavailable', '401 unauthorized', 'sign_in'],
      ['planner_unavailable', 'Claude AI usage limit reached|1731855600', 'limit'],
      ['planner_unavailable', 'You have hit your limit · resets 5pm', 'limit'],
      ['action_failed', '429 too many requests', 'limit'],
      ['planner_unavailable', 'no planner is configured', 'not_set_up'],
      ['planner_unavailable', 'the Anthropic key is missing', 'not_set_up'],
      ['planner_unavailable', 'this machine has not approved claude-code', 'not_set_up'],
      ['planner_unavailable', 'Claude Code was not found (PATH, CLAUDE_CODE_BIN, the VS Code extension)', 'not_set_up'],
      // Planning without Claude (2026-11-23): Codex and a service reached with a key.
      ['planner_unavailable', 'Codex was not found on this computer', 'not_set_up'],
      ['planner_unavailable', 'no OpenAI key is stored on this computer', 'not_set_up'],
      ['planner_unavailable', 'no model is chosen for it yet: choose one in Settings, under Planner', 'not_set_up'],
      ['action_failed', 'codex auth: Codex is not signed in for planning: Not logged in', 'sign_in'],
      ['action_failed', 'openai auth: OpenAI rejected the key (401: Incorrect API key provided)', 'sign_in'],
      [
        'action_failed',
        "codex rate_limited: Codex has reached a limit of its account: You've hit your usage limit",
        'limit',
      ],
      ['action_failed', 'plan kept failing (4 attempts): boom', 'other'],
      // The kind says it on its own, whatever the words.
      ['budget_exceeded', 'usage limit', 'budget'],
      ['invalid_plan', 'not signed in', 'unreadable'],
    ];
    for (const [kind, why, want] of cases) expect(plannerTrouble(kind, why), `${kind}: ${why}`).toBe(want);
    expect(plannerTrouble('planner_unavailable', null)).toBe('other');
    expect(plannerTrouble(null, undefined)).toBe('other');
    expect(PLANNER_FAILURES).toEqual(['planner_unavailable', 'invalid_plan', 'budget_exceeded', 'action_failed']);
  });

  it('says each in a sentence a person can act on, with the provider’s words only where nothing better is known', () => {
    expect(plannerTroubleWords('sign_in', 'x')).toContain('for Claude Code or Codex: open it once and sign in');
    expect(plannerTroubleWords('sign_in', 'x')).toContain('for a key: store it again in Settings → Planner');
    // A planner held to requests a day says that limit, not "spending".
    expect(
      plannerTroubleWords(
        'budget',
        "today's limit of 50 requests to the planner is reached (50 made); it starts again tomorrow",
      ),
    ).toContain('Today’s limit of requests to the planner is reached');
    expect(plannerTroubleWords('budget', 'x')).toContain('Today’s spending limit for planning is used up');
    expect(plannerTroubleWords('limit', 'x')).toContain('once the limit resets');
    expect(plannerTroubleWords('not_set_up', 'x')).toContain('Settings → Planner');
    expect(plannerTroubleWords('budget', 'x')).toContain('wait until tomorrow');
    expect(plannerTroubleWords('unreadable', 'x')).toContain('Ask again');
    expect(plannerTroubleWords('other', '  boom  ')).toContain('The planner could not finish: boom');
    expect(plannerTroubleWords('other', null)).toBe('The planner could not finish.');
    expect(plannerTroubleWords('other', 'x'.repeat(900)).length).toBeLessThan(340);
  });

  it('knows which troubles are fixed in the planner settings', () => {
    expect(
      ['sign_in', 'limit', 'not_set_up', 'budget', 'unreadable', 'other'].map((t) => fixedInSettings(t as never)),
    ).toEqual([true, false, true, true, false, false]);
  });
});

describe('who writes the plans, in words (2026-11-17)', () => {
  it('names the model and how it is reached, never the provider as the code names it', () => {
    expect(plannerWords({ provider: 'anthropic', model: 'claude-opus-5-5' })).toBe(
      'Claude Opus 5.5, with your Anthropic API key',
    );
    expect(plannerWords({ provider: 'claude-code', model: 'claude-sonnet-5-5' })).toBe(
      'Claude Sonnet 5.5, through your Claude Code sign-in',
    );
    expect(plannerWords({ provider: 'local', model: 'qwen3-coder' })).toBe('qwen3-coder, a model on this computer');
    // Planning without Claude (2026-11-23).
    expect(plannerWords({ provider: 'codex', model: 'auto' })).toBe('Codex, through your Codex sign-in');
    expect(plannerWords({ provider: 'codex', model: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol, through your Codex sign-in');
    expect(plannerWords({ provider: 'openai', model: 'gpt-6.1-sol' })).toBe('gpt-6.1-sol, with your OpenAI API key');
    expect(plannerWords({ provider: 'gemini', model: 'gemini-4-argon' })).toContain('with your Google Gemini API key');
    expect(plannerWords({ provider: 'deepseek', model: 'deepseek-chat' })).toContain('with your DeepSeek API key');
    expect(plannerWords({ provider: 'openrouter', model: 'z-ai/glm-5.3' })).toContain('with your OpenRouter key');
    expect(plannerWords({ provider: 'none', model: 'auto' })).toBe('You: no planner is chosen');
    expect(plannerWords({ provider: 'fake', model: 'fake-planner' })).toBe('A test planner (no model)');
    // One this interface does not know is shown as it is, cleaned.
    expect(plannerWords({ provider: 'somewhere', model: 'm-1' })).toBe('somewhere · m-1');
  });

  it('says where the key stands, and nothing of the key', () => {
    expect(keyWords('stored')).toBe('Stored on this computer');
    expect(keyWords('environment')).toBe('Taken from this computer’s environment');
    expect(keyWords('missing')).toBe('Not stored yet');
    expect(keyWords('not needed')).toBe('Not needed');
    expect(keyWords('something new')).toBe('something new');
  });
});
