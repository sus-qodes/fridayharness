import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { configured, LEVEL_NOTE, managedConfigProblem, verifyDependencies } from './profile.js';

export interface OpenCodeCheck {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  message: string;
  fix?: string;
}
export function findOpenCode(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.OPENCODE_BIN,
    ...(env.PATH ?? env.Path ?? '')
      .split(path.delimiter)
      .filter((p) => p && path.isAbsolute(p))
      .map((p) => path.join(p, process.platform === 'win32' ? 'opencode.exe' : 'opencode')),
  ];
  for (const candidate of candidates) {
    if (
      candidate &&
      path.isAbsolute(candidate) &&
      !/\.(cmd|bat|ps1)$/i.test(candidate) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    )
      return realpathSync(candidate);
  }
  return null;
}
/** Read-only doctor: no host login, version process, model, or implicit package installation. */
export function opencodeDoctor(root: string, env: NodeJS.ProcessEnv = process.env) {
  let binary = findOpenCode(env);
  if (binary) {
    const rel = path.relative(realpathSync(root), binary);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) binary = null;
  }
  const checks: OpenCodeCheck[] = [
    {
      id: 'opencode.binary',
      status: binary ? 'ok' : 'fail',
      message: binary ? 'OpenCode executable found' : 'Set OPENCODE_BIN to the native OpenCode executable',
    },
    {
      id: 'opencode.config',
      status: configured(root) ? 'ok' : 'fail',
      message: configured(root) ? 'No-model profile declared' : 'Run friday harness config opencode',
    },
    { id: 'opencode.level', status: 'warn', message: LEVEL_NOTE },
  ];
  try {
    if (!env.FRIDAY_OPENCODE_DEPS_DIR)
      throw new Error('Set FRIDAY_OPENCODE_DEPS_DIR to a preinstalled pinned plugin dependency bundle');
    verifyDependencies(env.FRIDAY_OPENCODE_DEPS_DIR);
    checks.push({ id: 'opencode.dependencies', status: 'ok', message: 'Pinned offline dependency bundle found' });
  } catch {
    checks.push({
      id: 'opencode.dependencies',
      status: 'fail',
      message: 'Pinned @opencode-ai/plugin 1.19.3 dependency bundle and npm lockfile are required',
    });
  }
  const managed = managedConfigProblem(env);
  checks.push({
    id: 'opencode.managed',
    status: managed ? 'fail' : 'ok',
    message: managed ?? 'No conflicting administrator config found',
  });
  return { checks, binary, experimental: true, achieved: 'L1 unverified' as const, model_calls: false };
}
