/**
 * Trust per setting (2026-11-18). One hash covered the whole list of what a project's files
 * loosen: switching one thing on asked a person to trust everything again, switching one off
 * untrusted the rest, and one "Trust" approved whatever else happened to wait.
 */
import { describe, expect, it } from 'vitest';
import { looseningId, projectPolicy } from './project-policy.js';

const config = (over: Record<string, unknown> = {}) => ({
  name: 'config.yaml',
  autonomy: { 'package.install': 'auto' },
  auto_verification: true,
  worktree_files: [{ from: '.env.agents.local', to: '.env' }],
  ...over,
});
const idOf = (p: ReturnType<typeof projectPolicy>, setting: string) =>
  p.loosening.find((l) => l.setting === setting)?.id as string;

describe('trust in one setting at a time', () => {
  it('names each setting by what it is, and nothing applies until its own trust', () => {
    const p = projectPolicy([config()], null);
    expect(p.loosening.map((l) => [l.setting, l.trusted])).toEqual([
      ['autonomy.package.install', false],
      ['verification.auto_on_completion', false],
      ['worktrees.files', false],
    ]);
    expect(new Set(p.loosening.map((l) => l.id)).size).toBe(3);
    expect(p.trusted).toBe(false);
    expect(p.autonomy['package.install']).toBeUndefined();
    expect(p.auto_verification).toBe(false);
    expect(p.worktree_files).toEqual([]);
    expect(p.worktree_files_held).toHaveLength(1);
    // The id is of exactly this: the same setting to another value, or in another file, is another.
    const l = p.loosening[0] as (typeof p.loosening)[number];
    expect(l.id).toBe(looseningId(l));
    expect(looseningId({ ...l, to: 'manual' })).not.toBe(l.id);
    expect(looseningId({ ...l, source: 'policies/team.yaml' })).not.toBe(l.id);
  });

  it('applies the one that is trusted and none of the others', () => {
    const asked = projectPolicy([config()], null);
    const install = idOf(asked, 'autonomy.package.install');
    const p = projectPolicy([config()], { hash: null, items: [install] });
    expect(p.loosening.map((l) => [l.setting, l.trusted])).toEqual([
      ['autonomy.package.install', true],
      ['verification.auto_on_completion', false],
      ['worktrees.files', false],
    ]);
    expect(p.autonomy['package.install']).toBe('auto');
    // What merely waited beside it was not switched on with it.
    expect(p.auto_verification).toBe(false);
    expect(p.worktree_files).toEqual([]);
    expect(p.trusted).toBe(false);
  });

  it('keeps the others trusted when one is switched off, and asks again for one switched back on with another value', () => {
    const asked = projectPolicy([config()], null);
    const all = asked.loosening.map((l) => l.id);
    // Automatic checks are switched off in the file: what stays on stays in force.
    const fewer = projectPolicy([config({ auto_verification: false })], { hash: asked.loosening_hash, items: all });
    expect(fewer.loosening.map((l) => [l.setting, l.trusted])).toEqual([
      ['autonomy.package.install', true],
      ['worktrees.files', true],
    ]);
    expect(fewer.trusted).toBe(true);
    expect(fewer.autonomy['package.install']).toBe('auto');
    // The same setting with another value is another setting to trust.
    const other = projectPolicy([config({ worktree_files: [{ from: '.env', to: '.env' }] })], {
      hash: null,
      items: all,
    });
    expect(other.loosening.find((l) => l.setting === 'worktrees.files')?.trusted).toBe(false);
    expect(other.worktree_files).toEqual([]);
    expect(other.autonomy['package.install']).toBe('auto');
  });

  it('still takes the whole list as one, as a trust file from before holds it', () => {
    const asked = projectPolicy([config()], null);
    const whole = projectPolicy([config()], asked.loosening_hash);
    expect(whole.trusted).toBe(true);
    expect(whole.loosening.every((l) => l.trusted)).toBe(true);
    expect(whole.auto_verification).toBe(true);
    // The list changed since: a name for the whole of the old one trusts nothing of the new.
    const changed = projectPolicy([config({ auto_approve: true })], asked.loosening_hash);
    expect(changed.loosening.every((l) => !l.trusted)).toBe(true);
    expect(changed.auto_approve).toBe(false);
    expect(changed.auto_verification).toBe(false);
  });

  it('trusts each file, each program and each variable on its own', () => {
    const src = {
      name: 'config.yaml',
      worktree_files: [{ from: '.env.agents.local', to: '.env' }, { from: 'apps/api/.env.local' }],
      execution: { binaries: ['docker', 'terraform'], env_passthrough: ['CI', 'REGION'] },
    };
    const asked = projectPolicy([src], null);
    const pick = (setting: string, to: string) =>
      asked.loosening.find((l) => l.setting === setting && l.to === to)?.id as string;
    const p = projectPolicy([src], {
      hash: null,
      items: [
        pick('worktrees.files', 'apps/api/.env.local'),
        pick('execution.binaries', 'docker'),
        pick('execution.env_passthrough', 'REGION'),
      ],
    });
    expect(p.worktree_files.map((f) => f.from)).toEqual(['apps/api/.env.local']);
    expect(p.worktree_files_held.map((f) => f.from)).toEqual(['.env.agents.local']);
    expect(p.execution.binaries).toContain('docker');
    expect(p.execution.binaries).not.toContain('terraform');
    expect(p.execution.env_passthrough).toEqual(['REGION']);
  });

  it('never loosens for an id that names nothing in the files', () => {
    const p = projectPolicy([config()], { hash: 'made-up', items: ['made-up', '', 'ffffffffffffffff'] });
    expect(p.loosening.every((l) => !l.trusted)).toBe(true);
    // A tightening needs no trust, with or without one.
    const tight = projectPolicy([{ name: 'config.yaml', autonomy: { 'network.fetch': 'manual' } }], null);
    expect(tight.autonomy['network.fetch']).toBe('manual');
    expect(tight.loosening).toEqual([]);
    expect(tight.trusted).toBe(true);
  });
});
