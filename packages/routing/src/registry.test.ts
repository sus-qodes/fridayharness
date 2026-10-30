import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadModelCatalog, mergeModels, modelCostClass, plannerLocalModel } from './registry.js';
import {
  canonicalRole,
  generatedRegistryView,
  ROLE_REGISTRY_SOURCE,
  type RoleCandidateRequirements,
  type RoleRegistry,
  type RoleRegistryCandidate,
  roleRegistryRoles,
  validateRoleRegistry,
  withProjectRoleCandidates,
} from './role-registry.js';
import { parseRoleDecision } from './roles.js';

describe("the Master Brain's local model in the registry (plan M12.1)", () => {
  it('is listed as a local model with no harness vendor when the planner is a local server', () => {
    const models = mergeModels(loadModelCatalog().models, [], { provider: 'local', model: 'qwen2.5:7b' });
    expect(models.find((m) => m.id === 'qwen2.5:7b')).toMatchObject({
      provider: 'local',
      local: true,
      vendors: [],
      source: 'project',
      price: null,
    });
  });

  it('is not listed for other providers, for a model still unset, or when the project already lists that id', () => {
    const seed = loadModelCatalog().models;
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
    const models = mergeModels(loadModelCatalog().models, [{ id: 'qwen-coder', local: true }], null);
    const of = (id: string) => modelCostClass(models.find((m) => m.id === id));
    expect(of('claude-haiku-5-5')).toBe('cheap');
    expect(of('qwen-coder')).toBe('free');
    expect(of('claude-opus-5-5')).toBe('standard');
    expect(modelCostClass(undefined)).toBe('standard');
    // A project's record says its own class.
    const own = mergeModels(
      loadModelCatalog().models,
      [{ id: 'gpt-5.6-luna', vendors: ['codex'], cost_class: 'cheap' }],
      null,
    );
    expect(modelCostClass(own.find((m) => m.id === 'gpt-5.6-luna'))).toBe('cheap');
  });
});

function withImplementationCandidate(candidate: RoleRegistryCandidate): RoleRegistry {
  const definition = ROLE_REGISTRY_SOURCE.roles.implementation;
  if (!definition) throw new Error('implementation role missing');
  return {
    ...ROLE_REGISTRY_SOURCE,
    roles: {
      ...ROLE_REGISTRY_SOURCE.roles,
      implementation: { ...definition, candidates: [candidate] },
    },
  };
}

describe('the static role registry', () => {
  it('covers the handoff roles, canonical aliases and declared requirements', () => {
    const models = loadModelCatalog().models;
    validateRoleRegistry(ROLE_REGISTRY_SOURCE, models);
    expect(Object.keys(ROLE_REGISTRY_SOURCE.roles)).toEqual([
      'decision_router',
      'system_architect',
      'backend_engineer',
      'frontend_engineer',
      'qa_and_debugging',
      'devops_and_terminal',
      'code_reviewer_and_security',
      'implementation',
      'research',
      'docs',
      'chore',
    ]);
    expect(ROLE_REGISTRY_SOURCE.roles.implementation?.candidates[0]).toMatchObject({
      rank: 1,
      model: 'claude-opus-5-5',
      harness: 'claude-code',
      declared_dispatchable: true,
      requirements: {
        mcp_required: true,
        auth_required: true,
        host_verified: true,
        model_verified: true,
        mcp_verified: true,
      },
      last_checked: '2026-10-21',
      cost: { source: 'model-guide.yaml', observed_at: '2026-10-20' },
      benchmark: null,
    });
    expect(ROLE_REGISTRY_SOURCE.roles.implementation?.candidates.at(-1)).toMatchObject({
      declared_dispatchable: false,
      reason_if_unavailable: 'adapter_not_verified',
    });
    expect(ROLE_REGISTRY_SOURCE.roles.decision_router?.candidates[0]).toMatchObject({
      requirements: { mcp_required: false, mcp_verified: false },
    });
    expect(canonicalRole('backend')).toBe('backend_engineer');
    expect(canonicalRole('frontend')).toBe('frontend_engineer');
    expect(canonicalRole('architect')).toBe('system_architect');
    expect(canonicalRole('QA')).toBe('qa_and_debugging');
    expect(canonicalRole('security')).toBe('code_reviewer_and_security');
    expect(canonicalRole('review')).toBe('code_reviewer_and_security');
    expect(canonicalRole('documentation')).toBe('docs');
    expect(canonicalRole('designer')).toBeNull();
    // Decision output uses canonical names; aliases are input spellings.
    expect(roleRegistryRoles()).toContain('qa_and_debugging');
    expect(roleRegistryRoles()).not.toContain('qa');
    expect(roleRegistryRoles()).not.toContain('review');
  });

  it('is generated exactly into friday_registry.json (drift check)', () => {
    const committed = readFileSync(new URL('../friday_registry.json', import.meta.url), 'utf8');
    expect(committed).toBe(generatedRegistryView());
  });

  it('lets a project append candidates to a declared role, with omitted ranks after Friday’s', () => {
    const extended = withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, {
      backend: [{ model: 'local-coder', harness: 'generic' }],
    });
    expect(extended.roles.backend_engineer?.candidates.at(-1)).toEqual({
      rank: 4,
      model: 'local-coder',
      harness: 'generic',
      declared_dispatchable: true,
      reason_if_unavailable: null,
      requirements: {
        mcp_required: false,
        auth_required: false,
        host_verified: true,
        model_verified: true,
        mcp_verified: false,
      },
      last_checked: null,
      cost: null,
      benchmark: null,
    });
    validateRoleRegistry(
      extended,
      mergeModels(loadModelCatalog().models, [{ id: 'local-coder', local: true, vendors: ['generic'] }], null),
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
        loadModelCatalog().models,
      ),
    ).toThrow(/duplicate candidate ranks/);
  });
});

