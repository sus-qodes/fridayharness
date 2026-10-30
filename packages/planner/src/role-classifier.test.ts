import { ROLE_REGISTRY_SOURCE } from '@friday/routing';
import { describe, expect, it } from 'vitest';
import { FakePlannerModel } from './providers/fake.js';
import { classifyTaskRoles } from './role-classifier.js';

const input = {
  objective: 'Ship a safe change',
  constraints: ['keep the public API stable'],
  outcomes: ['the change is implemented and checked'],
  non_goals: ['redesign unrelated modules'],
  definition_of_done: ['tests pass'],
  task_summary: 'Update the checkout calculation',
  task_description: null,
  kind: 'implementation',
  risk_level: 'medium' as const,
  scope: { write: ['src/checkout.ts'], read: [] },
};

const policy = { allowRemote: false, spentTodayUsd: 0, dailyBudgetUsd: 1 };
const settings = { model: 'fake-role-model', maxTokens: 500 };

describe('classifyTaskRoles', () => {
  it('runs one structured role call and returns a validated DAG', async () => {
    const model = new FakePlannerModel([
      {
        purpose: 'role',
        output: {
          status: 'classified',
          roles: [{ role: 'implementation', task_summary: 'make the change', depends_on: [], confidence: 0.95 }],
          assumptions: [],
        },
      },
    ]);
    const result = await classifyTaskRoles(model, ROLE_REGISTRY_SOURCE, input, policy, settings);
    expect(result.ok).toBe(true);
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.purpose).toBe('role');
  });

  it('turns low confidence into a blocked structured outcome', async () => {
    const response = {
      purpose: 'role' as const,
      output: {
        status: 'classified' as const,
        roles: [{ role: 'implementation', task_summary: 'maybe', depends_on: [], confidence: 0.2 }],
        assumptions: [],
      },
    };
    const model = new FakePlannerModel([response, response]);
    const result = await classifyTaskRoles(model, ROLE_REGISTRY_SOURCE, input, policy, settings);
    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
  });
});
