/**
 * `friday start` (plan M12.5): from a fresh git repository (no commit yet) to a running Friday
 * with the Studio's address printed, in one command; a second start reuses the running daemon. The
 * detached daemon is the built CLI (`apps/cli/bin/friday.mjs`), as `ui --start` starts it. With
 * FRIDAY_TEST_PACK=1 the same is done with the install archive: it is packed (or the one in
 * dist-release is taken), installed into a temporary npm prefix and driven as a user would.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';

const ws = useTestWorkspace();
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

const built = existsSync(path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'bin.js'));

async function health(url: string): Promise<number> {
  try {
    return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).status;
  } catch {
    return 0;
  }
}

async function stopped(url: string): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    if ((await health(url)) === 0) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe('friday start', () => {
  it('refuses a folder that is not a git repository, naming the command that makes it one', async () => {
    const r = await cli(['--project', ws().projectDir, 'start', '--no-open']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('not a git repository');
    expect(r.stderr).toContain('git init');
    expect(existsSync(path.join(ws().fridayDir, 'config.yaml'))).toBe(false);
  });

  it.skipIf(!built)(
    'in a fresh repository initializes the project, starts Friday hidden and prints the Studio address; a second start reuses it',
    async () => {
      const dir = ws().projectDir;
      execFileSync('git', ['init', '-q'], { cwd: dir, windowsHide: true });
      const first = await cli(['--project', dir, 'start', '--no-open']);
      let url = '';
      try {
        expect(first.code, first.stderr).toBe(0);
        const lines = first.stdout.trim().split('\n');
        // Three lines, and one more while the project has no approved intent (ADR-0034 §2).
        expect(lines.length).toBeLessThanOrEqual(4);
        if (lines.length === 4) expect(lines[3]).toContain('friday intent');
        expect(lines[0]).toContain('Initialized Friday');
        expect(lines[1]).toContain('Started Friday hidden');
        const m = /(http:\/\/127\.0\.0\.1:\d+)\/ui\//.exec(first.stdout);
        expect(m, first.stdout).not.toBeNull();
        url = (m as RegExpExecArray)[1] as string;
        expect(readFileSync(path.join(dir, '.friday', 'config.yaml'), 'utf8')).toContain('name: "p"');
        expect(existsSync(path.join(dir, '.friday', '.gitignore'))).toBe(true);
        expect([200, 401]).toContain(await health(url));

        const again = await cli(['--json', '--project', dir, 'start', '--no-open']);
        expect(again.code, again.stderr).toBe(0);
        expect(JSON.parse(again.stdout)).toMatchObject({
          initialized: false,
          started: false,
          url,
          studio: `${url}/ui/`,
          opened: null,
        });
        expect(again.stdout).not.toContain('Initialized');
      } finally {
        if (url) {
          await cli(['--project', dir, 'daemon', 'stop']);
          expect(await stopped(url)).toBe(true);
        }
      }
    },
    90_000,
  );

  it.skipIf(!process.env.FRIDAY_TEST_PACK)(
    'the install archive installs into an empty prefix, and its friday starts Friday and serves the Studio in a fresh repository',
    async () => {
      const { fridayVersion, pack, RELEASE_DIR, verifyArchive } = await import('../../scripts/release/pack.mjs');
      const existing = path.join(RELEASE_DIR, `friday-${fridayVersion()}.tgz`);
      const log = (line: string) => process.stderr.write(`[pack] ${line}\n`);
      const report = existsSync(existing)
        ? await verifyArchive(existing, { log })
        : (await pack({ build: true, verify: true, log })).verification;
      expect(report).not.toBeNull();
      expect(report?.checks.every((c) => c.ok)).toBe(true);
      expect(report?.checks.map((c) => c.name)).toEqual(
        expect.arrayContaining([
          'friday --version',
          'friday setup --help',
          'friday registry validate matches the packaged artifact',
          'friday start in a fresh repository initializes it and starts Friday',
          'the Studio is served from the archive',
          'Friday stopped',
        ]),
      );
      expect(report?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    },
    900_000,
  );
});