describe('static registry validation', () => {
  const first = ROLE_REGISTRY_SOURCE.roles.implementation?.candidates[0];
  if (!first) throw new Error('implementation candidate missing');

  it('rejects dispatchable candidates with an unknown model, harness or missing requirements', () => {
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({ ...first, model: 'not-in-the-guide' }),
        loadModelCatalog().models,
      ),
    ).toThrow(/unknown model/);
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({ ...first, harness: 'future-harness' }),
        loadModelCatalog().models,
      ),
    ).toThrow(/unknown harness/);
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({
          ...first,
          requirements: undefined as unknown as RoleCandidateRequirements,
        }),
        loadModelCatalog().models,
      ),
    ).toThrow(/without complete dispatch requirements/);
    // An unknown future harness is allowed only while the candidate is declared non-dispatchable.
    validateRoleRegistry(
      withImplementationCandidate({
        ...first,
        harness: 'future-harness',
        declared_dispatchable: false,
        reason_if_unavailable: 'adapter_not_verified',
      }),
      loadModelCatalog().models,
    );
  });

  it('rejects aliases that collide by case, empty roles and missing unavailability reasons', () => {
    expect(() =>
      validateRoleRegistry(
        { ...ROLE_REGISTRY_SOURCE, aliases: { ...ROLE_REGISTRY_SOURCE.aliases, Backend: 'backend_engineer' } },
        loadModelCatalog().models,
      ),
    ).toThrow(/collides/);
    const docs = ROLE_REGISTRY_SOURCE.roles.docs;
    if (!docs) throw new Error('docs role missing');
    expect(() =>
      validateRoleRegistry(
        { ...ROLE_REGISTRY_SOURCE, roles: { ...ROLE_REGISTRY_SOURCE.roles, docs: { ...docs, candidates: [] } } },
        loadModelCatalog().models,
      ),
    ).toThrow(/no candidates/);
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({
          ...first,
          declared_dispatchable: false,
          reason_if_unavailable: null,
        }),
        loadModelCatalog().models,
      ),
    ).toThrow(/without a reason/);
  });

  it('rejects invalid provenance and contradictions between MCP requirements', () => {
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({ ...first, last_checked: 'yesterday' }),
        loadModelCatalog().models,
      ),
    ).toThrow(/last_checked/);
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({ ...first, cost: { source: '', observed_at: '2026-10-20' } }),
        loadModelCatalog().models,
      ),
    ).toThrow(/cost provenance/);
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({
          ...first,
          benchmark: { source: 'a benchmark', metric: 'pass@1', value: 0.8, measured_at: '2026-10-20', samples: 0 },
        }),
        loadModelCatalog().models,
      ),
    ).toThrow(/benchmark provenance/);
    expect(() =>
      validateRoleRegistry(
        withImplementationCandidate({
          ...first,
          requirements: { ...first.requirements, mcp_required: false, mcp_verified: true },
        }),
        loadModelCatalog().models,
      ),
    ).toThrow(/requires MCP verification but not MCP/);
  });
});

describe('decision-model role output', () => {
  it('accepts a known multi-role DAG and rejects unsupported or cyclic output', () => {
    const roles = new Set(['implementation', 'qa_and_debugging', 'code_reviewer_and_security']);
    expect(
      parseRoleDecision(
        {
          status: 'classified',
          roles: [
            { role: 'implementation', task_summary: 'make the change', depends_on: [], confidence: 0.92 },
            {
              role: 'qa_and_debugging',
              task_summary: 'run the checks',
              depends_on: ['implementation'],
              confidence: 0.88,
            },
          ],
          assumptions: [],
        },
        roles,
      ),
    ).toMatchObject({ status: 'classified', roles: [{ role: 'implementation' }, { role: 'qa_and_debugging' }] });
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
            { role: 'implementation', task_summary: 'a', depends_on: ['qa_and_debugging'], confidence: 0.5 },
            { role: 'qa_and_debugging', task_summary: 'b', depends_on: ['implementation'], confidence: 0.5 },
          ],
          assumptions: [],
        },
        roles,
      ),
    ).toThrow(/cycle/);
  });
});
