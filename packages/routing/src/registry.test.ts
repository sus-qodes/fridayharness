import { describe, expect, it } from 'vitest';
import { loadGuide, mergeModels, plannerLocalModel } from './registry.js';

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
