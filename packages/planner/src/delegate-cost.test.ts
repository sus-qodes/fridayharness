import { describe, expect, it } from 'vitest';
import { type DelegationCandidate, type DelegationTask, delegate, isSmallTask } from './delegate.js';

const agent = (key: string, extra: Partial<DelegationCandidate> = {}): DelegationCandidate => ({
  agent_id: `agent_${key}`,
  agent_key: key,
  role: 'backend',
  status: 'AVAILABLE',
  shadow: false,
  harness_live: true,
  current_task_id: null,
  completed: 0,
  failed: 0,
  recent_paths: [],
  goals_done: [],
  cost: 0,
  ...extra,
});
const task = (extra: Partial<DelegationTask> = {}): DelegationTask => ({
  task_id: 'task_1',
  goal_id: null,
  role: 'backend',
  write: ['backend/src/a.ts'],
  kind: 'implementation',
  risk_level: 'low',
  ...extra,
});

describe('the cheapest capable agent (plan M13.3)', () => {
  // The standard agent's model fits better, so the score alone would choose it.
  const cheap = agent('be-cheap', { cost_class: 'cheap', model_fit: 0.7 });
  const std = agent('be-std', { cost_class: 'standard', model_fit: 0.9 });

  it('gives a small, low-risk task to the cheapest agent of its role whose model fits', () => {
    const d = delegate(task(), [std, cheap], []);
    expect(d.agent_key).toBe('be-cheap');
    expect(d.reason).toMatch(/a small, low-risk task: the cheapest capable agent \(cheap\), be-cheap/);
    // A free agent is cheaper still.
    expect(
      delegate(task(), [std, cheap, agent('be-local', { cost_class: 'free', model_fit: 0.65 })], []).agent_key,
    ).toBe('be-local');
  });

  it('delegates a task that is not small by the score, as before', () => {
    for (const t of [
      task({ risk_level: 'medium' }),
      task({ kind: 'review', write: [] }),
      task({ write: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }),
    ]) {
      expect(isSmallTask(t)).toBe(false);
      expect(delegate(t, [std, cheap], []).agent_key).toBe('be-std');
    }
  });

  it('counts named files, never globs: a scope that may cover anything is not small', () => {
    for (const write of [['backend/src/a.ts'], ['a.ts', 'b.ts', 'c.ts']])
      expect(isSmallTask(task({ write }))).toBe(true);
    for (const write of [['**'], ['backend/**'], ['src/*.ts'], ['a.ts', 'lib/**'], ['src/[ab].ts'], ['src/{a,b}.ts']]) {
      const t = task({ write });
      expect(isSmallTask(t), write.join(',')).toBe(false);
      expect(delegate(t, [std, cheap], []).agent_key, write.join(',')).toBe('be-std');
    }
  });

  it('passes over a cheaper agent whose model routing knows to fit poorly, and keeps the role first', () => {
    const weak = agent('be-weak', { cost_class: 'free', model_fit: 0.4 });
    expect(delegate(task(), [std, weak], []).agent_key).toBe('be-std');
    // A model routing does not know (fit 0) does not rule an agent out.
    const unknown = agent('be-unknown', { cost_class: 'cheap', model_fit: 0 });
    expect(delegate(task(), [std, unknown], []).agent_key).toBe('be-unknown');
    // A cheaper agent of another role does not take a task that names a role.
    const other = agent('fe-cheap', { role: 'frontend', cost_class: 'cheap', model_fit: 0.9 });
    expect(delegate(task(), [std, other], []).agent_key).toBe('be-std');
  });

  it('changes nothing when every agent is of one class', () => {
    const a = agent('be-a', { model_fit: 0.7 });
    const b = agent('be-b', { model_fit: 0.9 });
    const d = delegate(task(), [a, b], []);
    expect(d.agent_key).toBe('be-b');
    expect(d.reason).not.toMatch(/cheapest/);
  });
});
