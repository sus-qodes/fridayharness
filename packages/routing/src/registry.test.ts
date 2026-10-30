import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGuide, mergeModels, modelCostClass, plannerLocalModel } from './registry.js';
import {
  canonicalRole,
  generatedRegistryView,
  ROLE_REGISTRY_SOURCE,
  validateRoleRegistry,
  withProjectRoleCandidates,
} from './role-registry.js';
import { parseRoleDecision } from './roles.js';

describe("the Master Brain's local model in the registry (plan M12.1)", () => {
  it('is listed as a local model with no harness vendor when the planner is a local server', () => {
    const models = mergeModels(loadGuide().models, [], { provider: 'local', model: 'qwen2.5:7b' });
    expect(models.find((m) => m.id === 'qwen2.5:7b')).toMatchObject({
      provider: 'local',
      local: true,
      vendors: [],
      source: 'project',
      price: null,
    });
  });

  it('is not listed for other providers, for a model still unset, or when the project already lists that id', () => {
    const seed = loadGuide().models;
    expect(mergeModels(seed, [], { provider: 'anthropic', model: 'claude-opus-5-5' })).toHaveLength(seed.length);
    expect(mergeModels(seed, [], { provider: 'local', model: 'auto' })).toHaveLength(seed.length);
    expect(mergeModels(seed, [], null)).toHaveLength(seed.length);
    expect(plannerLocalModel(undefined)).toBeNull();
    const own = mergeModels(seed, [{ id: 'qwen2.5:7b', provider: 'ollama', local: true, vendors: ['october'] }], {
      provider: 'local',
      model: 'qwen2.5:7b',
    });
    expect(own.filter((m) => m.id === 'qwen2.5:7b')).toHaveLength(1);
    expect(own.find((m) => m.id === 'qwen2.5:7b')).toMatchObject({ provider: 'ollama', vendors: ['october'] });
  });
});

describe('cost classes in the registry (plan M13.3)', () => {
  it('records Haiku as cheap, a local model as free and anything else as standard', () => {
    const models = mergeModels(loadGuide().models, [{ id: 'qwen-coder', local: true }], null);
    const of = (id: string) => modelCostClass(models.find((m) => m.id === id));
    expect(of('claude-haiku-5-5')).toBe('cheap');
    expect(of('qwen-coder')).toBe('free');
    expect(of('claude-opus-5-5')).toBe('standard');
    expect(modelCostClass(undefined)).toBe('standard');
    // A project's record says its own class.
    const own = mergeModels(
      loadGuide().models,
      [{ id: 'gpt-5.6-luna', vendors: ['codex'], cost_class: 'cheap' }],
      null,
    );
    expect(modelCostClass(own.find((m) => m.id === 'gpt-5.6-luna'))).toBe('cheap');
  });
});

describe('the static role registry', () => {
  it('is typed, ordered, and exposes future entries without making them dispatchable', () => {
    const models = loadGuide().models;
    validateRoleRegistry(ROLE_REGISTRY_SOURCE, models);
    expect(ROLE_REGISTRY_SOURCE.roles.implementation?.candidates[0]).toMatchObject({
      rank: 1,
      model: 'claude-opus-5-5',
      dispatchable: true,
    });
    expect(ROLE_REGISTRY_SOURCE.roles.implementation?.candidates.at(-1)).toMatchObject({
      dispatchable: false,
      reason_if_unavailable: 'adapter_not_verified',
    });
    expect(canonicalRole('backend')).toBe('implementation');
    expect(canonicalRole('QA')).toBe('verification');
    expect(canonicalRole('designer')).toBeNull();
  });

  it('is generated exactly into friday_registry.json (drift check)', () => {
    const committed = readFileSync(new URL('../friday_registry.json', import.meta.url), 'utf8');
    expect(committed).toBe(generatedRegistryView());
  });

  it('lets a project append candidates to a declared role, with omitted ranks after Friday’s', () => {
    const extended = withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, {
      backend: [{ model: 'local-coder', harness: 'generic' }],
    });
    expect(extended.roles.implementation?.candidates.at(-1)).toEqual({
      rank: 4,
      model: 'local-coder',
      harness: 'generic',
      dispatchable: true,
      mcp_required: false,
      reason_if_unavailable: null,
    });
    validateRoleRegistry(
      extended,
      mergeModels(loadGuide().models, [{ id: 'local-coder', local: true, vendors: ['generic'] }], null),
    );
    expect(() => withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, { designer: [] })).toThrow(/unknown role/);
    expect(() =>
      withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, {
        designer: [{ model: 'local-coder', harness: 'generic' }],
      }),
    ).toThrow(/unknown role/);
    expect(() =>
      validateRoleRegistry(
        withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, {
          implementation: [{ rank: 1, model: 'local-coder', harness: 'generic' }],
        }),
        loadGuide().models,
      ),
    ).toThrow(/duplicate candidate ranks/);
  });
});

describe('decision-model role output', () => {
  it('accepts a known multi-role DAG and rejects unsupported or cyclic output', () => {
    const roles = new Set(['implementation', 'verification', 'review']);
    expect(
      parseRoleDecision(
        {
          status: 'classified',
          roles: [
            { role: 'implementation', task_summary: 'make the change', depends_on: [], confidence: 0.92 },
            { role: 'verification', task_summary: 'run the checks', depends_on: ['implementation'], confidence: 0.88 },
          ],
          assumptions: [],
        },
        roles,
      ),
    ).toMatchObject({ status: 'classified', roles: [{ role: 'implementation' }, { role: 'verification' }] });
    expect(() =>
      parseRoleDecision(
        {
          status: 'classified',
          roles: [{ role: 'unknown', task_summary: 'bad', depends_on: [], confidence: 0.5 }],
          assumptions: [],
        },
        roles,
      ),
    ).toThrow(/unsupported role/);
    expect(() =>
      parseRoleDecision(
        {
          status: 'classified',
          roles: [
            { role: 'implementation', task_summary: 'a', depends_on: ['verification'], confidence: 0.5 },
            { role: 'verification', task_summary: 'b', depends_on: ['implementation'], confidence: 0.5 },
          ],
          assumptions: [],
        },
        roles,
      ),
    ).toThrow(/cycle/);
  });
});
