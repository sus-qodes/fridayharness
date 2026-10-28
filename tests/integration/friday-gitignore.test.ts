/**
 * M0 step 10 — ignore-strategy test (cross-check finding P1-4, ADR-0012).
 *
 * Proves that the `.friday/.gitignore` written by `friday init` keeps runtime state
 * (database, WAL, discovery file, logs, caches) out of git while `config.yaml`,
 * `policies/` and `harness/` stay trackable — with no `.friday` rule in the root `.gitignore`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FRIDAY_DIR_GITIGNORE, FRIDAY_RUNTIME_PATHS, FRIDAY_TRACKED_PATHS } from '@friday/cli';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';

function write(file: string, content = 'x\n'): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

describe('.friday/.gitignore strategy', () => {
  const ws = useTestWorkspace();

  async function setUpProject() {
    const project = ws().projectDir;
    const git = deterministicGit(project);
    await git.init();
    // A typical root .gitignore that a user might already have; it must not need a .friday rule.
    write(path.join(project, '.gitignore'), 'node_modules/\ndist/\n');
    write(path.join(project, '.friday', '.gitignore'), FRIDAY_DIR_GITIGNORE);
    for (const p of FRIDAY_TRACKED_PATHS) if (p !== '.gitignore') write(path.join(project, '.friday', p));
    for (const p of FRIDAY_RUNTIME_PATHS) write(path.join(project, '.friday', p));
    return { project, git };
  }

  it('ignores every runtime path', async () => {
    const { git } = await setUpProject();
    for (const p of FRIDAY_RUNTIME_PATHS) {
      expect(await git.exitCode(['check-ignore', '-q', `.friday/${p}`]), `${p} should be ignored`).toBe(0);
    }
  });

  it('keeps config, policies, harness files and the .gitignore itself trackable', async () => {
    const { git } = await setUpProject();
    for (const p of FRIDAY_TRACKED_PATHS) {
      expect(await git.exitCode(['check-ignore', '-q', `.friday/${p}`]), `${p} should be trackable`).toBe(1);
    }
  });

  it('git add -A stages exactly the trackable files', async () => {
    const { git } = await setUpProject();
    await git.run(['add', '-A']);
    const staged = (await git.run(['ls-files'])).split('\n').filter(Boolean).sort();
    const expected = ['.gitignore', ...FRIDAY_TRACKED_PATHS.map((p) => `.friday/${p}`)].sort();
    expect(staged).toEqual(expected);
  });

  it('git status --ignored lists the runtime files as ignored', async () => {
    const { git } = await setUpProject();
    const out = await git.run(['status', '--porcelain', '--ignored', '--untracked-files=all']);
    const ignored = out
      .split('\n')
      .filter((l) => l.startsWith('!! '))
      .map((l) => l.slice(3));
    for (const p of FRIDAY_RUNTIME_PATHS) {
      const top = p.includes('/') ? `.friday/${p.split('/')[0]}/` : `.friday/${p}`;
      expect(
        ignored.some((i) => i === `.friday/${p}` || i === top),
        `${p} missing from ignored list`,
      ).toBe(true);
    }
  });
});
