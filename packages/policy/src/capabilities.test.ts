/**
 * The capability catalogue and request evaluation (plan M6a, ADR-0027; spec Part 07 §5–§8).
 */
import { describe, expect, it } from 'vitest';
import { type CapabilityRequest, capabilityOf, evaluateCapability, type PathContext } from './index.js';

const ctx: PathContext = {
  projectRoot: 'C:\\demo\\shop',
  stateDir: 'C:\\Users\\me\\AppData\\Local\\Friday',
  windows: true,
};
const task = {
  task_id: 'task_a',
  status: 'RUNNING',
  scope: { write: ['frontend/**'], read: ['frontend/**', 'shared/**'] },
};
const judge = (
  capability: CapabilityRequest['capability'],
  target: string | null,
  extra: Partial<CapabilityRequest> = {},
) => {
  const v = evaluateCapability({ capability, target, task, ctx, ...extra });
  return [v.decision, v.risk];
};

describe('capabilities', () => {
  it('names what was asked in catalogue terms', () => {
    expect(capabilityOf('shell.git.push')).toBe('shell.git.push');
    expect(capabilityOf('git.push')).toBe('shell.git.push');
    expect(capabilityOf('test.local')).toBe('shell.test');
    expect(capabilityOf('fs.write')).toBe('file.write');
    expect(capabilityOf('teleport')).toBeNull();
  });

  it('judges a request by scope, protected files, autonomy and risk', () => {
    expect(judge('file.write', 'frontend/src/a.ts')).toEqual(['allow', 'medium']);
    expect(judge('file.write', 'backend/src/a.ts')).toEqual(['review', 'medium']);
    expect(judge('file.write', '.friday/run/daemon.json')).toEqual(['deny', 'medium']);
    expect(judge('file.write', 'C:\\elsewhere\\x.ts')).toEqual(['deny', 'medium']);
    expect(judge('file.delete', 'frontend/src/old.ts')).toEqual(['review', 'high']);
    expect(judge('file.read', 'shared/src/api.ts')).toEqual(['allow', 'low']);
    expect(judge('file.read', 'backend/src/secret.ts')).toEqual(['review', 'low']);
    expect(judge('shell.test', 'node --test')).toEqual(['allow', 'low']);
    expect(judge('shell.git.push', 'git push origin main')).toEqual(['review', 'high']);
    expect(judge('network.read', 'https://api.stripe.com')).toEqual(['review', 'medium']);
    expect(judge('agent.communicate', null)).toEqual(['allow', 'low']);
    expect(judge('task.reassign', 'task_b')).toEqual(['review', 'high']);
  });

  it("applies the project's deny rules and the team scopes, as the hooks do", () => {
    const teamTask = { ...task, teams: [{ source: 'policies/teams.yaml', write: ['frontend/src/**'] }] };
    const deny = { write: ['frontend/legacy/**'], read: ['shared/secret/**'] };
    expect(
      evaluateCapability({ capability: 'file.write', target: 'frontend/src/a.ts', task: teamTask, ctx, deny }).decision,
    ).toBe('allow');
    expect(
      evaluateCapability({ capability: 'file.write', target: 'frontend/test/a.ts', task: teamTask, ctx, deny }),
    ).toMatchObject({
      decision: 'review',
      rule: 'capability.outside_team_scope',
    });
    expect(
      evaluateCapability({ capability: 'file.write', target: 'frontend/legacy/a.ts', task, ctx, deny }),
    ).toMatchObject({
      decision: 'review',
      rule: 'capability.denied_by_policy',
    });
    expect(evaluateCapability({ capability: 'file.read', target: 'shared/secret/k.ts', task, ctx, deny }).rule).toBe(
      'capability.denied_by_policy',
    );
  });

  it('never approves a raw secret, and lets a project change autonomy and risk', () => {
    const secret = evaluateCapability({ capability: 'secret.resolve', target: 'STRIPE_KEY', task, ctx });
    expect(secret.decision).toBe('deny');
    expect(secret.reason).toContain('never handed to agents');
    // A command of a stricter class than the capability asked for keeps that class's autonomy.
    expect(judge('shell.test', 'node --test && git push')).toEqual(['review', 'low']);
    expect(judge('network.read', 'https://example.com', { autonomy: { 'network.fetch': 'auto' } })).toEqual([
      'allow',
      'medium',
    ]);
    expect(judge('shell.git.commit', 'git commit -m x', { risk: { 'shell.git.commit': 'low' } })).toEqual([
      'review',
      'low',
    ]);
  });

  it('runs a declared operation by its own risk: low at once, otherwise after a human (ADR-0029 §3)', () => {
    expect(judge('operation.run', 'stripe-test', { risk: { 'operation.run': 'high' } })).toEqual(['review', 'high']);
    expect(judge('operation.run', 'lint', { risk: { 'operation.run': 'low' } })).toEqual(['allow', 'low']);
    expect(judge('operation.run', 'lint')).toEqual(['review', 'medium']);
  });
});
