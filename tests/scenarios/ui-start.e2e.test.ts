/**
 * The terminal-free daily path without the desktop toolchain (docs/frontend/PLAN.md §5.12, FD-23):
 * `friday ui --start` starts Friday hidden when it is not running, and the link it prints signs a
 * browser in once. The detached daemon is the built CLI (`apps/cli/bin/friday.mjs`).
 */
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
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

describe('friday ui --start', () => {
  it.skipIf(!built)('starts Friday hidden when it is not running, then signs a browser in', async () => {
    const dir = ws().projectDir;
    writeFileSync(path.join(dir, 'README.md'), '# shop\n');
    const git = deterministicGit(dir);
    await git.init();
    expect((await cli(['--project', dir, 'init', '--name', 'shop'])).code).toBe(0);
    await git.commitAll('init friday');
    // Not running yet: plain `friday ui` says so.
    const down = await cli(['--project', dir, 'ui', '--print-link']);
    expect(down.code).toBe(3);
    const up = await cli(['--project', dir, 'ui', '--start', '--print-link']);
    try {
      expect(up.code, up.stderr).toBe(0);
      const link = up.stdout.trim();
      const m = /^(http:\/\/127\.0\.0\.1:\d+)\/ui\/[^#]*#code=([A-Za-z0-9_-]{43})$/.exec(link);
      expect(m, link).not.toBeNull();
      const [, origin, code] = m as RegExpExecArray;
      const r = await fetch(`${origin}/ui/session`, {
        method: 'POST',
        headers: { origin: origin as string, 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      expect(r.status).toBe(200);
      expect(existsSync(path.join(dir, '.friday', 'logs', 'daemon-console.log'))).toBe(true);
      // Already running: --start starts nothing new.
      const again = await cli(['--project', dir, 'ui', '--start', '--print-link']);
      expect(again.stderr).not.toContain('Starting Friday');
    } finally {
      await cli(['--project', dir, 'daemon', 'stop']);
    }
  });
});
