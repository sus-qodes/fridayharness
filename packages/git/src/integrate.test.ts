/**
 * Integration plumbing (plan M5c, ADR-0025 §2–§5): merges without a checkout, refs moved only from
 * the value Friday saw, and Friday's own checkout for verifying a merged revision.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  agentIdentity,
  changedBetween,
  checkoutForVerification,
  commitContent,
  commitTree,
  GitRoot,
  isAncestor,
  mergeCommits,
  moveRef,
  resolveCommit,
  treeOf,
} from './index.js';

const ws = useTestWorkspace();

/** A repository with `base`, and branches `one` and `two` that change a.txt and b.txt. */
async function repo() {
  const dir = path.join(ws().root, 'shop');
  mkdirSync(dir, { recursive: true });
  const g = deterministicGit(dir);
  await g.init();
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  await g.commitAll('base');
  const base = (await g.run(['rev-parse', 'HEAD'])).trim();
  const branch = async (name: string, file: string, text: string) => {
    await g.run(['checkout', '-q', '-b', name, base]);
    writeFileSync(path.join(dir, file), text);
    await g.commitAll(`${name} changes ${file}`);
    return (await g.run(['rev-parse', 'HEAD'])).trim();
  };
  const one = await branch('one', 'a.txt', 'one\n');
  const two = await branch('two', 'b.txt', 'two\n');
  const clash = await branch('clash', 'a.txt', 'clash\n');
  await g.run(['checkout', '-q', 'main']);
  return { dir: (await GitRoot.open(dir)).root, g, base, one, two, clash };
}

describe('merging without a checkout', () => {
  it('merges clean changes into a tree and names the files that conflict', async () => {
    const { dir, g, base, one, two, clash } = await repo();
    const clean = await mergeCommits(dir, one, two);
    expect(clean.conflicts).toEqual([]);
    const commit = await commitTree(dir, clean.tree, [one, two], 'merge one and two');
    expect((await g.run(['show', `${commit}:a.txt`])).trim()).toBe('one');
    expect((await g.run(['show', `${commit}:b.txt`])).trim()).toBe('two');
    expect((await g.run(['log', '-1', '--format=%an <%ae>|%cn', commit])).trim()).toBe(
      'Friday <friday@friday.invalid>|Friday',
    );
    expect(await mergeCommits(dir, one, clash)).toMatchObject({ conflicts: ['a.txt'] });
    expect(await isAncestor(dir, base, one)).toBe(true);
    expect(await isAncestor(dir, one, two)).toBe(false);
    // The main checkout was never touched.
    expect(await g.run(['status', '--porcelain'])).toBe('');
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a\n');
  });

  it('moves a ref only from the value Friday saw, and creates one only when it does not exist', async () => {
    const { dir, base, one, two } = await repo();
    const ref = 'refs/heads/friday/goal-test';
    expect(await resolveCommit(dir, ref)).toBeNull();
    await moveRef(dir, ref, base, null);
    await expect(moveRef(dir, ref, one, null)).rejects.toBeInstanceOf(FridayError);
    await moveRef(dir, ref, one, base);
    const stale = await moveRef(dir, ref, two, base).catch((e: FridayError) => e);
    expect((stale as FridayError).code).toBe('COS-8000');
    expect(await resolveCommit(dir, ref)).toBe(one);
  });
});

describe("Friday's commits and checkouts", () => {
  it('reads the exact content of a checkout as a tree, leaving the checkout and its index alone (review F04)', async () => {
    const { dir, g } = await repo();
    const root = await GitRoot.open(dir);
    expect((await root.contentTree()).tree).toBe(await treeOf(dir, 'HEAD'));
    writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    await g.run(['add', 'a.txt']);
    writeFileSync(path.join(dir, 'a.txt'), 'changed again\n');
    writeFileSync(path.join(dir, 'new.txt'), 'untracked\n');
    writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
    mkdirSync(path.join(dir, 'build'), { recursive: true });
    writeFileSync(path.join(dir, 'build', 'out.js'), 'ignored\n');
    const status = await g.run(['status', '--porcelain']);
    const { head, tree } = await root.contentTree();
    expect(head).toBe((await g.run(['rev-parse', 'HEAD'])).trim());
    expect(await g.run(['status', '--porcelain'])).toBe(status);
    expect(await g.run(['show', `${tree}:a.txt`])).toBe('changed again');
    expect(await g.run(['show', `${tree}:new.txt`])).toBe('untracked');
    expect(await g.run(['ls-tree', '-r', '--name-only', tree])).not.toContain('build/');
    expect(await changedBetween(dir, (await treeOf(dir, 'HEAD')) as string, tree)).toEqual([
      '.gitignore',
      'a.txt',
      'new.txt',
    ]);
  });

  it("commits exactly the verified tree in the agent's name, never what changed after it (review F04)", async () => {
    const { dir, g } = await repo();
    writeFileSync(path.join(dir, 'c.txt'), 'new\n');
    const verified = await (await GitRoot.open(dir)).contentTree();
    // A writer changes the checkout after the verified tree was taken.
    writeFileSync(path.join(dir, 'c.txt'), 'BAD unverified\n');
    const head = await commitContent(
      dir,
      verified.tree,
      verified.head,
      'the work\n\nverified as abc',
      agentIdentity('be 1'),
    );
    expect((await g.run(['log', '-1', '--format=%an <%ae>|%s', head])).trim()).toBe(
      'be 1 (via Friday) <be-1@agents.friday.invalid>|the work',
    );
    expect((await g.run(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await treeOf(dir, head)).toBe(verified.tree);
    expect(await g.run(['show', `${head}:c.txt`])).toBe('new');
    // The late change is still in the checkout, uncommitted.
    expect(await g.run(['status', '--porcelain'])).toBe('M c.txt');
    // HEAD is no longer the parent Friday saw: nothing is committed.
    const moved = await commitContent(dir, verified.tree, verified.head, 'again', agentIdentity('be 1')).catch(
      (e: FridayError) => e,
    );
    expect((moved as FridayError).code).toBe('COS-8000');
    expect((await g.run(['rev-parse', 'HEAD'])).trim()).toBe(head);
  });

  it('checks out a revision for verification in its own detached worktree, and reuses it', async () => {
    const { dir, one, two } = await repo();
    const wt = path.join(ws().root, 'wt');
    const first = await checkoutForVerification(dir, wt, 'goal-1', one);
    expect(readFileSync(path.join(first, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n');
    writeFileSync(path.join(first, 'a.txt'), 'left behind by a check\n');
    writeFileSync(path.join(first, 'report.txt'), 'also left behind\n');
    const again = await checkoutForVerification(dir, wt, 'goal-1', two);
    expect(again).toBe(first);
    expect((await (await GitRoot.open(again)).refs()).branch).toBeNull();
    expect(readFileSync(path.join(again, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('a\n');
    expect(readFileSync(path.join(again, 'b.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('two\n');
    expect(existsSync(path.join(again, 'report.txt'))).toBe(false);
    expect((await (await GitRoot.open(again)).contentTree()).tree).toBe(await treeOf(dir, two));
  });
});
