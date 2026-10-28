/**
 * fixture-shop (plan M1.13): a byte-identical git history on every OS, a working test suite,
 * and `friday fixture init` producing a ready Friday project.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FIXTURE_SHOP_PROJECT_ID, materializeFixtureShop } from '@friday/cli';
import { loadProject } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';

const ws = useTestWorkspace();

/**
 * HEAD of the default fixture. It changes only when the fixture's files change; update it then
 * (CI asserts the same value on Windows and Linux).
 */
const FIXTURE_SHOP_HEAD = 'ac52520e6ff8349754e9292c39533ebf85a48d6d';

const git = (cwd: string, args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();

describe('fixture-shop', () => {
  it('materializes to the same commit on every machine', () => {
    const a = materializeFixtureShop(path.join(ws().root, 'a'));
    const b = materializeFixtureShop(path.join(ws().root, 'b'));
    expect(a.head).toBe(b.head);
    expect(a.head).toBe(FIXTURE_SHOP_HEAD);
    expect(a.project_id).toBe(FIXTURE_SHOP_PROJECT_ID);
    expect(git(a.root, ['log', '--format=%s|%an|%at', 'HEAD'])).toBe(
      [
        'feat: frontend pricing helpers and Friday config|Fixture Bot|1767225602',
        'feat: shared API contract and backend checkout|Fixture Bot|1767225601',
        'chore: scaffold the shop workspace|Fixture Bot|1767225600',
      ].join('\n'),
    );
    expect(
      git(a.root, ['ls-files', '--eol'])
        .split('\n')
        .every((l) => l.startsWith('i/lf')),
    ).toBe(true);
    expect(() => materializeFixtureShop(a.root)).toThrow(/not empty/);
  });

  it('passes its own tests with plain node, as the verification check runs them', () => {
    const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
    const out = execFileSync(process.execPath, ['--test', '**/test/*.test.ts'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(out).toMatch(/ℹ fail 0/);
    expect(out).toMatch(/ℹ pass [1-9]/);
  });

  it('friday fixture init creates a ready project with its own id and a clean tree', async () => {
    const dest = path.join(ws().root, 'demo');
    const res = await cli(['--json', 'fixture', 'init', dest]);
    expect(res.code, res.stderr).toBe(0);
    const made = JSON.parse(res.stdout) as { root: string; head: string; project_id: string };
    expect(made.project_id).toMatch(/^proj_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(made.project_id).not.toBe(FIXTURE_SHOP_PROJECT_ID);
    expect(made.head).not.toBe(FIXTURE_SHOP_HEAD);
    expect(loadProject(dest).project_id).toBe(made.project_id);
    expect(readFileSync(path.join(dest, '.friday', 'config.yaml'), 'utf8')).toContain(made.project_id);
    expect(git(dest, ['status', '--porcelain'])).toBe('');
    expect(git(dest, ['check-ignore', '-q', '.friday/project.db'])).toBe('');
  });
});
