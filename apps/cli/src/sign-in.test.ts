import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeSignIn, codexSignIn } from './sign-in.js';

/** How a host is signed in, read from a temporary home: never the developer's own files. */

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'friday-sign-in-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const put = (rel: string, body: unknown) => {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
};
const claude = (env: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = 'win32') =>
  claudeSignIn({ env, home, platform });
const codex = (env: NodeJS.ProcessEnv = {}) => codexSignIn({ env, home, platform: 'win32' });

describe('Claude Code sign-in', () => {
  it('finds none on an empty home, and does not say so where the keychain holds it', () => {
    expect(claude()).toBe('none');
    expect(claude({}, 'linux')).toBe('none');
    expect(claude({}, 'darwin')).toBe('unknown');
  });

  it('reads a subscription from the credentials file or its token', () => {
    put('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'x' } });
    expect(claude()).toBe('subscription');
    // The keychain is not asked when the file already says.
    expect(claude({}, 'darwin')).toBe('subscription');
    rmSync(path.join(home, '.claude'), { recursive: true });
    expect(claude({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })).toBe('subscription');
  });

  it('puts what is charged per use first: a key or a cloud account in the environment', () => {
    put('.claude/.credentials.json', { claudeAiOauth: { accessToken: 'x' } });
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
    ]) {
      expect(claude({ [name]: '1' }), name).toBe('api_key');
    }
    // A variable that is set and blank is not a key.
    expect(claude({ ANTHROPIC_API_KEY: '   ' })).toBe('subscription');
  });

  it('reads a Console sign-in as an API key, and an unknown credentials file as signed in', () => {
    put('.claude.json', { primaryApiKey: 'sk-test' });
    expect(claude()).toBe('api_key');
    put('.claude.json', { primaryApiKey: '' });
    expect(claude()).toBe('none');
    put('.claude/.credentials.json', { somethingElse: true });
    expect(claude()).toBe('signed_in');
  });

  it('follows CLAUDE_CONFIG_DIR, and reads a broken file as nothing', () => {
    put('elsewhere/.credentials.json', { claudeAiOauth: {} });
    expect(claude()).toBe('none');
    expect(claude({ CLAUDE_CONFIG_DIR: path.join(home, 'elsewhere') })).toBe('subscription');
    put('.claude/.credentials.json', '{ not json');
    expect(claude()).toBe('none');
    put('.claude/.credentials.json', '[1, 2]');
    expect(claude()).toBe('none');
    put('.claude/.credentials.json', { claudeAiOauth: null });
    expect(claude()).toBe('signed_in');
  });
});

describe('Codex sign-in', () => {
  it('finds none on an empty home, and a key in the environment', () => {
    expect(codex()).toBe('none');
    expect(codex({ OPENAI_API_KEY: 'sk' })).toBe('api_key');
    expect(codex({ CODEX_API_KEY: 'sk' })).toBe('api_key');
    expect(codex({ OPENAI_API_KEY: ' ' })).toBe('none');
  });

  it('reads what Codex wrote of how it signed in', () => {
    put('.codex/auth.json', { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'x' } });
    expect(codex()).toBe('subscription');
    // The file says how Codex signs in: a key in the environment does not change what it uses.
    expect(codex({ OPENAI_API_KEY: 'sk' })).toBe('subscription');
    put('.codex/auth.json', { auth_mode: 'ApiKey', OPENAI_API_KEY: 'sk' });
    expect(codex()).toBe('api_key');
  });

  it('falls back to what the file holds when it names no mode', () => {
    put('.codex/auth.json', { tokens: { id_token: 'x' } });
    expect(codex()).toBe('subscription');
    put('.codex/auth.json', { OPENAI_API_KEY: 'sk' });
    expect(codex()).toBe('api_key');
    put('.codex/auth.json', { tokens: null, OPENAI_API_KEY: null });
    expect(codex()).toBe('signed_in');
    put('.codex/auth.json', 'nope');
    expect(codex()).toBe('none');
  });

  it('follows CODEX_HOME', () => {
    put('other/auth.json', { auth_mode: 'chatgpt' });
    expect(codex()).toBe('none');
    expect(codex({ CODEX_HOME: path.join(home, 'other') })).toBe('subscription');
  });
});
