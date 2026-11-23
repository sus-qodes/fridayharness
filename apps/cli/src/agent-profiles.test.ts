import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentProfile } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentProfiles, DEFAULT_CAP_USD, effectiveCap, optionFlags, validateOptions } from './agent-profiles.js';

/** The remembered agents and the spending limit per attempt (2026-11-17), in a temporary folder. */

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'friday-profiles-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, 'agents.json');
const profile = (over: Partial<AgentProfile> = {}): AgentProfile => ({
  agent_key: 'claude-1',
  host: 'claude-code',
  role: 'developer',
  options: {},
  autostart: true,
  updated_at: '2026-11-17T00:00:00.000Z',
  ...over,
});

describe('the spending limit per attempt', () => {
  it('is the person’s own when they set one, none included', () => {
    for (const signIn of ['subscription', 'api_key', 'none', undefined]) {
      expect(effectiveCap({ max_budget_usd: 12 }, signIn)).toBe(12);
      expect(effectiveCap({ max_budget_usd: null }, signIn)).toBeNull();
    }
  });

  it('is none for a subscription, and the default wherever attempts are charged or Friday cannot tell', () => {
    expect(effectiveCap({}, 'subscription')).toBeNull();
    for (const signIn of ['api_key', 'signed_in', 'none', 'unknown', undefined, 'anything-else']) {
      expect(effectiveCap({}, signIn), String(signIn)).toBe(DEFAULT_CAP_USD);
    }
    expect(DEFAULT_CAP_USD).toBe(5);
  });

  it('validates an amount, takes null as none, and leaves an unset one undecided', () => {
    expect(validateOptions('claude-code', {})).toEqual({});
    expect(validateOptions('claude-code', { max_budget_usd: null })).toEqual({ max_budget_usd: null });
    expect(validateOptions('claude-code', { max_budget_usd: 1000 })).toEqual({ max_budget_usd: 1000 });
    expect(validateOptions('claude-code', { max_budget_usd: 0.01 })).toEqual({ max_budget_usd: 0.01 });
    for (const bad of [0, -1, 1000.01, Number.NaN, Number.POSITIVE_INFINITY, '5', true, [], {}]) {
      expect(() => validateOptions('claude-code', { max_budget_usd: bad }), String(bad)).toThrow(/max_budget_usd/);
    }
    // Codex has no such limit: neither an amount nor "none" is taken for it.
    expect(() => validateOptions('codex', { max_budget_usd: 5 })).toThrow(/max_budget_usd/);
    expect(() => validateOptions('codex', { max_budget_usd: null })).toThrow(/max_budget_usd/);
  });

  it('passes the flag for an amount only', () => {
    expect(optionFlags('claude-code', { max_budget_usd: 2.5 })).toEqual(['--max-budget-usd=2.5']);
    expect(optionFlags('claude-code', { max_budget_usd: null })).toEqual([]);
    expect(optionFlags('claude-code', {})).toEqual([]);
    expect(optionFlags('codex', { sandbox: 'read-only' })).toEqual(['--sandbox=read-only']);
  });
});

describe('remembered agents', () => {
  it('drops the old default of 1 from a file written before limits were a person’s choice', () => {
    writeFileSync(
      file(),
      JSON.stringify({
        agents: [
          profile({ options: { max_budget_usd: 1, effort: 'high' } }),
          profile({ agent_key: 'claude-2', options: { max_budget_usd: 3 } }),
          profile({ agent_key: 'codex-1', host: 'codex', options: { sandbox: 'read-only' } }),
        ],
      }),
    );
    const profiles = new AgentProfiles(dir);
    expect(profiles.list().map((p) => [p.agent_key, p.options])).toEqual([
      // The 1 nobody chose is gone (today's default applies at the start); the effort is kept.
      ['claude-1', { effort: 'high' }],
      // Another amount was a person's: kept.
      ['claude-2', { max_budget_usd: 3 }],
      ['codex-1', { sandbox: 'read-only' }],
    ]);
    // Reading does not rewrite the file; the next save does, with the version.
    expect(JSON.parse(readFileSync(file(), 'utf8')).version).toBeUndefined();
    profiles.save(profile({ agent_key: 'claude-3', options: { max_budget_usd: 1 } }));
    const written = JSON.parse(readFileSync(file(), 'utf8')) as { version: number; agents: AgentProfile[] };
    expect(written.version).toBe(2);
    expect(written.agents.find((a) => a.agent_key === 'claude-1')?.options).toEqual({ effort: 'high' });
    // From this version on, a 1 in the file is a 1 a person set.
    expect(new AgentProfiles(dir).get('claude-3')?.options).toEqual({ max_budget_usd: 1 });
  });

  it('keeps "no limit" across a save and a read', () => {
    const profiles = new AgentProfiles(dir);
    profiles.save(profile({ options: { max_budget_usd: null } }));
    expect(readFileSync(file(), 'utf8')).toContain('"max_budget_usd": null');
    expect(new AgentProfiles(dir).get('claude-1')?.options).toEqual({ max_budget_usd: null });
  });

  it('replaces an agent saved again, forgets one, and skips what no longer validates', () => {
    const profiles = new AgentProfiles(dir);
    profiles.save(profile());
    profiles.save(profile({ role: 'backend' }));
    expect(profiles.list()).toHaveLength(1);
    expect(profiles.get('claude-1')?.role).toBe('backend');
    profiles.forget('claude-1');
    expect(profiles.list()).toEqual([]);
    writeFileSync(
      file(),
      JSON.stringify({
        version: 2,
        agents: [
          profile({ options: { max_budget_usd: 5000 } }),
          profile({ agent_key: 'BAD KEY' }),
          profile({ agent_key: 'ok-1' }),
        ],
      }),
    );
    expect(profiles.list().map((p) => p.agent_key)).toEqual(['ok-1']);
    writeFileSync(file(), '{ not json');
    expect(profiles.list()).toEqual([]);
  });
});
