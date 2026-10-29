import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** The Gemini CLI version Friday's adapter was written against (its documented behaviour and source). */
export const RECORDED_VERSION = '0.64.0';
/** The first version whose `BeforeTool` hook can ask a human (`decision: "ask"`), which Friday's answers need. */
export const MIN_VERSION = '0.36.0';

export interface GeminiInstall {
  /** How Friday starts it: Node with the package's entry script, or the executable named. */
  command: string | null;
  args: string[];
  /** The npm package's folder, when one was found. */
  packageDir: string | null;
  /** From the package's `package.json`: read without starting Gemini CLI. */
  version: string | null;
  source: 'GEMINI_CLI_BIN' | 'npm' | 'PATH' | null;
  /** Why none can be used, in words for the operator. */
  problem: string | null;
  /** Where Friday looked, in order. */
  checked: string[];
}

const PACKAGE = ['@google', 'gemini-cli'] as const;

function packageJson(dir: string): { version?: unknown; bin?: unknown; name?: unknown } | null {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The package's entry script and version, when `dir` is the `@google/gemini-cli` package. */
function fromPackage(dir: string): { entry: string; version: string | null } | null {
  const pkg = packageJson(dir);
  if (!pkg) return null;
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin as Record<string, unknown> | undefined)?.gemini;
  const entry = typeof bin === 'string' ? path.join(dir, bin) : path.join(dir, 'bundle', 'gemini.js');
  if (!existsSync(entry)) return null;
  return { entry, version: typeof pkg.version === 'string' ? pkg.version : null };
}

/** The package that holds a script: the nearest folder above it with the package's `package.json`. */
function packageAbove(file: string): string | null {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (packageJson(dir)?.name === '@google/gemini-cli') return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Finds the installed Gemini CLI without starting it (plan M8b.4): `GEMINI_CLI_BIN` (its entry
 * script, its package folder, or an executable), then npm's per-user global folder
 * (`%APPDATA%\npm` on Windows, or the configured npm prefix), then the folders on `PATH` that hold
 * the `gemini` shim. Friday runs the package's entry script with its own Node, never npm's `.cmd`
 * shim: a shim needs a shell, and a task's text would then pass through it.
 */
export function findGemini(env: NodeJS.ProcessEnv = process.env): GeminiInstall {
  const win = process.platform === 'win32';
  const checked: string[] = [];
  const found = (
    source: GeminiInstall['source'],
    pkg: { entry: string; version: string | null },
    dir: string | null,
  ): GeminiInstall => ({
    command: process.execPath,
    args: [pkg.entry],
    packageDir: dir,
    version: pkg.version,
    source,
    problem: null,
    checked,
  });

  const explicit = env.GEMINI_CLI_BIN;
  if (explicit) {
    checked.push(explicit);
    if (existsSync(path.join(explicit, 'package.json'))) {
      const pkg = fromPackage(explicit);
      if (pkg) return found('GEMINI_CLI_BIN', pkg, explicit);
    } else if (/\.(c|m)?js$/i.test(explicit) && isFile(explicit)) {
      const dir = packageAbove(explicit);
      const version = dir ? ((packageJson(dir)?.version as string | undefined) ?? null) : null;
      return found('GEMINI_CLI_BIN', { entry: explicit, version }, dir);
    } else if (isFile(explicit) && !/\.(cmd|bat|ps1)$/i.test(explicit)) {
      // An executable (a native build): it is not started to ask its version.
      return {
        command: explicit,
        args: [],
        packageDir: null,
        version: null,
        source: 'GEMINI_CLI_BIN',
        problem: null,
        checked,
      };
    }
    return {
      command: null,
      args: [],
      packageDir: null,
      version: null,
      source: null,
      problem: `GEMINI_CLI_BIN (${explicit}) is not Gemini CLI's package folder, its entry script or an executable`,
      checked,
    };
  }

  const prefixes: string[] = [];
  if (win && env.APPDATA) prefixes.push(path.join(env.APPDATA, 'npm'));
  for (const p of [env.npm_config_prefix, env.NPM_CONFIG_PREFIX]) if (p) prefixes.push(p);
  for (const prefix of prefixes) {
    // npm's global layout: <prefix>\node_modules on Windows, <prefix>/lib/node_modules elsewhere.
    const dir = win
      ? path.join(prefix, 'node_modules', ...PACKAGE)
      : path.join(prefix, 'lib', 'node_modules', ...PACKAGE);
    checked.push(dir);
    const pkg = fromPackage(dir);
    if (pkg) return found('npm', pkg, dir);
  }

  let shim: string | null = null;
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const names = win ? ['gemini.cmd', 'gemini.ps1', 'gemini.exe', 'gemini'] : ['gemini'];
    const hit = names.map((n) => path.join(d, n)).find(isFile);
    if (!hit) continue;
    checked.push(hit);
    for (const dir of [
      path.join(d, 'node_modules', ...PACKAGE),
      path.join(d, '..', 'lib', 'node_modules', ...PACKAGE),
    ]) {
      const pkg = fromPackage(dir);
      if (pkg) return found('PATH', pkg, path.resolve(dir));
    }
    shim ??= hit;
  }
  return {
    command: null,
    args: [],
    packageDir: null,
    version: null,
    source: null,
    problem: shim
      ? `found ${shim}, but not the @google/gemini-cli package behind it: set GEMINI_CLI_BIN to its bundle/gemini.js`
      : 'Gemini CLI was not found: install it for your user ("npm install -g @google/gemini-cli"), or set GEMINI_CLI_BIN to its bundle/gemini.js',
    checked,
  };
}

/** `a` compared with `b` by their first three numbers: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1, 4).map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** Names that look like a secret, which no host gets from Friday's environment. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i;
/** Gemini CLI's own login, when the user gives it by environment. */
const GEMINI_LOGIN = new Set(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS']);

/**
 * The environment of a Gemini CLI session Friday's spawn adapter starts: the adapter's own, without
 * Friday's variables (the state folder its hook launcher reads stays), without the variables of a
 * Claude Code or Cursor session the adapter itself runs in, and without anything that looks like a
 * secret, except Gemini CLI's own login.
 */
export function geminiEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (upper.startsWith('FRIDAY_') && upper !== 'FRIDAY_STATE_DIR') continue;
    if (upper.startsWith('CLAUDE') || upper.startsWith('CURSOR_') || upper === 'MCP_CONNECTION_NONBLOCKING') continue;
    if (SECRET_NAME.test(k) && !GEMINI_LOGIN.has(upper)) continue;
    out[k] = v;
  }
  return out;
}

/** Which of Gemini CLI's own ways to sign in by environment are set (their names only, never their values). */
export function geminiLoginHints(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GOOGLE_GENAI_USE_GCA',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
  ].filter((k) => Boolean(env[k]));
}
