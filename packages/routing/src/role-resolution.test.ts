import { describe, expect, it } from 'vitest';
import { ROLE_REGISTRY_SOURCE } from './role-registry.js';
import { resolveTaskRoleContract, taskRoleIntentVersion } from './role-resolution.js';
import { type RoleDecision, resolveTaskRole, type TaskRoleFacts } from './roles.js';

const registry = ROLE_REGISTRY_SOURCE;

const task = (overrides: Partial<TaskRoleFacts> = {}): TaskRoleFacts => ({
  kind: 'implementation',
  role: null,
  summary: 'wire the checkout',
  description: null,
  acceptance_criteria: ['tests pass'],
  risk_level: 'low',
  scope: { write: ['src/checkout.ts'], read: [] },
  ...overrides,
});

const classified = (
  roles: { role: string; task_summary: string; depends_on: string[]; confidence: number }[],
): RoleDecision => ({
  status: 'classified',
  roles,
  assumptions: [],
});

const FE = {
  role: 'frontend_engineer',
  task_summary: 'Build the checkout page',
  depends_on: [],
  confidence: 0.9,
};
const BE = {
  role: 'backend_engineer',
  task_summary: 'Build the checkout API',
  depends_on: ['frontend_engineer'],
  confidence: 0.85,
};

describe('role resolution (R2)', () => {
  it('resolves explicit plan, task and human roles before anything else, without consulting the model', () => {
    const model = classified([BE]);
    for (const [origin, source] of [
      ['plan', 'plan'],
      ['task', 'task'],
      ['human', 'human'],
    ] as const) {
      const r = resolveTaskRoleContract({
        task: task({ scope: { write: ['apps/web/src/App.tsx'], read: [] } }),
        origin,
        explicit_role: 'frontend',
        decision: model,
        registry,
      });
      expect(r, origin).toMatchObject({
        status: 'resolved',
        role: 'frontend',
        source,
        confidence: 1,
        registry_version: registry.version,
      });
      expect(r.roles).toEqual([]);
    }
  });

  it('applies the deterministic kind/path fallback before a decision-model answer', () => {
    const r = resolveTaskRoleContract({
      task: task(),
      decision: classified([BE]),
      registry,
    });
    expect(r).toMatchObject({
      status: 'resolved',
      role: 'implementation',
      source: 'kind_fallback',
      confidence: 1,
    });
    const web = resolveTaskRoleContract({
      task: task({ kind: 'analysis', scope: { write: ['apps/web/src/App.tsx'], read: [] } }),
      decision: classified([BE]),
      registry,
    });
    expect(web).toMatchObject({ status: 'resolved', role: 'frontend_engineer', source: 'path_fallback' });
  });

  it('uses the decision model only for ambiguous work, and keeps a multi-role answer as a proposed DAG', () => {
    const ambiguous = task({
      scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] },
    });
    expect(resolveTaskRoleContract({ task: ambiguous, registry })).toMatchObject({
      status: 'blocked',
      role: null,
      source: 'missing',
    });
    const proposed = resolveTaskRoleContract({
      task: ambiguous,
      decision: classified([FE, BE]),
      registry,
    });
    expect(proposed).toMatchObject({
      status: 'proposed',
      role: null,
      source: 'decision_model',
      roles: [FE, BE],
      registry_version: registry.version,
    });
    expect(proposed.confidence).toBe(0.85);
    expect(proposed.intent_version).toMatch(/^ri1_[0-9a-f]{16}$/);
  });

  it('blocks an ambiguous task with a human question when no classifier answer exists', () => {
    const r = resolveTaskRoleContract({
      task: task({ scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] } }),
      registry,
    });
    expect(r).toMatchObject({
      status: 'blocked',
      source: 'missing',
      questions: [expect.stringContaining('Which role')],
    });
  });

  it('turns clarification questions into a blocked contract', () => {
    const r = resolveTaskRoleContract({
      task: task({ scope: { write: ['apps/web/src/App.tsx', 'server/src/api.ts'], read: [] } }),
      decision: {
        status: 'clarification_required',
        missing_facts: ['whether the checkout page is in scope'],
        questions: ['Should this include the checkout page?'],
      },
      registry,
    });
    expect(r).toMatchObject({
      status: 'blocked',
      source: 'missing',
      missing_facts: ['whether the checkout page is in scope'],
      questions: ['Should this include the checkout page?'],
    });
  });

  it('is stable for the same intent and registry version, and changes when the intent changes', () => {
    const a = resolveTaskRoleContract({ task: task(), registry });
    const b = resolveTaskRoleContract({ task: task(), registry });
    expect(a).toEqual(b);
    expect(a.intent_version).toBe(taskRoleIntentVersion(task()));
    expect(taskRoleIntentVersion(task({ scope: { write: ['src/other.ts'], read: [] } }))).not.toBe(a.intent_version);
  });

  it('routes a persisted plan/task role over an agent or classifier suggestion', () => {
    const r = resolveTaskRole({
      task: {
        kind: 'implementation',
        role: 'backend',
        role_source: 'task',
        role_decision_id: 'rdec_00000000000000000000000001',
      },
      registry,
      resolvedRole: 'frontend',
    });
    expect(r).toMatchObject({ role: 'backend_engineer', source: 'task' });
  });

  it('does not dispatch a persisted proposed or blocked decision', () => {
    const proposed = resolveTaskRole({
      task: {
        kind: 'implementation',
        role: null,
        role_source: 'decision_model',
        role_decision_id: 'rdec_00000000000000000000000001',
      },
      registry,
    });
    expect(proposed).toMatchObject({ role: null, source: 'decision_model' });
    expect(proposed.reason).toContain('more than one role');
    const blocked = resolveTaskRole({
      task: {
        kind: 'implementation',
        role: null,
        role_source: 'missing',
        role_decision_id: 'rdec_00000000000000000000000002',
      },
      registry,
    });
    expect(blocked).toMatchObject({ role: null, source: 'missing' });
    expect(blocked.reason).toContain('blocked');
  });
});
