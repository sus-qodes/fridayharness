import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  controlledEnvironment,
  createControlledProfile,
  LOCAL_PROVIDER,
  loopbackModelUrl,
  verifyEffectiveConfig,
} from './profile.js';

const ws = useTestWorkspace();

/** The pinned plugin bundle, as `verifyDependencies` expects it. */
function deps(): string {
  const dir = path.join(ws().root, 'deps');
  mkdirSync(path.join(dir, 'node_modules/@opencode-ai/plugin'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@opencode-ai/plugin': '1.19.3' } }));
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { '@opencode-ai/plugin': '1.19.3' } },
        'node_modules/@opencode-ai/plugin': { version: '1.19.3' },
      },
    }),
  );
  writeFileSync(path.join(dir, 'node_modules/@opencode-ai/plugin/package.json'), '{"version":"1.19.3"}');
  return dir;
}
const profile = (extra: Partial<Parameters<typeof createControlledProfile>[0]> = {}) =>
  createControlledProfile({
    cwd: ws().projectDir,
    command: process.execPath,
    baseDir: path.join(ws().root, 'profiles'),
    dependenciesDir: deps(),
    bridge: { url: 'http://127.0.0.1:1/policy', secret: 's', nonce: 'n', timeoutMs: 1000 },
    ...extra,
  });

describe("checkpoint C's model profile (plan M8b.6)", () => {
  it('reaches only a model server on this machine, with no credentials', () => {
    expect(loopbackModelUrl('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1');
    expect(loopbackModelUrl('http://[::1]:1234/v1')).toBe('http://[::1]:1234/v1');
    for (const bad of [
      'https://127.0.0.1:11434/v1',
      // A name may resolve elsewhere: only literal loopback addresses.
      ['http://local', 'host:1234/v1'].join(''),
      'http://192.168.1.5:11434/v1',
      'http://user:pass@127.0.0.1:11434/v1',
      'http://api.example.com/v1',
      'http://127.0.0.1:11434/v1?key=x',
      'not a url',
    ])
      expect(() => loopbackModelUrl(bad), bad).toThrow();
  });

  it('keeps native permissions denying without a model, and allows them only in the model profile', () => {
    expect(controlledEnvironment(ws().root, process.execPath, {}).OPENCODE_PERMISSION).toBe('{"*":"deny"}');
    expect(controlledEnvironment(ws().root, process.execPath, {}, 'allow').OPENCODE_PERMISSION).toBe('{"*":"allow"}');
    const plain = profile();
    expect(plain.config).toMatchObject({ enabled_providers: [], permission: { '*': 'deny' } });
    expect('provider' in plain.config).toBe(false);
    const c = profile({ inference: { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' } });
    expect(c.config).toMatchObject({
      enabled_providers: [LOCAL_PROVIDER],
      model: `${LOCAL_PROVIDER}/qwen2.5:7b`,
      small_model: `${LOCAL_PROVIDER}/qwen2.5:7b`,
      permission: { '*': 'allow' },
      provider: {
        [LOCAL_PROVIDER]: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:11434/v1' },
          models: { 'qwen2.5:7b': { tool_call: true } },
        },
      },
    });
    expect(c.env.OPENCODE_PERMISSION).toBe('{"*":"allow"}');
    // The file OpenCode reads holds the same, and carries no credential.
    const written = readFileSync(c.env.OPENCODE_CONFIG as string, 'utf8');
    expect(written).not.toMatch(/apiKey|api_key|password/i);
  });

  it('refuses a model server elsewhere, and MCP servers without the model profile', () => {
    expect(() => profile({ inference: { baseURL: 'http://10.0.0.2:11434/v1', model: 'm' } })).toThrow(/loopback/);
    expect(() => profile({ mcp: { mock: { type: 'local', command: ['node', 'x.mjs'] } } })).toThrow(/checkpoint C/);
  });

  it('checks that the host runs exactly the declared model, provider and address', () => {
    const c = profile({ inference: { baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' } });
    const effective = JSON.parse(JSON.stringify(c.config)) as Record<string, unknown>;
    expect(() => verifyEffectiveConfig(effective, c)).not.toThrow();
    const elsewhere = JSON.parse(JSON.stringify(effective));
    elsewhere.provider[LOCAL_PROVIDER].options.baseURL = 'http://127.0.0.1:9999/v1';
    expect(() => verifyEffectiveConfig(elsewhere, c)).toThrow(/provider/);
    const added = JSON.parse(JSON.stringify(effective));
    added.provider.openai = { npm: '@ai-sdk/openai', options: {}, models: {} };
    expect(() => verifyEffectiveConfig(added, c)).toThrow(/provider/);
    expect(() => verifyEffectiveConfig({ ...effective, model: 'openai/gpt-5' }, c)).toThrow(/model/);
    // A plain profile refuses any provider the host reports.
    const plain = profile();
    expect(() =>
      verifyEffectiveConfig({ ...JSON.parse(JSON.stringify(plain.config)), provider: { x: {} } }, plain),
    ).toThrow(/provider/);
  });
});
