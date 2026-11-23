import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeCleanInstall, lockRoots } from './clean-install.js';

const ROOT = path.resolve('/repo');
/** A checkout that has exactly these files. */
const has =
  (...files: string[]) =>
  (file: string) =>
    files.some((f) => path.resolve(ROOT, f) === path.resolve(file));

describe('which lockfiles a change calls for checking', () => {
  it('is none when no manifest or lockfile changed', () => {
    expect(lockRoots(ROOT, ['src/a.ts', 'docs/package.json.md'], has('package-lock.json'))).toEqual([]);
  });

  it('is the lockfile beside a changed manifest, or the lockfile itself', () => {
    expect(lockRoots(ROOT, ['package.json'], has('package-lock.json'))).toEqual([
      { dir: '', lockfile: 'package-lock.json' },
    ]);
    expect(lockRoots(ROOT, ['package-lock.json'], has('package-lock.json'))).toEqual([
      { dir: '', lockfile: 'package-lock.json' },
    ]);
  });

  it("is the root's lockfile for a workspace's manifest, once", () => {
    const changed = ['apps/owner-web/package.json', 'packages/config/package.json', 'package-lock.json'];
    expect(lockRoots(ROOT, changed, has('package-lock.json'))).toEqual([{ dir: '', lockfile: 'package-lock.json' }]);
  });

  it('is the nearest one above, when a folder has a lockfile of its own', () => {
    const changed = ['tools\\gen\\package.json', 'package.json'];
    expect(lockRoots(ROOT, changed, has('package-lock.json', 'tools/gen/npm-shrinkwrap.json'))).toEqual([
      { dir: 'tools/gen', lockfile: 'npm-shrinkwrap.json' },
      { dir: '', lockfile: 'package-lock.json' },
    ]);
  });

  it('is none for another package manager, a removed lockfile, or a package inside node_modules', () => {
    expect(lockRoots(ROOT, ['package.json'], has('pnpm-lock.yaml'))).toEqual([]);
    expect(lockRoots(ROOT, ['package-lock.json'], has())).toEqual([]);
    expect(lockRoots(ROOT, ['node_modules/x/package.json'], has('package-lock.json'))).toEqual([]);
  });
});

describe('what npm said about a clean install', () => {
  const AT = { dir: '', lockfile: 'package-lock.json' };
  const answer = (over: Partial<Parameters<typeof judgeCleanInstall>[0]>) => ({
    passed: false,
    output: '',
    timed_out: false,
    spawn_error: null,
    exit_code: 1,
    ...over,
  });

  it('passes when npm would install', () => {
    expect(judgeCleanInstall(answer({ passed: true, exit_code: 0, output: 'added 12 packages in 1s' }), AT)).toEqual({
      verdict: 'ok',
      summary: 'a clean install (npm ci) works with package-lock.json',
    });
  });

  it('fails a lockfile npm refuses, with what is missing and what to do', () => {
    // As npm 10 and 11 print it (the trial of 2026-11-18).
    const output = [
      'npm error code EUSAGE',
      'npm error',
      'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
      'npm error',
      'npm error Missing: @emnapi/core@1.11.2 from lock file',
      'npm error Missing: @emnapi/runtime@1.11.2 from lock file',
      "npm error Invalid: lock file's left-pad@1.0.0 does not satisfy left-pad@2.0.0",
      'npm error',
      'npm error Clean install a project',
    ].join('\n');
    const j = judgeCleanInstall(answer({ output }), { dir: 'apps/web', lockfile: 'package-lock.json' });
    expect(j.verdict).toBe('out_of_step');
    expect(j.summary).toContain('apps/web/package-lock.json does not match package.json');
    expect(j.summary).toContain('Missing: @emnapi/core@1.11.2 from lock file; Missing: @emnapi/runtime@1.11.2');
    expect(j.summary).toContain("Invalid: lock file's left-pad@1.0.0 does not satisfy left-pad@2.0.0");
    expect(j.summary).toContain('Run "npm install" in apps/web');
    // Older npm: "npm ERR!" and one lockfile named.
    const old =
      'npm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync.\nnpm ERR! Missing: tiny@1.0.0 from lock file';
    expect(judgeCleanInstall(answer({ output: old }), AT).verdict).toBe('out_of_step');
  });

  it('does not fail the work when npm could not say', () => {
    const offline = judgeCleanInstall(answer({ output: 'npm error code ENOTCACHED\nnpm error request to …' }), AT);
    expect(offline.verdict).toBe('unknown');
    expect(offline.summary).toContain('npm exited with 1');
    expect(offline.summary).toContain('the work is not failed for it');
    expect(judgeCleanInstall(answer({ timed_out: true, exit_code: null }), AT).summary).toContain(
      'npm did not answer within 120 s',
    );
    expect(judgeCleanInstall(answer({ spawn_error: 'ENOENT', exit_code: null }), AT).summary).toContain(
      'npm could not start: ENOENT',
    );
    // A timeout whose partial output looks like the refusal is still not a refusal.
    expect(
      judgeCleanInstall(answer({ timed_out: true, output: 'Missing: x@1.0.0 from lock file', exit_code: null }), AT)
        .verdict,
    ).toBe('unknown');
  });
});
