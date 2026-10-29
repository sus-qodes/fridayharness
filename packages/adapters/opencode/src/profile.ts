import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensurePrivateDir } from '@friday/sdk';
import { type PluginSettings, policyPluginSource } from './plugin.js';

export const OPENCODE_VERSION = '1.19.3';
export const CONFIG_FILE = '.friday/harness/opencode/config.json';
export const LEVEL_NOTE =
  'L1 unverified (experimental): live before-tool refusals were recorded with a local model (checkpoint C); busy cancellation, recovery and the worker lifecycle are unverified';

export interface ControlledProfile {
  dir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  config: Record<string, unknown>;
  plugin: string;
  pluginHash: string;
  verify(): void;
}
/**
 * The model of checkpoint C (plan M8b.6): one OpenAI-compatible server on this machine, through
 * OpenCode's bundled `@ai-sdk/openai-compatible`, so nothing is downloaded and no credential is
 * sent. Only for the enforcement check with a local model the owner approved.
 */
export interface InferenceSettings {
  /** A literal loopback address over plain http, such as Ollama's `http://127.0.0.1:11434/v1`. */
  baseURL: string;
  /** The model the server has, such as `qwen2.5:7b`. */
  model: string;
  contextTokens?: number;
  outputTokens?: number;
}
/** The provider id Friday gives the local server inside the private profile. */
export const LOCAL_PROVIDER = 'friday-local';

/**
 * Refuses anything but a literal loopback address (127.0.0.1 or [::1]) over plain http with no
 * credentials, the rule of plan M12.1: a host name may resolve elsewhere.
 */
export function loopbackModelUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('the model server address is not a URL');
  }
  if (
    url.protocol !== 'http:' ||
    url.username ||
    url.password ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.search ||
    url.hash
  )
    throw new Error('the model server must be a loopback http address with no credentials');
  return url.href.replace(/\/$/, '');
}

export const hash = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');
const json = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
const contains = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** No project/user settings, credentials, proxy, preload or model provider variables are inherited. */
export function controlledEnvironment(
  dir: string,
  command: string,
  source: NodeJS.ProcessEnv,
  nativePermission: 'deny' | 'allow' = 'deny',
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (process.platform === 'win32') {
    env.SystemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    env.WINDIR = env.SystemRoot;
    env.ComSpec = path.join(env.SystemRoot, 'System32', 'cmd.exe');
  }
  env.PATH = [
    ...new Set([
      path.dirname(command),
      path.dirname(process.execPath),
      ...(env.SystemRoot ? [path.join(env.SystemRoot, 'System32')] : ['/usr/bin', '/bin']),
    ]),
  ].join(path.delimiter);
  // The private paths replace the source's values; source is deliberately never spread.
  void source;
  for (const [name, child] of Object.entries({
    HOME: 'home',
    USERPROFILE: 'home',
    XDG_CONFIG_HOME: 'config',
    XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache',
    XDG_STATE_HOME: 'state',
    TEMP: 'tmp',
    TMP: 'tmp',
    TMPDIR: 'tmp',
    OPENCODE_TEST_HOME: 'home',
    OPENCODE_TEST_MANAGED_CONFIG_DIR: 'managed',
    OPENCODE_CONFIG_DIR: 'config/opencode',
  }))
    env[name] = path.join(dir, child);
  for (const flag of [
    'OPENCODE_DISABLE_PROJECT_CONFIG',
    'OPENCODE_DISABLE_DEFAULT_PLUGINS',
    'OPENCODE_DISABLE_CLAUDE_CODE',
    'OPENCODE_DISABLE_EXTERNAL_SKILLS',
    'OPENCODE_DISABLE_LSP_DOWNLOAD',
    'OPENCODE_DISABLE_AUTOUPDATE',
    'OPENCODE_DISABLE_MODELS_FETCH',
    'OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER',
  ])
    env[flag] = '1';
  // Native permissions deny everything, except in checkpoint C's model profile, where they allow so
  // that Friday's before-tool plugin is the only gate a refusal can come from (plan M8b.6).
  env.OPENCODE_PERMISSION = JSON.stringify({ '*': nativePermission });
  env.npm_config_offline = 'true';
  return env;
}

