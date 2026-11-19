import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copiedFilesProblem, copyFilesInto, fileCopier, MAX_COPIED_BYTES } from './copy-files.js';

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

/** A project with an ignored `.env`, and a second checkout of it made from version control. */
function projectAndCopy(ignore = '.env\n.env.*.local\n') {
  const base = mkdtempSync(path.join(os.tmpdir(), 'friday-copy-files-'));
  made.push(base);
  const root = path.join(base, 'project');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@friday.invalid');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(path.join(root, '.gitignore'), ignore);
  writeFileSync(path.join(root, '.env.example'), 'DATABASE_URL=\n');
  writeFileSync(path.join(root, 'README.md'), 'a project\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'first');
  writeFileSync(path.join(root, '.env'), 'DATABASE_URL=postgres://real\n');
  const copy = path.join(base, 'copy');
  git(root, 'worktree', 'add', '-q', '--detach', copy);
  return { base, root, copy };
}

describe('files from outside version control in a copy of the project (2026-11-17)', () => {
  it('puts the ignored settings file into the copy, and leaves the copy clean for git', async () => {
    const { root, copy } = projectAndCopy();
    expect(existsSync(path.join(copy, '.env'))).toBe(false);

    const out = await copyFilesInto(root, copy, [{ from: '.env', to: '.env' }]);

    expect(out).toEqual([{ from: '.env', to: '.env', status: 'copied', reason: 'ok' }]);
    expect(readFileSync(path.join(copy, '.env'), 'utf8')).toBe('DATABASE_URL=postgres://real\n');
    expect(git(copy, 'status', '--porcelain')).toBe('');
    expect(copiedFilesProblem(out)).toBeNull();
    // Again: nothing to write.
    expect((await copyFilesInto(root, copy, [{ from: '.env', to: '.env' }]))[0]?.status).toBe('same');
  });

  it('gives a file kept for agents under the name the project reads, and follows a change to it', async () => {
    const { root, copy } = projectAndCopy();
    writeFileSync(path.join(root, '.env.agents.local'), 'DATABASE_URL=postgres://test-only\n');
    const files = [{ from: '.env.agents.local', to: '.env' }];

    await copyFilesInto(root, copy, files);
    expect(readFileSync(path.join(copy, '.env'), 'utf8')).toBe('DATABASE_URL=postgres://test-only\n');
    // The person's own file stays where it is.
    expect(readFileSync(path.join(root, '.env'), 'utf8')).toBe('DATABASE_URL=postgres://real\n');

    writeFileSync(path.join(root, '.env.agents.local'), 'DATABASE_URL=postgres://changed\n');
    expect((await copyFilesInto(root, copy, files))[0]?.status).toBe('copied');
    expect(readFileSync(path.join(copy, '.env'), 'utf8')).toBe('DATABASE_URL=postgres://changed\n');
  });

  it('never writes over a tracked file, nor a file a commit could take', async () => {
    const { root, copy } = projectAndCopy();
    const out = await copyFilesInto(root, copy, [
      { from: '.env', to: 'README.md' },
      { from: '.env', to: 'settings.txt' },
    ]);
    expect(out.map((o) => o.status)).toEqual(['refused', 'refused']);
    expect(out[0]?.reason).toContain('not written over');
    expect(out[1]?.reason).toContain('.gitignore');
    expect(readFileSync(path.join(copy, 'README.md'), 'utf8')).toContain('a project');
    expect(existsSync(path.join(copy, 'settings.txt'))).toBe(false);
    expect(copiedFilesProblem(out)).toContain('settings.txt was not given');
  });

  it('reads nothing from outside the project, and writes nothing outside the copy', async () => {
    const { base, root, copy } = projectAndCopy();
    writeFileSync(path.join(base, 'outside.txt'), 'not the project\n');
    const out = await copyFilesInto(root, copy, [
      { from: '../outside.txt', to: '.env' },
      { from: '.env', to: '../escaped.env' },
    ]);
    expect(out.map((o) => o.status)).toEqual(['refused', 'refused']);
    expect(existsSync(path.join(copy, '.env'))).toBe(false);
    expect(existsSync(path.join(base, 'escaped.env'))).toBe(false);
  });

  it('says when the file is not there, or is no settings file, and gives the others', async () => {
    const { root, copy } = projectAndCopy();
    writeFileSync(path.join(root, '.env.big.local'), Buffer.alloc(MAX_COPIED_BYTES + 1, 0x61));
    const out = await copyFilesInto(root, copy, [
      { from: '.env.local', to: '.env.local' },
      { from: '.env.big.local', to: '.env.big.local' },
      { from: '.env', to: '.env' },
    ]);
    expect(out.map((o) => o.status)).toEqual(['missing', 'refused', 'copied']);
    expect(copiedFilesProblem(out)).toContain('.env.local is not in the project folder');
  });

  it('does nothing in the project folder itself', async () => {
    const { root } = projectAndCopy();
    expect(await copyFilesInto(root, root, [{ from: '.env', to: '.env' }])).toEqual([]);
  });

  it('tells the agent what its copy lacks, and what waits for the person, without the content', async () => {
    const { root, copy } = projectAndCopy();
    const lines: string[] = [];
    const logger = {
      info: (m: string, f?: unknown) => lines.push(`${m} ${JSON.stringify(f)}`),
      warn: (m: string, f?: unknown) => lines.push(`${m} ${JSON.stringify(f)}`),
      error: () => undefined,
      debug: () => undefined,
    };
    const trusted = fileCopier({
      root,
      policy: () => ({ worktree_files: [{ from: '.env', to: '.env' }], worktree_files_held: [] }),
      logger: logger as never,
    });
    expect(await trusted(copy, { task_id: 't1' })).toBeNull();
    expect(lines.join('\n')).not.toContain('postgres://real');

    const held = fileCopier({
      root,
      policy: () => ({ worktree_files: [], worktree_files_held: [{ from: '.env.agents.local', to: '.env' }] }),
      logger: logger as never,
    });
    const said = await held(copy, { task_id: 't1' });
    expect(said).toContain('.env.agents.local as .env');
    expect(said).toContain("wait for the person's approval");
    expect(said).toContain('not because of the work');
  });
});

describe('the settings files a person is offered', () => {
  it('finds what git ignores, by name, and leaves out templates, tracked files and installed packages', async () => {
    const { root } = projectAndCopy();
    writeFileSync(path.join(root, '.env.agents.local'), 'X=1\n');
    writeFileSync(path.join(root, '.env.production'), 'not ignored\n');
    mkdirSync(path.join(root, 'apps', 'api'), { recursive: true });
    writeFileSync(path.join(root, 'apps', 'api', '.env'), 'X=1\n');
    mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'pkg', '.env'), 'X=1\n');
    const { findSettingsFiles } = await import('./copy-files.js');
    expect(await findSettingsFiles(root)).toEqual(['.env', '.env.agents.local', 'apps/api/.env']);
  });
});
