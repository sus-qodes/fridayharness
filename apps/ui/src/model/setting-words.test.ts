import { describe, expect, it } from 'vitest';
import { settingName, settingNames } from './setting-words.js';

describe('a setting of config.yaml as what it is (2026-11-17)', () => {
  it('names the settings Settings changes', () => {
    expect(settingName('providers.anthropic.allow_remote')).toBe('planning with an Anthropic key');
    expect(settingName('providers.claude-code.daily_budget_usd')).toBe(
      'the project’s spending limit for planning through Claude Code',
    );
    expect(settingName('master_brain.auto_approve')).toBe('starting plans without your approval');
    expect(settingName('verification.auto_on_completion')).toBe('checking finished work automatically');
  });

  it('names a key by its section when it has no name of its own, the most specific section first', () => {
    expect(settingName('verification.checks.0.command')).toBe('the project’s checks');
    expect(settingName('verification.checks')).toBe('the project’s checks');
    expect(settingName('verification.something')).toBe('how work is verified');
    expect(settingName('autonomy.package.install')).toBe('what agents may do without asking');
    expect(settingName('providers.local.base_url')).toBe('the planner’s provider settings');
    expect(settingName('scopes')).toBe('the named scopes');
  });

  it('shows a key it does not know as written, and says a setting once', () => {
    expect(settingName('future.key')).toBe('future.key');
    expect(settingName(`a${String.fromCodePoint(0x200b)}b`)).toBe('a⟨U+200B⟩b');
    // A section's name is a prefix of its keys, never of another word.
    expect(settingName('scopesx.api')).toBe('scopesx.api');
    expect(settingNames(['scopes.api', 'scopes.web', 'daemon.port'])).toEqual([
      'the named scopes',
      'the port Friday answers on',
    ]);
  });
});
