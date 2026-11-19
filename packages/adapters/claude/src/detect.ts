import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENFORCING_MIN = '2.1.295';
export const DEGRADED_MIN = '2.1.232';
/**
 * Spawn mode (ADR-0032 §11) needs the headless flags it was checked against: `--restricted`,
 * `--permission-prompts`, `--append-system-prompt-file`, `--json-schema`, `--replay-user-messages`
 * (checked without a model call on 2.1.300).
 */
export const SPAWN_MIN = '2.1.300';

export interface ClaudeInstall {
  binary: string;
  version: string | null;
  source: 'PATH' | 'CLAUDE_CODE_BIN' | 'install-folder' | 'vscode-extension' | 'claude-cli-nodejs';
}

export type HookLevel = 'enforcing' | 'degraded' | 'unsupported' | 'unknown';

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** ADR-0009: `onFailure: "block"` (fail-closed hooks) needs 2.1.295. */
export function hookLevel(version: string | null): HookLevel {
  if (!version) return 'unknown';
  if (compareVersions(version, ENFORCING_MIN) >= 0) return 'enforcing';
  if (compareVersions(version, DEGRADED_MIN) >= 0) return 'degraded';
  return 'unsupported';
}

/** The version `claude --version` prints for this binary; null when it cannot be run. */
export function claudeVersionOf(binary: string): string | null {
  try {
    // A nested Claude Code refuses to start inside another session; drop the session variables.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && k !== 'MCP_CONNECTION_NONBLOCKING'),
    );
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 15_000,
      env,
    });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Every `claude` that `where` (Windows) or `which` lists, in its order. */
function onPath(): string[] {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Windows: the folders of the PATH a program started now would get (the user's and the machine's,
 * from the registry). A process keeps the PATH it started with, so a Claude Code installed while
 * Friday runs is on this one and not on Friday's own.
 */
function registryPath(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [];
  const dirs: string[] = [];
  for (const key of ['HKCU\\Environment', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment']) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 5000,
      });
      const value = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(out)?.[1] ?? '';
      for (const raw of value.split(';')) {
        const dir = raw
          .trim()
          .replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? env[name.toUpperCase()] ?? whole);
        if (dir) dirs.push(dir);
      }
    } catch {
      // No such value, or the registry cannot be read: the process's own PATH is what there is.
    }
  }
  return dirs;
}

/** What detection asks of the machine. Tests give their own. */
export interface DetectSystem {
  platform: NodeJS.Platform;
  home: string;
  exists(file: string): boolean;
  list(dir: string): string[];
  read(file: string): string | null;
  versionOf(binary: string): string | null;
  onPath(): string[];
  currentPath(env: NodeJS.ProcessEnv): string[];
}

const SYSTEM: DetectSystem = {
  platform: process.platform,
  home: os.homedir(),
  exists: (file) => existsSync(file),
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
  read: (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  },
  versionOf: claudeVersionOf,
  onPath,
  currentPath: registryPath,
};

/** Where the npm package keeps the program, beside the shims npm writes for it. */
const NPM_PROGRAM = ['node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'];

/**
 * Windows: the program a `claude.cmd` shim starts. npm (and the tools that follow its layout)
 * write a `.cmd` beside a script without an extension; neither can be started without a shell,
 * which Friday does not use for a host. The shim names the program it runs relative to its own
 * folder (`"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"`).
 */
export function programOfShim(shim: string, sys: Pick<DetectSystem, 'read' | 'exists'>): string | null {
  const dir = path.win32.dirname(shim);
  const named = /"%~?dp0%?\\?([^"%]+?\.exe)"/i.exec(sys.read(shim) ?? '')?.[1];
  const candidates = [
    ...(named && !path.win32.isAbsolute(named) && !named.split(/[\\/]/).includes('..')
      ? [path.win32.join(dir, named)]
      : []),
    path.win32.join(dir, ...NPM_PROGRAM),
  ];
  return candidates.find((c) => sys.exists(c)) ?? null;
}

interface Candidate {
  binary: string;
  source: ClaudeInstall['source'];
}

/**
 * Every place Claude Code may be, in the order they are trusted (ADR-0009: PATH, CLAUDE_CODE_BIN,
 * then where its installers put it, the VS Code extension, claude-cli-nodejs). Reviewed 2026-11-17:
 * - `where claude` on a machine with the npm install lists only npm's shims, which cannot be run
 *   without a shell: such a machine had Claude Code on PATH and Friday said it was not installed
 *   (unless the VS Code extension happened to be there). The shim's program is now found.
 * - The native installer's `~/.local/bin` is often not on PATH, and never on the PATH of a Friday
 *   that was running when Claude Code was installed: it is looked in directly, as are the folders
 *   of the PATH a program started now would get (Windows), and the usual folders a program
 *   started from the Finder or a launcher does not have on its PATH (macOS, Linux).
 */
