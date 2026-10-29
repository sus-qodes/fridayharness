/**
 * Helpers for the hooks of hosts other than Claude Code (plan M8b.1): the hand-written fixtures
 * under tests/fixtures/hooks/<vendor>/v<version>/, and the launcher run as such a host runs it,
 * `node hook.mjs <vendor> <event>`, with the hook input on stdin.
 */
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HookVendor } from '@friday/adapter-claude';
import { REPO_ROOT } from '../helpers/cli.js';
import { hostEnv } from '../helpers/hooks.js';

export const HOST_FIXTURE_DIRS: Record<Exclude<HookVendor, 'claude-code'>, string> = {
  cursor: path.join(REPO_ROOT, 'tests', 'fixtures', 'hooks', 'cursor', 'v3.24'),
  antigravity: path.join(REPO_ROOT, 'tests', 'fixtures', 'hooks', 'antigravity', 'v1.4'),
  gemini: path.join(REPO_ROOT, 'tests', 'fixtures', 'hooks', 'gemini', 'v0.64'),
};
export type OtherVendor = keyof typeof HOST_FIXTURE_DIRS;
export const OTHER_VENDORS = Object.keys(HOST_FIXTURE_DIRS) as OtherVendor[];

export interface HostFixture {
  host: string;
  host_version: string;
  event: string;
  note: string;
  input: Record<string, unknown>;
  launcher_args?: string[];
  env?: Record<string, string>;
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in the fixtures.
const PROJECT_DIR = '${PROJECT_DIR}';
// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal placeholder in the fixtures.
const HOME = '${HOME}';

export function hostFixtureNames(vendor: OtherVendor): string[] {
  return readdirSync(HOST_FIXTURE_DIRS[vendor])
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

/** A fixture with `${PROJECT_DIR}` and `${HOME}` filled in, paths with this OS's separator. */
export function hostFixture(
  vendor: OtherVendor,
  name: string,
  projectDir: string,
  patch: Record<string, unknown> = {},
): HostFixture {
  const f = JSON.parse(readFileSync(path.join(HOST_FIXTURE_DIRS[vendor], `${name}.json`), 'utf8')) as HostFixture;
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') {
      for (const [ph, value] of [
        [PROJECT_DIR, projectDir],
        [HOME, os.homedir()],
      ] as const) {
        if (v.startsWith(ph)) return value + v.slice(ph.length).replace(/[\\/]/g, path.sep);
      }
      return v;
    }
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return { ...(fill(f) as HostFixture), input: { ...(fill(f.input) as Record<string, unknown>), ...patch } };
}

export interface HostRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout parsed as JSON, when it is JSON. */
  json: Record<string, unknown> | null;
}

/**
 * Runs the bundled launcher the way a host does. The environment is the test process's without
 * any host's variables (this suite may run inside Claude Code or Cursor), plus `env`.
 */
export function runHost(
  file: string,
  args: string[],
  input: Record<string, unknown>,
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
): Promise<HostRun> {
  const base = hostEnv({});
  for (const k of Object.keys(base)) if (/^(CURSOR_|GEMINI_|ANTIGRAVITY_|AGY_)/.test(k)) delete base[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], {
      env: base,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`launcher ${args.join(' ')} did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json: Record<string, unknown> | null = null;
      try {
        json = stdout.trim().startsWith('{') ? (JSON.parse(stdout) as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      resolve({ code, stdout, stderr, json });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

/** Where each host tells the launcher its project is, for a run against `projectDir`. */
export function hostProjectEnv(vendor: OtherVendor, projectDir: string): Record<string, string> {
  if (vendor === 'cursor') return { CURSOR_PROJECT_DIR: projectDir, CURSOR_VERSION: '3.24.0' };
  if (vendor === 'gemini') return { GEMINI_PROJECT_DIR: projectDir, GEMINI_CWD: projectDir };
  return {}; // Antigravity names its workspace in the input (`workspacePaths`).
}

/** POSTs a hook body to `/hooks/<vendor>/<event>` as the launcher does. */
export async function postVendorHook(
  daemon: { url: string; projectId: string; token: string },
  vendor: string,
  event: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${daemon.url}/api/v1/projects/${daemon.projectId}/hooks/${vendor}/${event}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
