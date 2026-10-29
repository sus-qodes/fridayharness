/**
 * A project's own policy and the trust boundary (plan M6b, ADR-0028; spec Part 07 §3, §11).
 */
import { describe, expect, it } from 'vitest';
import { projectPolicy } from './index.js';

const config = { name: 'config.yaml', autonomy: { 'git.push': 'auto', 'package.install': 'manual' } };
const infra = {
  name: 'policies/infra.yaml',
  deny: { write: ['infra/**'] },
  risk: { 'shell.git.commit': 'low', 'network.read': 'high' },
  teams: { frontend: { write: ['frontend/**', 'shared/**'] } },
};

describe('project policy', () => {
  it('applies what tightens at once, and holds back what loosens until this clone trusts it', () => {
    const untrusted = projectPolicy([config, infra], null);
    expect(untrusted.trusted).toBe(false);
    expect(untrusted.loosening.map((l) => [l.setting, l.source, l.to])).toEqual([
      ['autonomy.git.push', 'config.yaml', 'auto'],
      ['risk.shell.git.commit', 'policies/infra.yaml', 'low'],
    ]);
    expect(untrusted.autonomy).toEqual({ 'package.install': 'manual' });
    expect(untrusted.risk).toEqual({ 'network.read': 'high' });
    expect(untrusted.deny.write).toEqual(['infra/**']);
    expect(untrusted.teams.frontend).toEqual([
      { source: 'policies/infra.yaml', write: ['frontend/**', 'shared/**'], read: [] },
    ]);

    const trusted = projectPolicy([config, infra], untrusted.loosening_hash);
    expect(trusted.trusted).toBe(true);
    expect(trusted.autonomy).toEqual({ 'git.push': 'auto', 'package.install': 'manual' });
    expect(trusted.risk).toEqual({ 'shell.git.commit': 'low', 'network.read': 'high' });
    expect(trusted.version).not.toBe(untrusted.version);
  });

  it('is untrusted again when the loosening changes, and the strictest source wins', () => {
    const first = projectPolicy([config], null);
    const changed = projectPolicy(
      [{ ...config, autonomy: { 'git.push': 'auto', 'network.publish': 'auto' } }],
      first.loosening_hash,
    );
    expect(changed.trusted).toBe(false);
    expect(changed.autonomy['network.publish']).toBeUndefined();
    const strict = projectPolicy(
      [config, { name: 'policies/strict.yaml', autonomy: { 'git.push': 'manual' } }],
      projectPolicy([config], null).loosening_hash,
    );
    expect(strict.autonomy['git.push']).toBe('manual');
  });

  it('treats lower enforcement, reservations off and auto-approved plans as loosening', () => {
    const p = projectPolicy(
      [{ name: 'config.yaml', enforcement_required: 'L0', reservations_mode: 'off', auto_approve: true }],
      null,
    );
    expect(p.loosening.map((l) => l.setting)).toEqual([
      'master_brain.auto_approve',
      'reservations.mode',
      'security.enforcement_required',
    ]);
    expect(p).toMatchObject({ enforcement_required: 'L1', reservations_mode: 'hybrid', auto_approve: false });
    const t = projectPolicy(
      [{ name: 'config.yaml', enforcement_required: 'L0', reservations_mode: 'off', auto_approve: true }],
      p.loosening_hash,
    );
    expect(t).toMatchObject({ enforcement_required: 'L0', reservations_mode: 'off', auto_approve: true });
    // Nothing loosens: nothing to trust.
    expect(projectPolicy([{ name: 'config.yaml', enforcement_required: 'L2' }], null)).toMatchObject({
      trusted: true,
      loosening_hash: null,
      enforcement_required: 'L2',
    });
  });
});
