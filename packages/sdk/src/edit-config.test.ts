import { newId } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import {
  ASKABLE_COMMAND_CLASSES,
  EDITABLE_SETTINGS,
  editConfigText,
  parseConfig,
  renderInitialConfig,
  settingPath,
} from './config.js';

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

  it('changes only the lines it has to: every other line is as it was, byte for byte', () => {
    const before = fresh();
    const { text } = editConfigText(before, {
      'verification.auto_on_completion': true,
      'providers.claude-code.allow_remote': true,
      'providers.claude-code.daily_budget_usd': 2,
    });
    const was = before.split('\n');
    const is = text.split('\n');
    // One line changed where it stood, and three were added after the providers section.
    const changedLine = was.findIndex((l) => l.includes('auto_on_completion: false'));
    expect(is[changedLine]).toBe(was[changedLine]?.replace('false', 'true'));
    const added = is.filter((l) => !was.includes(l));
    expect(added).toEqual([
      '  auto_on_completion: true',
      '  claude-code:',
      '    allow_remote: true',
      '    daily_budget_usd: 2',
    ]);
    // Every other line of the file is still there, in order, spacing and comments untouched.
    const kept = was.filter((_, i) => i !== changedLine);
    let at = 0;
    for (const line of kept) {
      const found = is.indexOf(line, at);
      expect(found, line).toBeGreaterThanOrEqual(at);
      at = found + 1;
    }
    expect(text).toContain('  port: 0            # 0 = pick a free port each start');
    // And a value that had a comment after it keeps the comment.
    const provider = editConfigText(before, { 'master_brain.provider': 'none' }).text;
    expect(provider).toContain('  provider: none   # anthropic | claude-code | local | fake | none');
    expect(provider.split('\n')).toHaveLength(was.length);
  });

  it('keeps a Windows checkout’s line endings and a byte-order mark', () => {
    const crlf = fresh().replace(/\n/g, '\r\n');
    const out = editConfigText(crlf, { 'verification.auto_on_completion': true }).text;
    expect(out.includes('\r\n')).toBe(true);
    // No line of it ends in a bare line feed.
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
    expect(parseConfig(out).verification.auto_on_completion).toBe(true);
    const withBom = `\uFEFF${fresh()}`;
    const kept = editConfigText(withBom, { 'master_brain.provider': 'claude-code' }).text;
    expect(kept.charCodeAt(0)).toBe(0xfeff);
    expect(kept.slice(1)).not.toContain('\uFEFF');
    expect(parseConfig(kept.slice(1)).master_brain.provider).toBe('claude-code');
  });

  it('sets a key under a section that is empty or written on one line', () => {
    const base = 'project:\n  id: proj_00000000000000000000000001\n  name: shop\n';
    // `providers:` with nothing under it (its lines commented out) is an empty section.
    const empty = editConfigText(`${base}providers:\n  # anthropic:\n  #   allow_remote: false\n`, {
      'providers.claude-code.allow_remote': true,
    }).text;
    expect(parseConfig(empty).providers['claude-code']?.allow_remote).toBe(true);
    expect(empty).toContain('# anthropic:');
    const tilde = editConfigText(`${base}verification: ~\n`, { 'verification.auto_on_completion': true }).text;
    expect(parseConfig(tilde).verification.auto_on_completion).toBe(true);
    const flow = editConfigText(`${base}verification: { auto_on_completion: false, checks: [] }\n`, {
      'verification.auto_on_completion': true,
    }).text;
    expect(parseConfig(flow).verification).toMatchObject({ auto_on_completion: true, checks: [] });
    // A file with no such section at all gets one, apart from what was there.
    const none = editConfigText(base, { 'master_brain.provider': 'claude-code' }).text;
    expect(none).toBe(`${base}\nmaster_brain:\n  provider: claude-code\n`);
    // A file that does not end in a line break gets its new lines on lines of their own.
    const cut = editConfigText(base.trimEnd(), { 'master_brain.provider': 'none' }).text;
    expect(parseConfig(cut).master_brain.provider).toBe('none');
    expect(parseConfig(cut).project.name).toBe('shop');
  });

  it('refuses, in words, what it cannot change without touching something else', () => {
    const base = 'project:\n  id: proj_00000000000000000000000001\n  name: shop\n';
    // A section that is a reference to another: writing into it would write into both.
    const aliased = `${base}defaults: &d\n  allow_remote: false\nproviders:\n  anthropic: *d\n  claude-code: *d\n`;
    expect(() => editConfigText(aliased, { 'providers.claude-code.allow_remote': true })).toThrow(
      /providers\.claude-code is not a section of settings/,
    );
    // A section that is a plain value.
    expect(() => editConfigText(`${base}verification: later\n`, { 'verification.auto_on_completion': true })).toThrow(
      /verification is not a section of settings/,
    );
    for (const bad of [aliased, `${base}verification: later\n`]) {
      try {
        editConfigText(bad, { 'verification.auto_on_completion': true, 'providers.claude-code.allow_remote': true });
      } catch (e) {
        // Friday's own refusal, never an internal error.
        expect((e as { name?: string }).name).toBe('FridayError');
      }
    }
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
    // Only these, each one still gated: a loosening by the trust rule, spending by this machine's consent.
    expect(Object.keys(EDITABLE_SETTINGS).sort()).toEqual(
      [
        'verification.auto_on_completion',
        'master_brain.provider',
        'master_brain.auto_approve',
        'providers.claude-code.allow_remote',
        'providers.claude-code.daily_budget_usd',
        'providers.anthropic.allow_remote',
        'providers.anthropic.daily_budget_usd',
        ...ASKABLE_COMMAND_CLASSES.map((c) => `autonomy.${c}`),
      ].sort(),
    );
  });

  it('sets what agents may run without asking under its own key, dot and all (2026-11-17)', () => {
    const before = fresh();
    expect(settingPath('autonomy.package.install')).toEqual(['autonomy', 'package.install']);
    expect(settingPath('autonomy.unknown')).toEqual(['autonomy', 'unknown']);
    expect(settingPath('providers.claude-code.allow_remote')).toEqual(['providers', 'claude-code', 'allow_remote']);
    const on = editConfigText(before, { 'autonomy.package.install': 'auto', 'autonomy.unknown': 'auto' });
    expect(on.changed).toEqual(['autonomy.package.install', 'autonomy.unknown']);
    expect(parseConfig(on.text).autonomy).toEqual({ 'package.install': 'auto', unknown: 'auto' });
    // Every line that was there is still there, in order: the settings are new lines.
    const was = before.split('\n');
    const now = on.text.split('\n');
    let at = 0;
    for (const line of was) {
      at = now.indexOf(line, at);
      expect(at, line).toBeGreaterThanOrEqual(0);
      at += 1;
    }
    // Asking again is the value replaced where it stands; the other stays.
    const off = editConfigText(on.text, { 'autonomy.package.install': 'review' });
    expect(off.changed).toEqual(['autonomy.package.install']);
    expect(parseConfig(off.text).autonomy).toEqual({ 'package.install': 'review', unknown: 'auto' });
    expect(off.text.split('\n')).toHaveLength(now.length);
    // In a file that already has the section.
    const more = editConfigText(off.text, { 'autonomy.git.mutate': 'auto' });
    expect(parseConfig(more.text).autonomy).toEqual({
      'package.install': 'review',
      unknown: 'auto',
      'git.mutate': 'auto',
    });
  });

  it('never loosens what always asks or is never allowed, and takes no level but ask or allow', () => {
    for (const cls of ['git.push', 'git.force', 'network.publish', 'secrets.read', 'friday.internal', 'read.local']) {
      expect(() => editConfigText(fresh(), { [`autonomy.${cls}`]: 'auto' }), cls).toThrow(
        /not a setting the interface changes/,
      );
    }
    expect(() => editConfigText(fresh(), { 'autonomy.package.install': 'never' })).toThrow(/autonomy.package.install/);
    expect(() => editConfigText(fresh(), { 'autonomy.package.install': true })).toThrow(/autonomy.package.install/);
    expect(() => editConfigText(fresh(), { autonomy: { 'git.push': 'auto' } })).toThrow(/not a setting/);
  });

  it('sets plan approval and the settings of planning with an Anthropic key', () => {
    const { text, changed } = editConfigText(fresh(), {
      'master_brain.auto_approve': true,
      'providers.anthropic.allow_remote': true,
      'providers.anthropic.daily_budget_usd': 20,
    });
    expect(changed).toEqual([
      'master_brain.auto_approve',
      'providers.anthropic.allow_remote',
      'providers.anthropic.daily_budget_usd',
    ]);
    const c = parseConfig(text);
    expect(c.master_brain.auto_approve).toBe(true);
    expect(c.providers.anthropic).toMatchObject({ allow_remote: true, daily_budget_usd: 20 });
    expect(() => editConfigText(fresh(), { 'master_brain.auto_approve': 'yes' })).toThrow(/master_brain.auto_approve/);
    expect(() => editConfigText(fresh(), { 'providers.anthropic.daily_budget_usd': 1e9 })).toThrow(/daily_budget_usd/);
  });
});
