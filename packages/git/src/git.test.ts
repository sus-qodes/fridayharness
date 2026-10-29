/**
 * The Git state of an execution root (plan M4a, ADR-0019).
 */
import { mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { deterministicGit, FIXTURE_BASE_EPOCH, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { GitRoot, parseStatusV2, type WatchChange } from './index.js';

const ws = useTestWorkspace();
const same = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

async function repo(name = 'main') {
  const dir = path.join(ws().root, name);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  const g = deterministicGit(dir);
  await g.init();
  writeFileSync(path.join(dir, 'a.txt'), 'alpha\n');
  writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
  await g.commitAll('init');
  return { dir, g };
}

async function refusal(p: Promise<unknown>): Promise<FridayError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FridayError);
    return e as FridayError;
  }
  throw new Error('expected an error');
}

describe('execution roots (M4a exit criterion)', () => {
  it('two execution roots of one project report their own HEAD and dirty state', async () => {
    const { dir, g } = await repo();
    const wtDir = path.join(ws().root, 'wt');
    await g.run(['worktree', 'add', '-q', '-b', 'feature', wtDir]);
    writeFileSync(path.join(wtDir, 'src', 'b.ts'), 'export const b = 2;\n');
    await deterministicGit(wtDir, { startEpoch: FIXTURE_BASE_EPOCH + 100 }).commitAll('feature change');
    writeFileSync(path.join(dir, 'a.txt'), 'alpha edited\n');

    const main = await GitRoot.open(dir);
    const wt = await GitRoot.open(path.join(wtDir, 'src')); // opened from a subfolder
    expect(same(wt.root, realpathSync(wtDir))).toBe(true);
    const [mr, wr] = await Promise.all([main.refs(), wt.refs()]);
    expect(mr).toMatchObject({ linked: false, branch: 'main' });
    expect(wr).toMatchObject({ linked: true, branch: 'feature' });
    expect(same(wr.commonDir, mr.commonDir)).toBe(true);
    expect(wr.head).not.toBe(mr.head);

    const [ms, wst] = await Promise.all([main.status(), wt.status()]);
    expect(ms.entries.map((e) => [e.path, e.kind, e.index, e.worktree])).toEqual([['a.txt', 'changed', '.', 'M']]);
    expect(wst.clean).toBe(true);
    const [mi, wi] = await Promise.all([main.identity(), wt.identity()]);
    expect(mi).toMatchObject({ head: mr.head, dirty: true, files: 1, basis: 'content' });
    expect(mi.version).toBe(`${mr.head}+${mi.hash?.slice(0, 12)}`);
    expect(wi).toEqual({
      head: wr.head,
      dirty: false,
      files: 0,
      paths: [],
      hash: null,
      basis: 'content',
      version: wr.head,
    });

    const trees = await main.worktrees();
    expect(trees.map((t) => t.branch).sort()).toEqual(['feature', 'main']);
  });
});

describe('the dirty-content identity', () => {
  it('follows content, not timestamps, and returns when an edit is reverted', async () => {
    const { dir } = await repo();
    const r = await GitRoot.open(dir);
    const a = path.join(dir, 'a.txt');
    const clean = await r.identity();
    expect(clean).toMatchObject({ dirty: false, hash: null });

    writeFileSync(a, 'one\n');
    const one = await r.identity();
    expect(one.dirty).toBe(true);
    const later = new Date('2030-01-01T00:00:00Z');
    utimesSync(a, later, later);
    expect((await r.identity()).hash).toBe(one.hash);
    writeFileSync(a, 'two\n');
    const two = await r.identity();
    expect(two.hash).not.toBe(one.hash);
    writeFileSync(a, 'one\n');
    expect((await r.identity()).hash).toBe(one.hash);
    writeFileSync(a, 'alpha\n');
    expect(await r.identity()).toEqual(clean);
  });

  it('ignores a file git reports changed only because a line-ending conversion changed its size', async () => {
    const { dir, g } = await repo();
    // A checkout with core.autocrlf=true writes CRLF; an editor writes LF back.
    await g.run(['config', 'core.autocrlf', 'true']);
    const a = path.join(dir, 'a.txt');
    rmSync(a);
    await g.run(['-c', 'core.autocrlf=true', 'checkout', '--', 'a.txt']);
    expect(readFileSync(a, 'utf8')).toBe('alpha\r\n');
    const r = await GitRoot.open(dir);
    const clean = await r.identity();
    expect(clean.dirty).toBe(false);
    writeFileSync(a, 'alpha\n');
    expect((await r.status()).entries.map((e) => [e.path, e.worktree])).toEqual([['a.txt', 'M']]);
    expect(await r.identity()).toEqual(clean);
    writeFileSync(a, 'beta\n');
    expect(await r.identity()).toMatchObject({ dirty: true, files: 1, paths: ['a.txt'] });
  });

  it('covers untracked, deleted, renamed and staged files', async () => {
    const { dir, g } = await repo();
    const r = await GitRoot.open(dir);
    const seen = new Set<string>();
    const step = async () => {
      const id = await r.identity();
      expect(seen.has(id.version)).toBe(false);
      seen.add(id.version);
      return id;
    };
    await step();
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'export {};\n');
    expect((await step()).files).toBe(1);
    rmSync(path.join(dir, 'src', 'b.ts'));
    expect((await r.status()).entries.find((e) => e.path === 'src/b.ts')).toMatchObject({ worktree: 'D' });
    await step();
    await g.run(['add', '-A']);
    await g.run(['mv', 'a.txt', 'renamed.txt']);
    const status = await r.status();
    expect(status.entries.find((e) => e.kind === 'renamed')).toMatchObject({ path: 'renamed.txt', origPath: 'a.txt' });
    expect((await step()).basis).toBe('content');
  });

  it('falls back to size and time beyond its limit, and says so', async () => {
    const { dir } = await repo();
    writeFileSync(path.join(dir, 'x.txt'), 'x\n');
    writeFileSync(path.join(dir, 'y.txt'), 'y\n');
    const id = await (await GitRoot.open(dir, { maxHashedFiles: 1 })).identity();
    expect(id).toMatchObject({ basis: 'approximate', files: 2 });
    expect(id.reason).toMatch(/exceed the limit of 1/);
    expect(id.version).toContain('+~');
  });

  it('works in a repository without commits', async () => {
    const dir = path.join(ws().root, 'empty');
    mkdirSync(dir);
    await deterministicGit(dir).init();
    const r = await GitRoot.open(dir);
    expect(await r.refs()).toMatchObject({ head: null, branch: 'main' });
    expect((await r.identity()).version).toBe('(initial)');
    writeFileSync(path.join(dir, 'first.txt'), '1\n');
    expect((await r.identity()).version).toMatch(/^\(initial\)\+[0-9a-f]{12}$/);
  });
});

