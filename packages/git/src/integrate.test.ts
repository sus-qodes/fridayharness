/**
 * Integration plumbing (plan M5c, ADR-0025 §2–§5): merges without a checkout, refs moved only from
 * the value Friday saw, and Friday's own checkout for verifying a merged revision.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  agentIdentity,
  checkoutForVerification,
  commitAll,
  commitTree,
  GitRoot,
  isAncestor,
  mergeCommits,
  moveRef,
  resolveCommit,
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
  it("commits an agent's work in the agent's name, never the user's", async () => {
    const { dir, g } = await repo();
    writeFileSync(path.join(dir, 'c.txt'), 'new\n');
    const head = await commitAll(dir, 'the work\n\nverified as abc', agentIdentity('be 1'));
    expect((await g.run(['log', '-1', '--format=%an <%ae>|%s', head])).trim()).toBe(
      'be 1 (via Friday) <be-1@agents.friday.invalid>|the work',
    );
    expect(await g.run(['status', '--porcelain'])).toBe('');
  });

  it('checks out a revision for verification in its own detached worktree, and reuses it', async () => {
    const { dir, one, two } = await repo();
    const wt = path.join(ws().root, 'wt');
    const first = await checkoutForVerification(dir, wt, 'goal-1', one);
    expect(readFileSync(path.join(first, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('one\n');
    writeFileSync(path.join(first, 'a.txt'), 'left behind by a check\n');
    const again = await checkoutForVerification(dir, wt, 'goal-1', two);
    expect(again).toBe(first);
    expect((await (await GitRoot.open(again)).refs()).branch).toBeNull();
    expect(readFileSync(path.join(again, 'a.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('a\n');
    expect(readFileSync(path.join(again, 'b.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('two\n');
  });
});
