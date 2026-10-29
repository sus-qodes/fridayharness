import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface CodexInstall {
  /** The executable Friday starts (`codex app-server`), or null when none was found. */
  binary: string | null;
  /** Its version (`codex --version`), when it answered. */
  version: string | null;
  /** Why none can be used, in words for the operator. */
  problem: string | null;
  /** Where Friday looked, in order. */
  checked: string[];
}

/**
 * Finds the Codex executable: `CODEX_BIN`, then `PATH`, then the standalone installer's folder on
 * Windows (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`). A `.cmd` shim (an npm install) is not
 * used: Friday speaks to the host over stdio inside a process group, which needs the executable.
 */
export function findCodex(env: NodeJS.ProcessEnv = process.env): CodexInstall {
  const checked: string[] = [];
  const win = process.platform === 'win32';
  const candidates: string[] = [];
  if (env.CODEX_BIN) candidates.push(env.CODEX_BIN);
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) candidates.push(path.join(dir, win ? 'codex.exe' : 'codex'));
  if (win && env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'));
  }
  let shim: string | null = null;
  for (const c of candidates) {
    checked.push(c);
    if (!existsSync(c)) {
      if (win && !shim && existsSync(c.replace(/\.exe$/i, '.cmd'))) shim = c.replace(/\.exe$/i, '.cmd');
      continue;
    }
    let version: string | null = null;
    try {
      const out = execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      version = out.trim().split(/\s+/).pop() ?? null;
    } catch {
      // it exists but did not answer: the doctor says so
    }
    return { binary: c, version, problem: null, checked };
  }
  return {
    binary: null,
    version: null,
    problem: shim
      ? `only the npm shim ${shim} was found; Friday needs the codex executable: install the standalone Codex, or set CODEX_BIN to codex.exe`
      : 'Codex was not found: install it, or set CODEX_BIN to the codex executable',
    checked,
  };
}

/** Names that look like a secret, which no host gets from Friday's environment. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL)/i;
/** Codex's own login and home, which it needs (its shell policy keeps them from its commands). */
const CODEX_OWN = new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME']);

/**
 * The environment the host runs with: the adapter's own, without Friday's variables and without
 * anything that looks like a secret, except Codex's own login (ADR-0032 §2).
 */
export function hostEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || /^FRIDAY_/i.test(k)) continue;
    if (SECRET_NAME.test(k) && !CODEX_OWN.has(k.toUpperCase())) continue;
    out[k] = v;
  }
  return out;
}
