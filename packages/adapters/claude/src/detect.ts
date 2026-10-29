import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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
  source: 'PATH' | 'CLAUDE_CODE_BIN' | 'vscode-extension' | 'claude-cli-nodejs';
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

function versionOf(binary: string): string | null {
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

function onPath(): string | undefined {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    // `where` also lists .cmd shims, which cannot be executed without a shell; prefer an .exe.
    const exe = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /\.exe$/i.test(l));
    return exe ?? first;
  } catch {
    return undefined;
  }
}

/** Finds Claude Code in the order of ADR-0009: PATH, CLAUDE_CODE_BIN, VS Code extension, claude-cli-nodejs. */
export function detectClaudeCode(env: NodeJS.ProcessEnv = process.env): ClaudeInstall | null {
  const tryBin = (binary: string | undefined, source: ClaudeInstall['source']): ClaudeInstall | null => {
    if (!binary) return null;
    if (path.isAbsolute(binary) && !existsSync(binary)) return null;
    const version = versionOf(binary);
    return version ? { binary, version, source } : null;
  };
  const fromPath = tryBin(onPath(), 'PATH');
  if (fromPath) return fromPath;
  const fromEnv = tryBin(env.CLAUDE_CODE_BIN, 'CLAUDE_CODE_BIN');
  if (fromEnv) return fromEnv;
  const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
  if (existsSync(extRoot)) {
    const exts = readdirSync(extRoot)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort((a, b) =>
        compareVersions(b.replace(/^anthropic\.claude-code-/, ''), a.replace(/^anthropic\.claude-code-/, '')),
      );
    for (const d of exts) {
      const bin = path.join(
        extRoot,
        d,
        'resources',
        'native-binary',
        process.platform === 'win32' ? 'claude.exe' : 'claude',
      );
      const hit = tryBin(bin, 'vscode-extension');
      if (hit) return hit;
    }
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const dir = path.join(env.LOCALAPPDATA, 'claude-cli-nodejs');
    for (const name of ['claude.exe', path.join('bin', 'claude.exe')]) {
      const hit = tryBin(path.join(dir, name), 'claude-cli-nodejs');
      if (hit) return hit;
    }
  }
  return null;
}
