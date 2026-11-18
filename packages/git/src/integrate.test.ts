/**
 * Integration plumbing (plan M5c, ADR-0025 §2–§5): merges without a checkout, refs moved only from
 * the value Friday saw, and Friday's own checkout for verifying a merged revision.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  mergeJoining,
  moveRef,
  resolveCommit,
  runGit,
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

  // Two tasks that each add an entry to a file every feature touches (2026-11-18): git cannot know
  // the order of two additions at one place and calls it a conflict; both are kept, ours first.
  it('keeps both additions where two sides only added at the same place, and nothing else', async () => {
    const dir = path.join(ws().root, 'web');
    mkdirSync(dir, { recursive: true });
    const g = deterministicGit(dir);
    await g.init();
    const files: Record<string, string> = {
      'CHANGELOG.md': '# Changelog\n\n## Older\n- one\n',
      'routes.ts': "import { home } from './home';\n\nexport const routes = [\n  home,\n];\n",
      'price.ts': 'export const price = 1;\n',
      'package-lock.json': '{\n  "a": 1\n}\n',
      'crlf.txt': 'first\r\n',
      'open.txt': 'no newline at the end',
      'gone.txt': 'will be deleted by one side\n',
    };
    const write = (set: Record<string, string | null>) => {
      for (const [name, text] of Object.entries(set)) {
        if (text === null) rmSync(path.join(dir, name), { force: true });
        else writeFileSync(path.join(dir, name), text);
      }
    };
    write(files);
    // The bytes as written, whatever this computer's line-ending setting is.
    writeFileSync(path.join(dir, '.gitattributes'), '* -text\n');
    await g.commitAll('base');
    const base = (await g.run(['rev-parse', 'HEAD'])).trim();
    const side = async (name: string, set: Record<string, string | null>) => {
      await g.run(['checkout', '-q', '-b', name, base]);
      write(set);
      await g.commitAll(name);
      return (await g.run(['rev-parse', 'HEAD'])).trim();
    };
    const wizard = await side('wizard', {
      'CHANGELOG.md': '# Changelog\n\n## Older\n- one\n\n## Wizard\n- the wizard\n',
      'routes.ts':
        "import { home } from './home';\nimport { shared } from './shared';\nimport { wizard } from './wizard';\n\nexport const routes = [\n  home,\n  wizard,\n];\n",
      'price.ts': 'export const price = 2;\n',
      'package-lock.json': '{\n  "a": 1,\n  "w": 1\n}\n',
      'crlf.txt': 'first\r\nwizard\r\n',
      'open.txt': 'no newline at the end\nwizard',
      'both-new.ts': 'export const made = "by the wizard";\n',
      'gone.txt': null,
    });
    const settings = await side('settings', {
      'CHANGELOG.md': '# Changelog\n\n## Older\n- one\n\n## Settings\n- the settings\n',
      'routes.ts':
        "import { home } from './home';\nimport { shared } from './shared';\nimport { settings } from './settings';\n\nexport const routes = [\n  home,\n  settings,\n];\n",
      'price.ts': 'export const price = 3;\n',
      'package-lock.json': '{\n  "a": 1,\n  "s": 1\n}\n',
      'crlf.txt': 'first\r\nsettings\r\n',
      'open.txt': 'no newline at the end\nsettings',
      'both-new.ts': 'export const made = "by the settings";\n',
      'gone.txt': 'changed by the other side\n',
    });
    await g.run(['checkout', '-q', 'main']);
    const root = (await GitRoot.open(dir)).root;

    // Git by itself: every one of them is a conflict.
    expect((await mergeCommits(root, wizard, settings)).conflicts.sort()).toEqual([
      'CHANGELOG.md',
      'both-new.ts',
      'crlf.txt',
      'gone.txt',
      'open.txt',
      'package-lock.json',
      'price.ts',
      'routes.ts',
    ]);
    const merged = await mergeJoining(root, wizard, settings);
    expect(merged.joined?.sort()).toEqual(['CHANGELOG.md', 'crlf.txt', 'routes.ts']);
    // What stays for an agent: a changed line, a generated file, a file both created, a file one
    // side deleted, a file without a final newline.
    expect(merged.conflicts.sort()).toEqual(['both-new.ts', 'gone.txt', 'open.txt', 'package-lock.json', 'price.ts']);
    const commit = await commitTree(root, merged.tree, [wizard, settings], 'joined');
    // The bytes as git holds them: the test helper trims what it reads.
    const show = async (file: string) => (await runGit(root, ['cat-file', 'blob', `${commit}:${file}`])).stdout;
    const log = await show('CHANGELOG.md');
    // Each side's block whole, with the blank line it began with.
    expect(log).toBe('# Changelog\n\n## Older\n- one\n\n## Wizard\n- the wizard\n\n## Settings\n- the settings\n');
    // A line both added alike is there once; each side's own lines are both there, ours first.
    const routes = await show('routes.ts');
    expect(routes.match(/import \{ shared \}/g)).toHaveLength(1);
    expect(routes).toContain("import { wizard } from './wizard';\nimport { settings } from './settings';\n");
    expect(routes).toContain('  home,\n  wizard,\n  settings,\n];');
    expect(await show('crlf.txt')).toBe('first\r\nwizard\r\nsettings\r\n');
    // A real conflict is left as git leaves it, with both versions marked.
    expect(await show('price.ts')).toContain('<<<<<<<');

    // A merge git can do alone is its own result, and so is one where nothing can be joined.
    expect(await mergeJoining(root, base, wizard)).toEqual(await mergeCommits(root, base, wizard));
    const onlyReal = await side('only-real', { 'price.ts': 'export const price = 9;\n' });
    await g.run(['checkout', '-q', 'main']);
    expect(await mergeJoining(root, wizard, onlyReal)).toEqual(await mergeCommits(root, wizard, onlyReal));
    expect(await g.run(['status', '--porcelain'])).toBe('');
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