/** Refuse administrator settings instead of silently replacing the administrator's policy (HX-15). */
export function managedConfigProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir =
    process.platform === 'win32'
      ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'opencode')
      : process.platform === 'darwin'
        ? '/Library/Application Support/opencode'
        : '/etc/opencode';
  const candidates = ['opencode.json', 'opencode.jsonc'].map((name) => path.join(dir, name));
  if (process.platform === 'darwin')
    candidates.push(
      '/Library/Managed Preferences/ai.opencode.managed.plist',
      path.join('/Library/Managed Preferences', os.userInfo().username, 'ai.opencode.managed.plist'),
    );
  return candidates.some(existsSync) ? 'managed OpenCode settings are present; controlled launch is refused' : null;
}

/** No implicit npm install: provision the pinned plugin package with npm's real lockfile beforehand. */
export function verifyDependencies(dir: string): void {
  const pkg = json(path.join(dir, 'package.json'));
  const lock = json(path.join(dir, 'package-lock.json'));
  const packages = lock.packages as
    | Record<string, { version?: string; dependencies?: Record<string, string> }>
    | undefined;
  if (
    (pkg.dependencies as Record<string, string> | undefined)?.['@opencode-ai/plugin'] !== OPENCODE_VERSION ||
    packages?.['']?.dependencies?.['@opencode-ai/plugin'] !== OPENCODE_VERSION ||
    packages?.['node_modules/@opencode-ai/plugin']?.version !== OPENCODE_VERSION ||
    json(path.join(dir, 'node_modules', '@opencode-ai', 'plugin', 'package.json')).version !== OPENCODE_VERSION
  )
    throw new Error('offline dependency bundle must contain @opencode-ai/plugin 1.19.3 and its npm lockfile');
}

