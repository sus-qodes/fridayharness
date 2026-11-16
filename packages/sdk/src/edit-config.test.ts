import { newId } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { EDITABLE_SETTINGS, editConfigText, parseConfig, renderInitialConfig } from './config.js';

const fresh = () => renderInitialConfig(newId('proj'), 'shop');

describe('editConfigText', () => {
  it('sets the settings the interface changes, keeping every comment and the other values', () => {
    const before = fresh();
    const { text, changed } = editConfigText(before, {
      'verification.auto_on_completion': true,
      'master_brain.provider': 'claude-code',
      'providers.claude-code.allow_remote': true,
      'providers.claude-code.daily_budget_usd': 2,
    });
    expect(changed).toEqual([
      'verification.auto_on_completion',
      'master_brain.provider',
      'providers.claude-code.allow_remote',
      'providers.claude-code.daily_budget_usd',
    ]);
    const c = parseConfig(text);
    expect(c.verification.auto_on_completion).toBe(true);
    expect(c.master_brain.provider).toBe('claude-code');
    expect(c.providers['claude-code']).toMatchObject({ allow_remote: true, daily_budget_usd: 2 });
    // The other providers and settings are as they were.
    expect(c.providers.anthropic?.allow_remote).toBe(parseConfig(before).providers.anthropic?.allow_remote);
    expect(c.project).toEqual(parseConfig(before).project);
    // Comments survive: every comment line of the template is still there.
    for (const line of before.split('\n').filter((l) => l.trimStart().startsWith('#')))
      expect(text).toContain(line.trim());
  });

  it('changes nothing, and says so, when a setting already has that value', () => {
    const once = editConfigText(fresh(), { 'master_brain.provider': 'claude-code' }).text;
    expect(editConfigText(once, { 'master_brain.provider': 'claude-code' })).toEqual({ text: once, changed: [] });
  });

  it('refuses a setting the interface does not change, a value it does not take, and broken YAML', () => {
    expect(() => editConfigText(fresh(), { 'verification.checks': [] })).toThrow(/not a setting the interface changes/);
    expect(() => editConfigText(fresh(), { sandbox: true })).toThrow(/not a setting/);
    expect(() => editConfigText(fresh(), { 'master_brain.provider': 'gpt' })).toThrow(/master_brain.provider/);
    expect(() => editConfigText(fresh(), { 'providers.claude-code.daily_budget_usd': -1 })).toThrow(/daily_budget_usd/);
    expect(() => editConfigText('a: [', { 'master_brain.provider': 'none' })).toThrow(/not valid YAML/);
    // Only these four, each a loosening the trust rule or this machine's consent still gates.
    expect(Object.keys(EDITABLE_SETTINGS)).toHaveLength(4);
  });
});
