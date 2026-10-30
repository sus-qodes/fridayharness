/**
 * A project's own policy and the trust boundary (plan M6b, ADR-0028; spec Part 07 §3, §11).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINARIES, mcpLevel, projectPolicy } from './index.js';

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

  it('applies operations, profile additions and automatic verification only once trusted (ADR-0029)', () => {
    const stripe = {
      description: 'Stripe sandbox tests',
      command: 'node',
      args: ['--test', 'test/stripe.test.mjs'],
      env: { STRIPE_MODE: 'sandbox' },
      credentials: { STRIPE_SECRET_KEY: 'stripe-test' },
      timeout_ms: 60_000,
      roles: [],
    };
    const lint = { command: 'node', args: ['lint.mjs'], env: {}, credentials: {}, timeout_ms: 5000, roles: ['qa'] };
    const source = {
      name: 'config.yaml',
      operations: { 'stripe-test': stripe, lint },
      execution: { binaries: ['node', 'make'], env_passthrough: ['JAVA_HOME'] },
      auto_verification: true,
    };
    const untrusted = projectPolicy([source], null);
    expect(untrusted.loosening.map((l) => [l.setting, l.to])).toEqual([
      ['execution.binaries', 'make'],
      ['execution.env_passthrough', 'JAVA_HOME'],
      ['operations.lint', 'node ["lint.mjs"]; risk medium; timeout 5000 ms; roles qa'],
      [
        'operations.stripe-test',
        'node ["--test","test/stripe.test.mjs"]; env STRIPE_MODE="sandbox"; credentials STRIPE_SECRET_KEY=<secret stripe-test>; risk high; timeout 60000 ms',
      ],
      ['verification.auto_on_completion', 'true'],
    ]);
    expect(untrusted.operations).toEqual({});
    expect(untrusted.operations_held.map((h) => h.name)).toEqual(['lint', 'stripe-test']);
    expect(untrusted.execution).toEqual({ binaries: [...DEFAULT_BINARIES], env_passthrough: [] });
    expect(untrusted.auto_verification).toBe(false);

    const trusted = projectPolicy([source], untrusted.loosening_hash);
    expect(trusted.operations['stripe-test']).toMatchObject({ source: 'config.yaml', risk: 'high' });
    expect(trusted.operations.lint?.risk).toBe('medium');
    expect(trusted.execution).toEqual({ binaries: [...DEFAULT_BINARIES, 'make'], env_passthrough: ['JAVA_HOME'] });
    expect(trusted.auto_verification).toBe(true);

    // A changed argument is a different operation: trusted again before it runs.
    const changed = projectPolicy(
      [{ ...source, operations: { 'stripe-test': { ...stripe, args: ['-e', 'print the key'] }, lint } }],
      untrusted.loosening_hash,
    );
    expect(changed.trusted).toBe(false);
    expect(changed.operations).toEqual({});
    // The description is not part of what is trusted.
    expect(
      projectPolicy(
        [{ ...source, operations: { 'stripe-test': { ...stripe, description: 'reworded' }, lint } }],
        untrusted.loosening_hash,
      ).trusted,
    ).toBe(true);

    // A name two sources declare applies from neither.
    const twice = projectPolicy([source, { name: 'policies/ops.yaml', operations: { lint } }], null);
    const both = projectPolicy([source, { name: 'policies/ops.yaml', operations: { lint } }], twice.loosening_hash);
    expect(Object.keys(both.operations)).toEqual(['stripe-test']);
    expect(both.operations_held.map((h) => [h.name, h.source])).toEqual([
      ['lint', 'config.yaml'],
      ['lint', 'policies/ops.yaml'],
    ]);
  });

  it('judges third-party MCP tools per server: auto after trust, and the strictest source wins (ADR-0030)', () => {
    const config = {
      name: 'config.yaml',
      mcp: { github: { default: 'review', tools: { search_code: 'auto', create_pull_request: 'manual' } } },
    };
    const infra = {
      name: 'policies/infra.yaml',
      mcp: { filesystem: { default: 'never', tools: { read_file: 'auto' } } },
    };
    const untrusted = projectPolicy([config, infra], null);
    expect(untrusted.loosening.map((l) => l.setting)).toEqual(['mcp.filesystem.read_file', 'mcp.github.search_code']);
    expect(mcpLevel(untrusted, 'github', 'search_code')).toBe('review');
    expect(mcpLevel(untrusted, 'github', 'create_pull_request')).toBe('manual');
    expect(mcpLevel(untrusted, 'filesystem', 'read_file')).toBe('never');
    expect(mcpLevel(untrusted, 'slack', 'post_message')).toBe('review');
    const trusted = projectPolicy([config, infra], untrusted.loosening_hash);
    expect(mcpLevel(trusted, 'github', 'search_code')).toBe('auto');
    // The same source's tool level overrides its own default...
    expect(mcpLevel(trusted, 'filesystem', 'read_file')).toBe('auto');
    // ...but not what another source says about the same tool.
    const strict = projectPolicy(
      [config, infra, { name: 'policies/strict.yaml', mcp: { github: { default: 'never' } } }],
      null,
    );
    expect(
      mcpLevel(
        projectPolicy(
          [config, infra, { name: 'policies/strict.yaml', mcp: { github: { default: 'never' } } }],
          strict.loosening_hash,
        ),
        'github',
        'search_code',
      ),
    ).toBe('never');
    expect(trusted.elicitation).toBe(true);
    expect(projectPolicy([config, { name: 'policies/x.yaml', elicitation: false }], null).elicitation).toBe(false);
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

describe('the worktree install (plan Phase 7)', () => {
  it("holds the project's own command and lifecycle scripts until trusted; a detected install needs no trust", () => {
    const own = {
      name: 'config.yaml',
      worktree_setup: { command: 'pnpm', args: ['install', '--frozen-lockfile'], allow_scripts: true },
    };
    const untrusted = projectPolicy([own], null);
    expect(untrusted.loosening.map((l) => [l.setting, l.to])).toEqual([
      ['worktrees.setup.allow_scripts', 'true'],
      ['worktrees.setup.command', 'pnpm install --frozen-lockfile'],
    ]);
    expect(untrusted.worktree_setup).toBeNull();
    expect(untrusted.worktree_setup_held).toEqual({ source: 'config.yaml', reason: 'waits for "friday policy trust"' });
    expect(untrusted.worktree_scripts).toBe(false);
    const trusted = projectPolicy([own], untrusted.loosening_hash);
    expect(trusted.worktree_setup).toEqual({
      source: 'config.yaml',
      command: 'pnpm',
      args: ['install', '--frozen-lockfile'],
    });
    expect(trusted.worktree_setup_held).toBeNull();
    expect(trusted.worktree_scripts).toBe(true);
    // Nothing declared: nothing loosens, and the lockfile decides at the worktree.
    const plain = projectPolicy([{ name: 'config.yaml' }], null);
    expect(plain.trusted).toBe(true);
    expect([plain.worktree_setup, plain.worktree_setup_held, plain.worktree_scripts]).toEqual([null, null, false]);
  });

  it('a trusted sandbox runs what a human would review, and keeps what needs an exact approval', () => {
    const own = { name: 'config.yaml', sandbox: true, autonomy: { 'network.fetch': 'manual' } };
    const untrusted = projectPolicy([own], null);
    expect(untrusted.loosening.map((l) => [l.setting, l.to])).toEqual([['sandbox', 'true']]);
    expect(untrusted.sandbox).toBe(false);
    // Until trusted, nothing runs that would not run anyway; the manual class tightened at once.
    expect(untrusted.autonomy).toEqual({ 'network.fetch': 'manual' });
    const trusted = projectPolicy([own], untrusted.loosening_hash);
    expect(trusted.sandbox).toBe(true);
    expect(trusted.autonomy).toEqual({
      'git.mutate': 'auto',
      'package.install': 'auto',
      'fs.destructive': 'auto',
      'process.kill': 'auto',
      unknown: 'auto',
      // A source's stricter level for a reviewable class is kept.
      'network.fetch': 'manual',
    });
    // git push, publishing and secrets are not reviewable: untouched.
    expect(trusted.autonomy['git.push']).toBeUndefined();
    expect(trusted.autonomy['secrets.read']).toBeUndefined();
  });
});
