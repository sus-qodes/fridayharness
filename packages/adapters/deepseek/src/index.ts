import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * DeepSeek Harness, as far as Friday knows it (ADR-0036 §4; plan Phase 4): the handoff names the
 * binary `dsh` and the user file `~/.deepseek-harness/config.yaml`, and nothing of it has been seen
 * running under Friday. This package detects the binary, owns one marked block in that file for
 * Friday's MCP server, and reports what it found. It spawns nothing and attaches to nothing: the
 * registry keeps every DeepSeek entry non-dispatchable until someone has seen it work (ADR-0031).
 */
export const PACKAGE_NAME = '@friday/adapter-deepseek';

export const DEEPSEEK_BINARY = 'dsh';
export const DEEPSEEK_STATUS = 'set up, not live-tested: no attempt is dispatched to it (ADR-0036 §4)';

/** The user configuration file the handoff names, under the given home folder. */
export function deepseekConfigPath(home: string = os.homedir()): string {
  return path.join(home, '.deepseek-harness', 'config.yaml');
}

/** A file a bare name on PATH resolves to (with PATHEXT on Windows), or null. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const windows = process.platform === 'win32';
  const pathVar = windows
    ? (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '')
    : (env.PATH ?? '');
  const exts = windows
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((e) => e.trim())
        .filter((e) => e.startsWith('.'))
    : [''];
  for (const dir of pathVar.split(windows ? ';' : ':')) {
    const d = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!d || !path.isAbsolute(d)) continue;
    for (const ext of [...(windows ? [''] : []), ...exts]) {
      const candidate = path.join(d, `${name}${ext}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        // unreadable: not it
      }
    }
  }
  return null;
}

export interface DeepSeekInstall {
  binary: string | null;
  /** Never read: starting an unknown binary to ask its version is not Friday's to do before a live test. */
  version: null;
  problem: string | null;
}

/** Whether `dsh` is on PATH; its version is not asked for. */
export function findDeepSeekHarness(env: NodeJS.ProcessEnv = process.env): DeepSeekInstall {
  const binary = findOnPath(DEEPSEEK_BINARY, env);
  return binary
    ? { binary, version: null, problem: null }
    : { binary: null, version: null, problem: `${DEEPSEEK_BINARY} is not on PATH` };
}

export const DEEPSEEK_BLOCK_BEGIN =
  '# >>> friday: managed by "friday hosts setup"; remove with "friday hosts remove deepseek" >>>';
export const DEEPSEEK_BLOCK_END = '# <<< friday <<<';
const BLOCK_RE = /\n?# >>> friday:[^\n]*>>>\n[\s\S]*?# <<< friday <<<\n?/;

/** Friday's block for the file: the MCP server, as the handoff's Cordis plugin block names it. */
export function deepseekBlock(launcher: string): string {
  return [
    DEEPSEEK_BLOCK_BEGIN,
    'mcp_servers:',
    '  friday:',
    '    command: node',
    `    args: [${JSON.stringify(launcher)}]`,
    '    env:',
    '      FRIDAY_HARNESS: generic',
    DEEPSEEK_BLOCK_END,
    '',
  ].join('\n');
}

/**
 * The file with Friday's block added, replaced or removed, the rest kept byte for byte. `manual`
 * when the file declares `mcp_servers:` itself outside Friday's block: YAML is not parsed, so a
 * second top-level key would be a duplicate, and the user's file is never touched.
 */
export function mergeDeepSeekConfig(
  existing: string | null,
  launcher: string,
  install: boolean,
): string | null | 'manual' {
  const rest = (existing ?? '').replace(BLOCK_RE, '');
  if (install && /^mcp_servers\s*:/m.test(rest)) return 'manual';
  if (!install) return existing === null || rest.trim() === '' ? null : rest.endsWith('\n') ? rest : `${rest}\n`;
  const base = rest.trim() === '' ? '' : rest.endsWith('\n') ? rest : `${rest}\n`;
  return `${base}${base ? '\n' : ''}${deepseekBlock(launcher)}`;
}
