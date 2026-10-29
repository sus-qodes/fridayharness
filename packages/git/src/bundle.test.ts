/**
 * The code a backup holds (review F16): Friday's refs in a bundle with their whole history, put
 * back into another repository without losing anything there, and a recorded state written back
 * into a clean checkout as the uncommitted changes it was.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  applyState,
  checkedOutBranches,
  GitRoot,
  parentOf,
  placeRef,
  readBundle,
  snapshotWorktree,
  unbundle,
  writeBundle,
} from './index.js';

const ws = useTestWorkspace();
const text = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

async function repo(name: string) {
  const dir = path.join(ws().root, name);
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const g = deterministicGit(dir);
  await g.init();
  await g.commitAll('base');
  return { dir: (await GitRoot.open(dir)).root, g };
}

const head = async (g: ReturnType<typeof deterministicGit>, rev = 'HEAD') => (await g.run(['rev-parse', rev])).trim();

describe('a code bundle', () => {
  it('carries the named refs with their history into a repository that never had them', async () => {
    const { dir, g } = await repo('a');
    await g.run(['checkout', '-q', '-b', 'friday/task_x']);
    writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 1;\n');
    await g.commitAll('work of the task');
    const work = await head(g);
    await g.run(['update-ref', 'refs/friday/preserved/task_x/attempt-1', work]);
    const file = path.join(ws().root, 'code.bundle');
    const refs = await writeBundle(dir, file, ['refs/heads/friday/task_x', 'refs/friday/preserved/task_x/attempt-1']);
    expect(refs).toEqual([
      { ref: 'refs/heads/friday/task_x', commit: work },
      { ref: 'refs/friday/preserved/task_x/attempt-1', commit: work },
    ]);

    // An unrelated empty repository: the bundle needs nothing from it.
    const other = path.join(ws().root, 'b');
    mkdirSync(other);
    const o = deterministicGit(other);
    await o.init();
    expect(await readBundle(other, file)).toEqual(refs);
    await unbundle(other, file);
    expect(await o.run(['for-each-ref'])).toBe('');
    expect((await o.run(['show', `${work}:src/b.ts`])).trim()).toBe('export const b = 1;');
  });

  it('is refused when it is damaged, or needs commits the repository lacks', async () => {
    const { dir, g } = await repo('a');
    const base = await head(g);
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    await g.commitAll('second');
    const other = path.join(ws().root, 'b');
    mkdirSync(other);
    await deterministicGit(other).init();

    const file = path.join(ws().root, 'code.bundle');
    await writeBundle(dir, file, ['HEAD']);
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, bytes.length - 20));
    await expect(unbundle(other, file)).rejects.toThrow(/is damaged/);

    // A bundle made without the history before `base`, which the other repository does not have.
    const thin = path.join(ws().root, 'thin.bundle');
    await g.run(['bundle', 'create', '-q', thin, `${base}..HEAD`]);
    await expect(readBundle(other, thin)).rejects.toThrow(/cannot be used here/);
  });
});

describe('placing a backup’s refs', () => {
  it('creates, advances or keeps, and never moves a ref back or loses a commit', async () => {
    const { dir, g } = await repo('a');
    const base = await head(g);
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    await g.commitAll('second');
    const second = await head(g);
    await g.run(['reset', '-q', '--hard', base]);
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 3;\n');
    await g.commitAll('diverged');
    const diverged = await head(g);
    const opts = { checkedOut: new Set<string>(), stamp: 's1' };

    expect(await placeRef(dir, 'refs/heads/friday/new', second, opts)).toEqual({
      ref: 'refs/heads/friday/new',
      commit: second,
      outcome: 'created',
    });
    expect((await placeRef(dir, 'refs/heads/friday/new', second, opts)).outcome).toBe('unchanged');

    await g.run(['update-ref', 'refs/heads/friday/behind', base]);
    expect((await placeRef(dir, 'refs/heads/friday/behind', second, opts)).outcome).toBe('advanced');
    expect(await head(g, 'refs/heads/friday/behind')).toBe(second);

    // The ref here is newer than the backup's: it stays, and already holds the backup's commit.
    await g.run(['update-ref', 'refs/heads/friday/ahead', second]);
    expect(await placeRef(dir, 'refs/heads/friday/ahead', base, opts)).toEqual({
      ref: 'refs/heads/friday/ahead',
      commit: base,
      outcome: 'kept',
      here: second,
    });

    // Diverged: the ref stays, and the backup's commit is kept beside it.
    await g.run(['update-ref', 'refs/heads/friday/split', diverged]);
    const split = await placeRef(dir, 'refs/heads/friday/split', second, opts);
    expect(split).toMatchObject({
      outcome: 'kept',
      here: diverged,
      stored_at: 'refs/friday/restored/kept/s1/heads/friday/split',
    });
    expect(await head(g, 'refs/heads/friday/split')).toBe(diverged);
    expect(await head(g, split.stored_at)).toBe(second);
  });

  it('never moves a branch a checkout has, and writes only Friday’s refs', async () => {
    const { dir, g } = await repo('a');
    const base = await head(g);
    await g.run(['checkout', '-q', '-b', 'friday/task_x']);
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    await g.commitAll('second');
    const second = await head(g);
    await g.run(['reset', '-q', '--hard', base]);
    const checkedOut = await checkedOutBranches(dir);
    expect(checkedOut.has('friday/task_x')).toBe(true);

    const r = await placeRef(dir, 'refs/heads/friday/task_x', second, { checkedOut, stamp: 's2' });
    expect(r).toMatchObject({
      outcome: 'kept',
      here: base,
      stored_at: 'refs/friday/restored/kept/s2/heads/friday/task_x',
    });
    expect(await head(g)).toBe(base);
    expect(await g.run(['status', '--porcelain'])).toBe('');

    await expect(placeRef(dir, 'refs/heads/main', second, { checkedOut, stamp: 's2' })).rejects.toThrow(
      /not one of Friday's refs/,
    );
    await expect(placeRef(dir, 'refs/tags/v1', second, { checkedOut, stamp: 's2' })).rejects.toThrow(
      /not one of Friday's refs/,
    );
  });
});

describe('writing a recorded state back', () => {
  it('gives a clean checkout the recorded uncommitted changes, its index at HEAD', async () => {
    const { dir, g } = await repo('a');
    writeFileSync(path.join(dir, 'src', 'gone.ts'), 'export const gone = 1;\n');
    await g.commitAll('with a file to delete');
    const base = await head(g);
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const n = 1;\n');
    await g.run(['rm', '-q', 'src/gone.ts']);
    const state = (await snapshotWorktree(dir, 'recorded')) as string;
    expect(await parentOf(dir, state)).toBe(base);
    expect(await parentOf(dir, base)).not.toBeNull();

    // A clean checkout of the same commit elsewhere.
    const copy = path.join(ws().root, 'copy');
    await g.run(['worktree', 'add', '-q', '--detach', copy, base]);
    await applyState(copy, state);
    const c = deterministicGit(copy);
    expect(text(path.join(copy, 'src', 'a.ts'))).toBe('export const a = 2;\n');
    expect(text(path.join(copy, 'src', 'new.ts'))).toBe('export const n = 1;\n');
    expect(existsSync(path.join(copy, 'src', 'gone.ts'))).toBe(false);
    expect(await head(c)).toBe(base);
    expect(await c.run(['diff', '--cached', '--name-only'])).toBe('');
    // Lines of `status --porcelain`: index state, then worktree state (nothing staged).
    const status = (await c.run(['status', '--porcelain'], {})).split('\n').map((l) => l.trim());
    expect(status.sort()).toEqual(['?? src/new.ts', 'D src/gone.ts', 'M src/a.ts']);
    expect(await c.run(['diff', '--name-only'])).toContain('src/a.ts');
  });
});
