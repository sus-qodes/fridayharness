import { describe, expect, it } from 'vitest';
import { defaultModel, hostLabel, type ModelInfo, modelHost, modelLabel, modelName, usableModels } from './models.js';

/** The catalog as `GET models` gives it, dearest first as it is written. */
const CATALOG: ModelInfo[] = [
  { id: 'claude-fable-5-1', vendors: ['claude-code'], source: 'seed' },
  { id: 'claude-fable-5-2', vendors: ['claude-code'], source: 'seed' },
  { id: 'claude-opus-5-5', vendors: ['claude-code', 'cursor'], source: 'seed' },
  { id: 'claude-sonnet-5-5', vendors: ['claude-code', 'cursor'], source: 'seed' },
  { id: 'claude-haiku-5-5', vendors: ['claude-code'], source: 'seed' },
  { id: 'gpt-5.6-luna', vendors: ['codex'], source: 'seed' },
  { id: 'anthropic/claude-opus-5.5', vendors: ['opencode'], source: 'seed' },
  { id: 'openai/gpt-6-astra', vendors: ['codex'], source: 'seed' },
  { id: 'openai/gpt-6.1-sol', vendors: ['codex'], source: 'seed' },
  { id: 'gemini-4-argon', vendors: ['cursor', 'gemini'], source: 'seed' },
  { id: 'gemini-3.8-flash', vendors: ['gemini', 'antigravity'], source: 'seed' },
  { id: 'deepseek-flash', vendors: ['deepseek'], source: 'seed' },
  { id: 'z-ai/glm-5.3', vendors: ['opencode'], source: 'seed' },
];

describe('models as a person chooses them', () => {
  it('offers only what an agent Friday starts can run, the everyday model first', () => {
    expect(usableModels(CATALOG).map((m) => m.id)).toEqual([
      'claude-sonnet-5-5',
      'claude-opus-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-2',
      'claude-fable-5-1',
      'openai/gpt-6.1-sol',
      'openai/gpt-6-astra',
      'gpt-5.6-luna',
    ]);
    // Never the dearest because it happens to be written first.
    expect(defaultModel(CATALOG)).toBe('claude-sonnet-5-5');
    expect(
      defaultModel([
        { id: 'openai/gpt-6-astra', vendors: ['codex'] },
        { id: 'openai/gpt-6.1-sol', vendors: ['codex'] },
      ]),
    ).toBe('openai/gpt-6.1-sol');
    expect(defaultModel([])).toBe('');
    expect(defaultModel(null)).toBe('');
  });

  it('keeps a model the project declared itself, and one of a known host it has no name for', () => {
    const own = usableModels([
      ...CATALOG,
      { id: 'qwen2.5:7b', vendors: [], local: true, source: 'project' },
      { id: 'claude-next', vendors: ['claude-code'], source: 'seed' },
      { id: 'claude-next', vendors: ['claude-code'], source: 'seed' },
      { id: '', vendors: ['codex'] },
    ]).map((m) => m.id);
    expect(own.at(-1)).toBe('qwen2.5:7b');
    // A Claude Code model without a name comes after the named ones of its host, once.
    expect(own.filter((id) => id === 'claude-next')).toHaveLength(1);
    expect(own.indexOf('claude-next')).toBe(own.indexOf('claude-fable-5-1') + 1);
    expect(own).not.toContain('');
  });

  it('names a model and the app that runs it', () => {
    expect(modelName('claude-fable-5-2')).toBe('Claude Fable 5.2');
    expect(modelName('openai/gpt-6.1-sol')).toBe('GPT-6.1 Sol');
    expect(modelName('something/else')).toBe('something/else');
    expect(modelLabel({ id: 'claude-sonnet-5-5', vendors: ['claude-code', 'cursor'] })).toBe(
      'Claude Sonnet 5.5 (Claude Code)',
    );
    expect(modelLabel({ id: 'openai/gpt-6-astra', vendors: ['codex'] })).toBe('GPT-6 Astra (Codex)');
    expect(modelLabel({ id: 'qwen2.5:7b', vendors: [] })).toBe('qwen2.5:7b');
    expect(modelHost({ id: 'gemini-3.8-flash', vendors: ['gemini', 'antigravity'] })).toBeNull();
    expect(hostLabel('antigravity')).toBe('Antigravity');
    expect(hostLabel('unknown-host')).toBe('unknown-host');
  });
});
