import type { BrainStatusView } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { makeRun, makeSnapshot } from '../test/fixtures.js';
import { clampNumber, plannerSteps, readLoosening, worktreesInUse } from './settings.js';
import { HOSTILE } from './test-support.js';

const brain = (over: Partial<BrainStatusView> = {}): BrainStatusView => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  remote: true,
  allow_remote: false,
  approved_here: false,
  endpoint: null,
  ignored_base_url: null,
  key: 'missing',
  planner_available: false,
  reason: 'no key',
  auto_approve: false,
  escalate_after_failures: 2,
  max_replans: 3,
  daily_budget_usd: 5,
  spent_today_usd: 0,
  cursor: 0,
  head: 0,
  ...over,
});

const POLICY = {
  policy: {
    version: 'v1',
    loosening: [{ source: '.friday/policy.yaml', setting: 'autonomy.git.push', from: 'manual', to: HOSTILE }],
    loosening_hash: 'abc123def4567890',
    trusted: false,
  },
};

describe('settings helpers', () => {
  it('clamps numbers', () => {
    expect(clampNumber('', 0, 1)).toBeNull();
    expect(clampNumber('abc', 0, 1)).toBeNull();
    expect(clampNumber('5', 0, 1)).toBe(1);
    expect(clampNumber('-1', 0, 1)).toBe(0);
  });

  it('reads both policy shapes', () => {
    expect(readLoosening(POLICY as never)).toEqual({
      items: POLICY.policy.loosening,
      hash: 'abc123def4567890',
      trusted: false,
    });
    expect(
      readLoosening({
        policy: {
          version: 'v',
          files: [],
          errors: [],
          loosening: { items: [{ setting: 's' }], hash: 'h', trusted: true },
        },
      } as never),
    ).toEqual({
      items: [{ source: '', setting: 's', from: '', to: '' }],
      hash: 'h',
      trusted: true,
    });
    expect(readLoosening(null)).toEqual({ items: [], hash: null, trusted: false });
  });

  it('lists only the planner steps still needed', () => {
    expect(plannerSteps(brain(), 7).map((s) => s.command ?? s.text)).toEqual([
      'friday secrets set anthropic',
      'friday brain allow-remote --budget 7',
      expect.stringContaining('providers.anthropic.allow_remote: true'),
      expect.stringContaining('Restart Friday'),
    ]);
    expect(plannerSteps(brain({ key: 'stored', approved_here: true }), 7).map((s) => s.command ?? s.text)).toEqual([
      expect.stringContaining('allow_remote'),
      expect.stringContaining('Restart'),
    ]);
  });

  it('offers a planner on this machine its server and model, never an Anthropic key (plan M12.1)', () => {
    const local = brain({ provider: 'local', model: 'qwen2.5:7b', remote: false, key: 'not needed' });
    expect(plannerSteps(local, 7).map((s) => s.command ?? s.text)).toEqual(['friday doctor']);
    expect(JSON.stringify(plannerSteps(local, 7))).not.toMatch(/anthropic|allow-remote/i);
  });

  it('counts the worktrees in use once per folder, for live runs with a ready workspace outside the checkout', () => {
    const board = makeSnapshot({
      runs: {
        a: makeRun({ run_id: 'a', execution_root: 'C:/wt/a' }),
        a2: makeRun({ run_id: 'a2', status: 'SUSPENDED', execution_root: 'C:\\wt\\A\\' }),
        b: makeRun({ run_id: 'b', status: 'STARTING', execution_root: 'C:/wt/b' }),
        ended: makeRun({ run_id: 'ended', status: 'ENDED', execution_root: 'C:/wt/c' }),
        pending: makeRun({ run_id: 'pending', workspace: 'pending' as never, execution_root: 'C:/wt/d' }),
        main: makeRun({ run_id: 'main', execution_root: 'C:/demo/shop' }),
      },
    });
    expect(worktreesInUse(board)).toBe(2);
    expect(worktreesInUse(null)).toBe(0);
    expect(worktreesInUse(makeSnapshot())).toBe(0);
  });
});