describe('reading never writes', () => {
  it('leaves the index untouched even when its stat data is stale', async () => {
    const { dir, g } = await repo();
    const a = path.join(dir, 'a.txt');
    writeFileSync(a, 'alpha\n');
    const later = new Date('2031-01-01T00:00:00Z');
    utimesSync(a, later, later);
    const index = path.join(dir, '.git', 'index');
    const before = readFileSync(index);
    const r = await GitRoot.open(dir);
    expect((await r.status()).clean).toBe(true);
    await r.identity();
    await r.diff();
    expect(readFileSync(index).equals(before)).toBe(true);
    // Plain `git status` refreshes and rewrites it, which is what Friday must not do under an agent.
    await g.run(['status']);
    expect(readFileSync(index).equals(before)).toBe(false);
  });
});

describe('refusals', () => {
  it('names a missing folder and a folder outside any repository', async () => {
    expect((await refusal(GitRoot.open(path.join(ws().root, 'nope')))).message).toMatch(/does not exist/);
    const outside = path.join(ws().root, 'plain');
    mkdirSync(outside);
    const e = await refusal(GitRoot.open(outside));
    expect(e.code).toBe('COS-1000');
    expect(e.message).toMatch(/not inside a git repository/);
  });
});

describe('log and diff', () => {
  it('lists commits for paths without emails, and line counts including renames', async () => {
    const { dir, g } = await repo();
    writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 3;\n');
    await g.commitAll('change b');
    const r = await GitRoot.open(dir);
    const log = await r.log({ paths: ['src/b.ts'], limit: 5 });
    expect(log.map((e) => e.subject)).toEqual(['change b', 'init']);
    expect(JSON.stringify(log)).not.toContain('@');
    expect(await r.log({ paths: ['a.txt'] })).toHaveLength(1);

    writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbeta\ngamma\n');
    await g.run(['mv', 'src/b.ts', 'src/c.ts']);
    const diff = await r.diff();
    expect(diff).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', added: 2, deleted: 0 },
        { path: 'src/c.ts', origPath: 'src/b.ts', added: 0, deleted: 0 },
      ]),
    );
  });
});

describe('watching', () => {
  it('reports edited paths and git state that moved, debounced', async () => {
    const { dir, g } = await repo();
    const r = await GitRoot.open(dir);
    const changes: WatchChange[] = [];
    const stop = await r.watch((c) => changes.push(c), { debounceMs: 100 });
    ws().track({ close: () => stop() });
    const until = async (ok: () => boolean) => {
      const end = Date.now() + 5000;
      while (!ok() && Date.now() < end) await new Promise((res) => setTimeout(res, 50));
      return ok();
    };
    await new Promise((res) => setTimeout(res, 200));
    writeFileSync(path.join(dir, 'src', 'x.ts'), 'export const x = 1;\n');
    expect(await until(() => changes.some((c) => c.paths.includes('src/x.ts')))).toBe(true);
    await g.commitAll('add x');
    expect(await until(() => changes.some((c) => c.git))).toBe(true);
    stop();
  });
});

describe('status parsing', () => {
  it('reads porcelain v2 with branch data, renames and paths with spaces', () => {
    const raw = [
      '# branch.oid 1111111111111111111111111111111111111111',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 .M N... 100644 100644 100644 aaaa bbbb docs/read me.md',
      '2 R. N... 100644 100644 100644 cccc dddd R100 new name.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 e f g conflict.txt',
      '? untracked file.txt',
      '! ignored.log',
      '',
    ].join('\0');
    const s = parseStatusV2(raw);
    expect(s.head).toEqual({
      commit: '1111111111111111111111111111111111111111',
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
    });
    expect(s.entries.map((e) => [e.kind, e.path, e.origPath ?? null])).toEqual([
      ['changed', 'docs/read me.md', null],
      ['renamed', 'new name.ts', 'old name.ts'],
      ['unmerged', 'conflict.txt', null],
      ['untracked', 'untracked file.txt', null],
      ['ignored', 'ignored.log', null],
    ]);
    expect(s.clean).toBe(false);
    expect(parseStatusV2('# branch.oid (initial)\0# branch.head (detached)\0').head).toMatchObject({
      commit: null,
      branch: null,
    });
  });
});
