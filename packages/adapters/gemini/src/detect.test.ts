import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { compareVersions, findGemini, geminiEnvironment, geminiLoginHints } from './detect.js';

const ws = useTestWorkspace();
const win = process.platform === 'win32';

/** An npm global prefix with Gemini CLI installed in it, as `npm install -g @google/gemini-cli` lays it out. */
function npmPrefix(version = '0.64.0'): { prefix: string; pkg: string } {
  const prefix = path.join(ws().root, 'npm');
  const pkg = win
    ? path.join(prefix, 'node_modules', '@google', 'gemini-cli')
    : path.join(prefix, 'lib', 'node_modules', '@google', 'gemini-cli');
  mkdirSync(path.join(pkg, 'bundle'), { recursive: true });
  writeFileSync(
    path.join(pkg, 'package.json'),
    JSON.stringify({ name: '@google/gemini-cli', version, bin: { gemini: 'bundle/gemini.js' } }),
  );
  writeFileSync(path.join(pkg, 'bundle', 'gemini.js'), '');
  return { prefix, pkg };
}

/** An environment that finds nothing of this machine's own. */
const bare = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  APPDATA: path.join(ws().root, 'appdata'),
  PATH: '',
  ...extra,
});

describe('finding Gemini CLI without starting it', () => {
  it("reads npm's per-user install: the entry script runs with Friday's Node, the version comes from package.json", () => {
    const { prefix, pkg } = npmPrefix();
    const found = findGemini(bare(win ? { APPDATA: path.dirname(prefix) } : { npm_config_prefix: prefix }));
    if (win) {
      // %APPDATA%\npm is where npm installs for the user on Windows: the prefix here is <root>\npm.
      expect(found.source).toBe('npm');
    }
    expect(found).toMatchObject({
      command: process.execPath,
      args: [path.join(pkg, 'bundle', 'gemini.js')],
      version: '0.64.0',
    });
    expect(found.problem).toBeNull();
  });

  it('follows the gemini shim on PATH to its package', () => {
    const { prefix } = npmPrefix('0.65.0');
    const shimDir = win ? prefix : path.join(prefix, 'bin');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(path.join(shimDir, win ? 'gemini.cmd' : 'gemini'), '');
    const found = findGemini(bare({ PATH: shimDir }));
    expect(found).toMatchObject({ source: 'PATH', version: '0.65.0', command: process.execPath });
  });

  it('takes GEMINI_CLI_BIN: an entry script, with the version of the package above it', () => {
    const { pkg } = npmPrefix('0.64.1');
    const found = findGemini(bare({ GEMINI_CLI_BIN: path.join(pkg, 'bundle', 'gemini.js') }));
    expect(found).toMatchObject({ source: 'GEMINI_CLI_BIN', version: '0.64.1', packageDir: pkg });
  });

  it('says why when only a shim is found, and when nothing is', () => {
    const shimDir = path.join(ws().root, 'shims');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(path.join(shimDir, win ? 'gemini.cmd' : 'gemini'), '');
    expect(findGemini(bare({ PATH: shimDir })).problem).toMatch(
      /not the @google\/gemini-cli package behind it: set GEMINI_CLI_BIN/,
    );
    const none = findGemini(bare());
    expect(none.command).toBeNull();
    expect(none.problem).toMatch(/npm install -g @google\/gemini-cli/);
    expect(findGemini(bare({ GEMINI_CLI_BIN: path.join(ws().root, 'missing') })).problem).toMatch(/GEMINI_CLI_BIN/);
  });

  it('compares versions by their numbers', () => {
    expect(compareVersions('0.64.0', '0.36.0')).toBeGreaterThan(0);
    expect(compareVersions('0.35.9', '0.36.0')).toBeLessThan(0);
    expect(compareVersions('v0.36.0-nightly', '0.36.0')).toBe(0);
  });
});

describe("a spawned session's environment", () => {
  it("keeps Gemini CLI's own login and Friday's state folder, and drops Friday's variables, another host's and secrets", () => {
    const env = geminiEnvironment({
      PATH: 'p',
      FRIDAY_STATE_DIR: 's',
      FRIDAY_AGENT: 'a',
      FRIDAY_OPERATOR_TOKEN: 't',
      CLAUDE_PROJECT_DIR: 'c',
      CLAUDE_CODE_SESSION_ID: 'x',
      CURSOR_PROJECT_DIR: 'y',
      GITHUB_TOKEN: 'g',
      AWS_SECRET_ACCESS_KEY: 'k',
      GEMINI_API_KEY: 'key',
      GOOGLE_APPLICATION_CREDENTIALS: 'creds.json',
      GEMINI_CLI_HOME: 'home',
    });
    expect(env).toEqual({
      PATH: 'p',
      FRIDAY_STATE_DIR: 's',
      GEMINI_API_KEY: 'key',
      GOOGLE_APPLICATION_CREDENTIALS: 'creds.json',
      GEMINI_CLI_HOME: 'home',
    });
  });

  it('names which ways to sign in are set, never their values', () => {
    expect(geminiLoginHints({ GEMINI_API_KEY: 'secret-value', PATH: 'x' })).toEqual(['GEMINI_API_KEY']);
  });
});
