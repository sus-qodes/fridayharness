/**
 * `friday git-start` (2026-11-19, G2): a folder that is not under git is given one, with its files
 * saved as the first version, secrets and tools' folders left out, and nothing changed on refusal.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_GITIGNORE, FIRST_VERSION, isSecretFile, startGit } from './start-git.js';

let root: string;
let saved: NodeJS.ProcessEnv;
const git = (args: string[], cwd = root) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const put = (rel: string, text = 'x') => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text);
};

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'friday-git-start-'));
  saved = { ...process.env };
  // A computer where git knows nobody: no global or system settings.
  const empty = path.join(root, '..', `${path.basename(root)}.gitconfig`);
  writeFileSync(empty, '');
  process.env.GIT_CONFIG_GLOBAL = empty;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'])
    delete process.env[k];
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
  rmSync(path.join(root, '..', `${path.basename(root)}.gitconfig`), { force: true });
});

describe('starting git for a project folder', () => {
  it('saves the files as the first version, without secrets or what tools make, and says under which name', () => {
    put('src/app.ts', 'export const a = 1;\n');
    put('.env', 'API_KEY=secret\n');
    put('.env.example', 'API_KEY=\n');
    put('config/server.pem', 'key');
    put('node_modules/lib/index.js', 'x');
    put('.friday/config.yaml', 'project: {}\n');
    const r = startGit(root);
    // `.env` is left out by the .gitignore Friday wrote; a key file it does not list, by Friday itself.
    expect(r).toMatchObject({ status: 'started', ignore_written: true, secrets: ['config/server.pem'] });
    expect(r.identity?.name).toBeTruthy();
    expect(r.identity?.email).toContain('@');
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe(DEFAULT_GITIGNORE);
    const saved = git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').sort();
    expect(saved).toEqual(['.env.example', '.friday/config.yaml', '.gitignore', 'src/app.ts']);
    expect(git(['log', '-1', '--format=%s'])).toBe(FIRST_VERSION);
    // The secrets stay on disk, and out of git's list of new files too.
    expect(existsSync(path.join(root, '.env'))).toBe(true);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(r.files).toBe(4);
  });

  it('keeps a .gitignore the folder has, and saves into a repository that has no commit yet', () => {
    git(['init', '-q']);
    put('.gitignore', 'tmp/\n');
    put('a.txt', 'a');
    put('tmp/x.txt', 'x');
    // Its .gitignore does not list .env: Friday leaves it out all the same.
    put('.env', 'KEY=1');
    const r = startGit(root);
    expect(r).toMatchObject({ status: 'saved', ignore_written: false, secrets: ['.env'] });
    expect(git(['status', '--porcelain'])).toBe('');
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('tmp/\n');
    expect(git(['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').sort()).toEqual(['.gitignore', 'a.txt']);
  });

  it('refuses a folder far too big to be the project’s own files, changing nothing, and names the biggest folders', () => {
    put('src/a.ts', 'a'.repeat(10));
    put('vendor/big.bin', 'b'.repeat(5000));
    const r = startGit(root, { files: 100, bytes: 1000 });
    expect(r.status).toBe('too_big');
    expect(r.big[0]).toEqual({ path: 'vendor/', bytes: 5000 });
    expect(r.message).toContain('Nothing was changed');
    expect(existsSync(path.join(root, '.git'))).toBe(false);
    expect(existsSync(path.join(root, '.gitignore'))).toBe(false);
  });

  it('leaves a folder alone that already has a version, or sits inside another project', () => {
    put('a.txt');
    expect(startGit(root).status).toBe('started');
    expect(startGit(root)).toMatchObject({ status: 'already' });
    mkdirSync(path.join(root, 'sub'));
    expect(startGit(path.join(root, 'sub'))).toMatchObject({ status: 'inside_another' });
  });

  it('knows secret files from their templates', () => {
    for (const s of ['.env', 'api/.env.local', 'a/b.pem', '.ssh/id_rsa', 'id_ed25519.pub'])
      expect(isSecretFile(s), s).toBe(true);
    for (const s of ['.env.example', 'api/.env.sample', '.env.template', 'src/env.ts', 'docs/pem.md'])
      expect(isSecretFile(s), s).toBe(false);
  });
});
