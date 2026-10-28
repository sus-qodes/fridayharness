import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '@friday/db';
import {
  DaemonClient,
  FRIDAY_DIR,
  loadProject,
  type ProjectRef,
  privateDirFor,
  readDiscovery,
  readToken,
  stateDir,
} from '@friday/sdk';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
  fix?: string;
}

/** Extra checks contributed by adapters (M1c adds Claude Code checks). */
export const extraDoctorChecks: ((ref: ProjectRef | undefined) => Promise<CheckResult[]>)[] = [];

function run(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
      ...(cwd ? { cwd } : {}),
    }).trim();
  } catch {
    return null;
  }
}

function tokenShaped(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9_-]{40,}/g)].map((m) => m[0]);
}

/** Read-only environment and project checks (plan Appendix 11). Never changes anything. */
export async function doctor(projectDir?: string): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    out.push({
      id: 'node',
      status: 'fail',
      message: `Node ${process.versions.node} is too old`,
      fix: 'install Node 24 LTS',
    });
  } else {
    out.push({
      id: 'node',
      status: major === 24 ? 'ok' : 'warn',
      message: `Node ${process.versions.node}${major === 24 ? '' : ' (24 is the tested version)'}`,
    });
  }

  const gitVersion = run('git', ['--version']);
  out.push(
    gitVersion
      ? { id: 'git', status: 'ok', message: gitVersion }
      : { id: 'git', status: 'fail', message: 'git not found on PATH', fix: 'install Git' },
  );

  try {
    const db = openDatabase(':memory:');
    const v = db.prepare('SELECT sqlite_version() AS v').get<{ v: string }>()?.v;
    out.push({ id: 'sqlite', status: 'ok', message: `${db.driver} loads (SQLite ${v})` });
    db.close();
  } catch (e) {
    out.push({
      id: 'sqlite',
      status: 'fail',
      message: `SQLite driver failed to load: ${(e as Error).message}`,
      fix: 'set FRIDAY_SQLITE_DRIVER=node:sqlite',
    });
  }

  let ref: ProjectRef | undefined;
  try {
    ref = loadProject(projectDir);
    out.push({ id: 'project', status: 'ok', message: `${ref.name} (${ref.project_id}) at ${ref.root}` });
  } catch (e) {
    out.push({
      id: 'project',
      status: 'fail',
      message: (e as Error).message,
      fix: 'run "friday init" in your repository',
    });
  }

  if (ref) {
    const fridayDir = path.join(ref.root, FRIDAY_DIR);
    const isGit = run('git', ['-C', ref.root, 'rev-parse', '--is-inside-work-tree']) === 'true';
    if (!existsSync(path.join(fridayDir, '.gitignore'))) {
      out.push({
        id: 'ignore',
        status: 'fail',
        message: '.friday/.gitignore is missing',
        fix: 'run "friday init --force"',
      });
    } else if (isGit) {
      const ignored = run('git', ['-C', ref.root, 'check-ignore', '-q', '.friday/project.db']) !== null;
      const configTracked = run('git', ['-C', ref.root, 'check-ignore', '-q', '.friday/config.yaml']) === null;
      out.push(
        ignored && configTracked
          ? { id: 'ignore', status: 'ok', message: 'runtime files ignored, config.yaml trackable' }
          : {
              id: 'ignore',
              status: 'fail',
              message: 'ignore rules are wrong for .friday/',
              fix: 'remove any root .gitignore rule for .friday and run "friday init --force"',
            },
      );
    }

    const priv = privateDirFor(ref);
    out.push({
      id: 'private-dir',
      status: existsSync(priv) ? 'ok' : 'info',
      message: `private state: ${priv}${existsSync(priv) ? '' : ' (created on first "friday run")'}`,
    });

    const discovery = readDiscovery(ref);
    if (!discovery) {
      out.push({ id: 'daemon', status: 'info', message: 'daemon not running', fix: 'start it with "friday run"' });
    } else {
      try {
        const client = DaemonClient.forProject(ref, 'operator', { timeoutMs: 2000 });
        const health = await client.get<{ status: string; instance_id: string }>('/health');
        out.push({ id: 'daemon', status: 'ok', message: `running at ${discovery.url} (${health.status})` });
        const anon = await fetch(`${discovery.url}/health`)
          .then((r) => r.status)
          .catch(() => 0);
        out.push(
          anon === 401
            ? { id: 'daemon-auth', status: 'ok', message: 'unauthenticated requests are rejected' }
            : { id: 'daemon-auth', status: 'fail', message: `unauthenticated /health returned ${anon}` },
        );
      } catch (e) {
        out.push({
          id: 'daemon',
          status: 'warn',
          message: `discovery file exists but the daemon did not answer: ${(e as Error).message}`,
          fix: 'restart with "friday run"',
        });
      }
    }

    // Secret hygiene: no token-shaped strings, and never the live tokens, in model-readable files.
    const live = [readToken(ref, 'operator'), readToken(ref, 'bootstrap')].filter((t): t is string => Boolean(t));
    const candidates = [
      path.join(fridayDir, 'config.yaml'),
      path.join(ref.root, '.mcp.json'),
      path.join(ref.root, 'CLAUDE.md'),
      path.join(ref.root, 'AGENTS.md'),
      ...listFiles(path.join(ref.root, '.claude')),
      ...listFiles(path.join(fridayDir, 'harness')),
    ].filter((f) => existsSync(f) && statSync(f).isFile() && statSync(f).size < 2_000_000);
    const leaks = candidates.filter((f) => {
      const text = readFileSync(f, 'utf8');
      return live.some((t) => text.includes(t)) || tokenShaped(text).length > 0;
    });
    out.push(
      leaks.length === 0
        ? { id: 'secrets', status: 'ok', message: `no tokens in ${candidates.length} model-readable file(s)` }
        : {
            id: 'secrets',
            status: 'fail',
            message: `token-like strings in: ${leaks.map((f) => path.relative(ref.root, f)).join(', ')}`,
            fix: 'remove them; Friday never writes tokens into the project',
          },
    );

    const remote = Object.entries(ref.config.providers).filter(([, p]) => p.allow_remote);
    if (remote.length)
      out.push({
        id: 'egress',
        status: 'warn',
        message: `remote model providers enabled: ${remote.map(([n]) => n).join(', ')}`,
      });
    if (ref.root.length > 180)
      out.push({
        id: 'long-path',
        status: 'warn',
        message: `project path is ${ref.root.length} characters; Windows paths over 260 can fail`,
      });
  }

  if (process.platform === 'win32') {
    const where = run('where', ['bash']);
    const first = where?.split(/\r?\n/)[0] ?? '';
    if (first.toLowerCase().includes('system32')) {
      out.push({
        id: 'git-bash',
        status: 'warn',
        message: `"bash" on PATH is WSL (${first}); Friday hooks do not need bash, but shell-form hooks would`,
      });
    }
    const lp = run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', '/v', 'LongPathsEnabled']);
    if (lp && /0x0\b/.test(lp))
      out.push({
        id: 'long-paths',
        status: 'info',
        message: 'Windows LongPathsEnabled=0; Friday keeps its own paths short',
      });
  }
  out.push({ id: 'state-dir', status: 'info', message: `state directory: ${stateDir()}` });

  for (const extra of extraDoctorChecks) out.push(...(await extra(ref)));
  return out;
}

function listFiles(dir: string, depth = 3): string[] {
  if (!existsSync(dir) || depth < 0) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, depth - 1));
    else out.push(p);
  }
  return out;
}

export function renderDoctor(results: CheckResult[]): string {
  const tag: Record<CheckStatus, string> = { ok: '[ ok ]', warn: '[warn]', fail: '[FAIL]', info: '[info]' };
  return results
    .map((r) => `${tag[r.status]} ${r.id.padEnd(12)} ${r.message}${r.fix ? `\n              fix: ${r.fix}` : ''}`)
    .join('\n');
}
