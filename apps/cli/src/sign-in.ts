/**
 * How a coding host is signed in on this machine, read without starting it and without a model
 * call (2026-11-17): from the environment an agent would run with and the files the host keeps its
 * sign-in in. It answers two things a person otherwise learns from a failed first task: whether
 * the host is signed in at all, and whether each attempt is paid for (an API key) or covered by a
 * subscription, which decides whether a spending cap per attempt means anything.
 *
 * It is a reading, not a proof: a file Friday does not know of may hold the sign-in, so `none` is
 * said as "Friday found no sign-in", never as a refusal to start, and `unknown` keeps the careful
 * defaults (a cap).
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `subscription`: a plan's own sign-in (nothing is charged per attempt); `api_key`: use is charged
 * to a key or a cloud account; `signed_in`: signed in, Friday cannot tell which way; `none`: no
 * sign-in found; `unknown`: this machine keeps it where Friday does not look (a keychain).
 */
export type SignIn = 'subscription' | 'api_key' | 'signed_in' | 'none' | 'unknown';

export interface SignInEnv {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

const set = (env: NodeJS.ProcessEnv, name: string): boolean => Boolean(env[name]?.trim());

function json(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const v = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code. A key or a cloud provider in the environment is used before anything else; a
 * subscription's token is in `CLAUDE_CODE_OAUTH_TOKEN` or in `~/.claude/.credentials.json`
 * (`claudeAiOauth`); a Console sign-in keeps its key in `~/.claude.json`. macOS keeps the sign-in
 * in the keychain, which is not read here.
 */
export function claudeSignIn(o: SignInEnv = {}): SignIn {
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  if (
    set(env, 'ANTHROPIC_API_KEY') ||
    set(env, 'ANTHROPIC_AUTH_TOKEN') ||
    set(env, 'CLAUDE_CODE_USE_BEDROCK') ||
    set(env, 'CLAUDE_CODE_USE_VERTEX') ||
    set(env, 'CLAUDE_CODE_USE_FOUNDRY')
  ) {
    return 'api_key';
  }
  if (set(env, 'CLAUDE_CODE_OAUTH_TOKEN')) return 'subscription';
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  const credentials = json(path.join(dir, '.credentials.json'));
  if (credentials && typeof credentials.claudeAiOauth === 'object' && credentials.claudeAiOauth !== null) {
    return 'subscription';
  }
  const config = json(path.join(home, '.claude.json'));
  if (config && typeof config.primaryApiKey === 'string' && config.primaryApiKey) return 'api_key';
  if (credentials) return 'signed_in';
  // The keychain holds it on macOS: nothing found in files says nothing there.
  return platform === 'darwin' ? 'unknown' : 'none';
}

/**
 * Codex. A key in the environment, or `~/.codex/auth.json` (`CODEX_HOME` moves it): a ChatGPT
 * account's tokens are a subscription, a stored key is an API key.
 */
export function codexSignIn(o: SignInEnv = {}): SignIn {
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  const dir = env.CODEX_HOME?.trim() || path.join(home, '.codex');
  const auth = json(path.join(dir, 'auth.json'));
  if (auth) {
    // What Codex itself wrote of how it signed in, when it says.
    const mode = typeof auth.auth_mode === 'string' ? auth.auth_mode.toLowerCase() : '';
    if (mode.includes('chatgpt')) return 'subscription';
    if (mode.includes('api')) return 'api_key';
    if (auth.tokens && typeof auth.tokens === 'object') return 'subscription';
    if (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY) return 'api_key';
    return 'signed_in';
  }
  if (set(env, 'OPENAI_API_KEY') || set(env, 'CODEX_API_KEY')) return 'api_key';
  return 'none';
}
