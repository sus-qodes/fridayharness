/**
 * The level a session reaches, from evidence (ADR-0010, review F09, plan B21 and M8b): one rule per
 * host whose sessions run Friday's hooks, and what a spawn adapter says of its own hooks.
 */
import { describe, expect, it } from 'vitest';
import { achievedEnforcement, hookEvidenceOf } from './service.js';

const attach = (vendor: string, hooks_seen: boolean, extra: Partial<Parameters<typeof achievedEnforcement>[0]> = {}) =>
  achievedEnforcement({ vendor, attach_mode: 'attach', claimed: null, hooks_seen, host_version: null, ...extra });
const cursor = (hook_failure: string | null, host_version: string | null) =>
  attach('cursor', true, { capabilities: { hook_evidence: { hook_failure, host_version } } });

describe('the level of an attached session', () => {
  it('is L0 for every host until a Friday hook reaches the daemon from it, whatever the client claims', () => {
    for (const vendor of ['claude-code', 'cursor', 'antigravity', 'gemini']) {
      expect(attach(vendor, false, { claimed: 'L1' }), vendor).toMatchObject({ level: 'L0', status: 'observed' });
    }
  });

  it('Gemini CLI: L1 degraded, since a failing hook lets the call through', () => {
    expect(attach('gemini', true)).toMatchObject({ level: 'L1', status: 'degraded' });
  });

  it('Antigravity: L1 unverified, since what it does with a failing hook is not documented', () => {
    expect(attach('antigravity', true)).toMatchObject({ level: 'L1', status: 'unverified' });
  });

  it('Cursor: enforcing only with failClosed permission hooks on a version documented to honour them', () => {
    expect(cursor('fail-closed', '3.24.0')).toMatchObject({ level: 'L1', status: 'enforcing' });
    expect(cursor('fail-closed', '3.25')).toMatchObject({ status: 'enforcing' });
    // The CLI's versions are dates.
    expect(cursor('fail-closed', '2026.10.16')).toMatchObject({ status: 'enforcing' });
    expect(cursor('fail-closed', '2026.9.1')).toMatchObject({ status: 'unverified' });
    // Older than the documentation, or not known: unverified, never enforcing.
    expect(cursor('fail-closed', '2.6.0')).toMatchObject({ level: 'L1', status: 'unverified' });
    expect(cursor('fail-closed', null)).toMatchObject({ status: 'unverified' });
    // A permission hook without failClosed lets a failing call through.
    expect(cursor('fail-open', '3.24.0')).toMatchObject({ level: 'L1', status: 'degraded' });
    // The hooks file could not be read, or a permission hook is not Friday's.
    expect(cursor(null, '3.24.0')).toMatchObject({ level: 'L1', status: 'unverified' });
    expect(attach('cursor', true)).toMatchObject({ status: 'unverified' });
  });

  it('Claude Code: as before, from the version its MCP server reports', () => {
    expect(attach('claude-code', true, { host_version: '2.1.296' })).toMatchObject({ status: 'enforcing' });
    expect(attach('claude-code', true, { host_version: '2.1.250' })).toMatchObject({ status: 'degraded' });
    expect(attach('claude-code', true, { host_version: '2.1' })).toMatchObject({ status: 'unverified' });
  });
});

describe('the level a spawn adapter reports', () => {
  const spawn = (capabilities: Record<string, unknown>) =>
    achievedEnforcement({
      vendor: 'gemini',
      attach_mode: 'spawn',
      claimed: 'L1',
      hooks_seen: true,
      host_version: '0.64.0',
      capabilities,
    });

  it('is degraded, not reported, where its capabilities say its hooks fail open', () => {
    expect(spawn({ hook_failure: 'fail-open' })).toMatchObject({ level: 'L1', status: 'degraded' });
    expect(spawn({})).toMatchObject({ level: 'L1', status: 'reported' });
  });
});

describe('hook evidence', () => {
  it('keeps only what it knows; unknown values are null', () => {
    expect(hookEvidenceOf(undefined)).toEqual({ host_version: null, hook_failure: null });
    expect(hookEvidenceOf({ hook_evidence: { hook_failure: 'sometimes', host_version: 3 } })).toEqual({
      host_version: null,
      hook_failure: null,
    });
    expect(hookEvidenceOf({ hook_evidence: { hook_failure: 'fail-closed', host_version: '3.24.0' } })).toEqual({
      host_version: '3.24.0',
      hook_failure: 'fail-closed',
    });
  });
});

describe('OpenCode A/B enforcement', () => {
  it('stays unverified even when a spawn client claims fail-closed hooks', () => {
    expect(
      achievedEnforcement({
        vendor: 'opencode',
        attach_mode: 'spawn',
        claimed: 'L1',
        hooks_seen: true,
        host_version: '1.19.3',
        capabilities: { hook_failure: 'fail-closed' },
      }),
    ).toMatchObject({ level: 'L1', status: 'unverified' });
  });
});
