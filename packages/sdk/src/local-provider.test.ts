import { describe, expect, it } from 'vitest';
import { FridayConfig } from './config.js';

const base = { project: { id: `proj_${'0'.repeat(24)}t1`, name: 'p' } };

describe('providers.local and master_brain.provider: local (plan M12.1)', () => {
  it('has its defaults with no block at all: Ollama at 127.0.0.1:11434, no key', () => {
    const c = FridayConfig.parse(base);
    expect(c.providers.local).toMatchObject({ base_url: 'http://127.0.0.1:11434/v1', allow_remote: false });
    expect(c.providers.local.api_key_env).toBeUndefined();
    expect(c.providers.anthropic).toBeUndefined();
    expect(
      FridayConfig.parse({ ...base, master_brain: { provider: 'local', model: 'qwen2.5:7b' } }).master_brain,
    ).toMatchObject({ provider: 'local', model: 'qwen2.5:7b' });
  });

  it('takes another loopback address and a key variable name', () => {
    const c = FridayConfig.parse({
      ...base,
      providers: { local: { base_url: 'http://[::1]:1234/v1', api_key_env: 'LM_STUDIO_KEY' }, anthropic: {} },
    });
    expect(c.providers.local).toMatchObject({ base_url: 'http://[::1]:1234/v1', api_key_env: 'LM_STUDIO_KEY' });
    expect(c.providers.anthropic).toMatchObject({ allow_remote: false, daily_budget_usd: 5 });
  });

  it('refuses an address that is not this machine when the config is read', () => {
    const notThisMachine = [
      'http://localhost:11434/v1', // portability-allow: localhost
      'http://ollama.lan:11434/v1',
      'http://10.0.0.5:11434/v1',
    ];
    for (const url of notThisMachine) {
      const r = FridayConfig.safeParse({ ...base, providers: { local: { base_url: url } } });
      expect(r.success, url).toBe(false);
      if (!r.success) {
        expect(r.error.issues[0]?.path.join('.')).toBe('providers.local.base_url');
        expect(r.error.issues[0]?.message).toMatch(/must run on this machine/);
      }
    }
    expect(FridayConfig.safeParse({ ...base, providers: { local: { api_key_env: 'not a name' } } }).success).toBe(
      false,
    );
  });
});
