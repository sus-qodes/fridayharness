import { describe, expect, it } from 'vitest';
import { loadGuide, mergeModels, modelCostClass, plannerLocalModel } from './registry.js';

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