export function claudeCandidates(env: NodeJS.ProcessEnv, sys: DetectSystem): Candidate[] {
  const win = sys.platform === 'win32';
  const join = win ? path.win32.join : path.posix.join;
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (binary: string | null | undefined, source: Candidate['source']) => {
    if (!binary) return;
    const id = win ? binary.toLowerCase() : binary;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ binary, source });
  };
  /** A file found under the name `claude`: itself, or on Windows the program its shim starts. */
  const addFound = (file: string, source: Candidate['source']) => {
    if (!win) return add(file, source);
    if (/\.exe$/i.test(file)) return add(file, source);
    if (/\.(cmd|bat)$/i.test(file)) return add(programOfShim(file, sys), source);
    // npm's script without an extension (for a POSIX shell) and its .ps1: the .cmd beside them speaks for all three.
    return undefined;
  };

  const listed = sys.onPath();
  // A program before a shim, whatever the order `where` gave them in.
  for (const f of listed.filter((l) => !win || /\.exe$/i.test(l))) addFound(f, 'PATH');
  for (const f of listed) addFound(f, 'PATH');

  if (env.CLAUDE_CODE_BIN) add(env.CLAUDE_CODE_BIN, 'CLAUDE_CODE_BIN');

  const inFolder = (dir: string) => {
    if (win) {
      addFound(join(dir, 'claude.exe'), 'install-folder');
      addFound(join(dir, 'claude.cmd'), 'install-folder');
    } else addFound(join(dir, 'claude'), 'install-folder');
  };
  // The native installer's folder, on every system.
  inFolder(join(sys.home, '.local', 'bin'));
  if (win) {
    if (env.APPDATA) inFolder(join(env.APPDATA, 'npm'));
    // Absolute folders only: a relative one would be read against wherever this runs.
    for (const dir of sys.currentPath(env)) if (path.win32.isAbsolute(dir)) inFolder(dir);
  } else {
    for (const dir of [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(sys.home, '.npm-global', 'bin'),
      join(sys.home, '.claude', 'local'),
      join(sys.home, '.bun', 'bin'),
      join(sys.home, '.volta', 'bin'),
    ]) {
      inFolder(dir);
    }
  }

  // The editors' extension: the newest first. VS Code, its Insiders build and Cursor keep it alike.
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor']) {
    const root = join(sys.home, editor, 'extensions');
    const versionOf = (d: string) => d.replace(/^anthropic\.claude-code-/, '');
    const exts = sys
      .list(root)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort((a, b) => compareVersions(versionOf(b), versionOf(a)));
    for (const d of exts) {
      add(join(root, d, 'resources', 'native-binary', win ? 'claude.exe' : 'claude'), 'vscode-extension');
    }
  }

  if (win && env.LOCALAPPDATA) {
    const dir = join(env.LOCALAPPDATA, 'claude-cli-nodejs');
    add(join(dir, 'claude.exe'), 'claude-cli-nodejs');
    add(join(dir, 'bin', 'claude.exe'), 'claude-cli-nodejs');
  }
  return out;
}

/**
 * Finds Claude Code: the first place of `claudeCandidates` whose program runs and is new enough
 * for Friday to start agents with (`SPAWN_MIN`); when none is, the first that runs at all, so the
 * person is told which version they have. Before, the first that ran was taken whatever its
 * version: an old `claude` on PATH hid a current one in the editor's extension, and Friday said
 * Claude Code was too old to start.
 */
export function detectClaudeCode(
  env: NodeJS.ProcessEnv = process.env,
  system: Partial<DetectSystem> = {},
): ClaudeInstall | null {
  const sys: DetectSystem = { ...SYSTEM, ...system };
  const isAbsolute = sys.platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  let first: ClaudeInstall | null = null;
  for (const c of claudeCandidates(env, sys)) {
    if (isAbsolute(c.binary) && !sys.exists(c.binary)) continue;
    const version = sys.versionOf(c.binary);
    if (!version) continue;
    const found: ClaudeInstall = { binary: c.binary, version, source: c.source };
    if (compareVersions(version, SPAWN_MIN) >= 0) return found;
    first ??= found;
  }
  return first;
}