export function createControlledProfile(opts: {
  cwd: string;
  command: string;
  baseDir?: string;
  dependenciesDir: string;
  bridge: Omit<PluginSettings, 'cwd'>;
  env?: NodeJS.ProcessEnv;
  /** Checkpoint C only (plan M8b.6): the local model, with native permissions that allow. */
  inference?: InferenceSettings;
  /** Checkpoint C only: MCP servers the profile declares (a mock server whose tool Friday must refuse). */
  mcp?: Record<string, Record<string, unknown>>;
}): ControlledProfile {
  const cwd = realpathSync(opts.cwd);
  const base = opts.baseDir ?? path.join(os.tmpdir(), 'friday-opencode');
  mkdirSync(base, { recursive: true });
  if (contains(cwd, realpathSync(base)))
    throw new Error('OpenCode private profiles must be outside the execution root');
  if (contains(cwd, realpathSync(opts.dependenciesDir)))
    throw new Error('offline dependencies must be outside the execution root');
  verifyDependencies(opts.dependenciesDir);
  const managed = managedConfigProblem(opts.env);
  if (managed) throw new Error(managed);
  const dir = realpathSync(mkdtempSync(path.join(realpathSync(base), 'attempt-')));
  try {
    ensurePrivateDir(dir);
    const inference = opts.inference
      ? { ...opts.inference, baseURL: loopbackModelUrl(opts.inference.baseURL) }
      : undefined;
    if (opts.mcp && !inference) throw new Error('MCP servers are declared only in the model profile of checkpoint C');
    const env = controlledEnvironment(dir, opts.command, opts.env ?? process.env, inference ? 'allow' : 'deny');
    for (const child of ['home', 'config/opencode', 'data', 'cache', 'state', 'tmp', 'managed'])
      mkdirSync(path.join(dir, child), { recursive: true, mode: 0o700 });
    const configDir = path.join(dir, 'config', 'opencode');
    for (const entry of ['package.json', 'package-lock.json', 'node_modules'])
      cpSync(path.join(opts.dependenciesDir, entry), path.join(configDir, entry), {
        recursive: true,
        dereference: true,
      });
    const plugin = path.join(dir, 'policy.mjs');
    const source = policyPluginSource({ ...opts.bridge, cwd });
    writeFileSync(plugin, source, { mode: 0o600 });
    const model = inference ? `${LOCAL_PROVIDER}/${inference.model}` : undefined;
    const config = {
      $schema: 'https://opencode.ai/config.json',
      plugin: [pathToFileURL(plugin).href],
      mcp: opts.mcp ?? {},
      enabled_providers: inference ? [LOCAL_PROVIDER] : [],
      ...(inference
        ? {
            provider: {
              [LOCAL_PROVIDER]: {
                npm: '@ai-sdk/openai-compatible',
                name: 'Friday local model',
                options: { baseURL: inference.baseURL, timeout: 600_000 },
                models: {
                  [inference.model]: {
                    name: inference.model,
                    tool_call: true,
                    limit: { context: inference.contextTokens ?? 16_384, output: inference.outputTokens ?? 1_024 },
                  },
                },
              },
            },
            model,
            small_model: model,
          }
        : {}),
      autoupdate: false,
      snapshot: false,
      lsp: false,
      formatter: false,
      instructions: [],
      permission: { '*': inference ? 'allow' : 'deny' },
      command: {},
      agent: {},
      shell:
        process.platform === 'win32'
          ? path.join(env.SystemRoot as string, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
          : '/bin/sh',
    };
    const file = path.join(configDir, 'opencode.json');
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    env.OPENCODE_CONFIG = file;
    const expected = new Map(
      [file, plugin, path.join(configDir, 'package.json'), path.join(configDir, 'package-lock.json')].map((p) => [
        p,
        hash(readFileSync(p)),
      ]),
    );
    return {
      dir,
      cwd,
      env,
      config,
      plugin,
      pluginHash: hash(source),
      verify() {
        for (const [p, digest] of expected) {
          if (realpathSync(p) !== p) throw new Error(`private OpenCode profile path changed: ${path.basename(p)}`);
          if (hash(readFileSync(p)) !== digest) {
            const keys =
              p === file
                ? Object.keys(json(p))
                    .filter(
                      (key) =>
                        JSON.stringify(json(p)[key]) !== JSON.stringify((config as Record<string, unknown>)[key]),
                    )
                    .join(',')
                : '';
            throw new Error(
              `private OpenCode profile contents changed: ${path.basename(p)}${keys ? ` fields=${keys}` : ''}`,
            );
          }
        }
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    throw error;
  }
}

/** The returned effective config is checked before the launcher accepts a session or a tool check. */
export function verifyEffectiveConfig(value: unknown, profile: ControlledProfile): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('missing effective OpenCode config');
  const actual = value as Record<string, unknown>;
  for (const key of [
    'plugin',
    'enabled_providers',
    'mcp',
    'autoupdate',
    'snapshot',
    'lsp',
    'formatter',
    'instructions',
    'permission',
    'command',
    'agent',
    'shell',
  ]) {
    // Empty optional collections may be omitted by the host. Nonempty ones cannot hide.
    const expected = profile.config[key];
    const empty = JSON.stringify(expected) === '{}' || JSON.stringify(expected) === '[]';
    if (JSON.stringify(actual[key] ?? (empty ? expected : null)) !== JSON.stringify(expected))
      throw new Error(`OpenCode effective configuration differs: ${key}`);
  }
  // Checkpoint C's model: exactly the declared provider, at the declared address, with the declared
  // models, and the declared model chosen (plan M8b.6). The host may add defaults; these may not differ.
  const providers = profile.config.provider as Record<string, Record<string, unknown>> | undefined;
  if (providers) {
    const got = (actual.provider ?? {}) as Record<string, Record<string, unknown>>;
    const ids = (o: object) => JSON.stringify(Object.keys(o).sort());
    if (ids(got) !== ids(providers)) throw new Error('OpenCode effective configuration differs: provider');
    for (const [id, want] of Object.entries(providers)) {
      const have = got[id] ?? {};
      const address = (o: Record<string, unknown>) => (o.options as { baseURL?: unknown } | undefined)?.baseURL;
      if (
        have.npm !== want.npm ||
        address(have) !== address(want) ||
        ids((have.models ?? {}) as object) !== ids((want.models ?? {}) as object)
      )
        throw new Error(`OpenCode effective configuration differs: provider ${id}`);
    }
    for (const key of ['model', 'small_model'])
      if (actual[key] !== profile.config[key]) throw new Error(`OpenCode effective configuration differs: ${key}`);
  } else if (actual.provider && Object.keys(actual.provider as object).length) {
    throw new Error('OpenCode effective configuration differs: provider');
  }
  profile.verify();
}

export function configured(root: string): boolean {
  try {
    const value = json(path.join(root, CONFIG_FILE));
    return (
      value.owner === 'friday' &&
      value.host === 'opencode' &&
      value.version === OPENCODE_VERSION &&
      value.mode === 'preflight' &&
      value.experimental === true
    );
  } catch {
    return false;
  }
}
