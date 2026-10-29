/**
 * Recovery plumbing (plan M5d, ADR-0026 §3–§4): a checkout's full state kept under a ref without
 * changing the checkout, and a checkout put back at its last commit.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  commitsSince,
  GitRoot,
  listRefs,
  preserveCommit,
  preservedPrefix,
  resetWorktree,
  snapshotWorktree,
} from './index.js';

const ws = useTestWorkspace();

async function repo() {
  const dir = path.join(ws().root, 'shop');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  const g = deterministicGit(dir);
  await g.init();
  await g.commitAll('base');
  return { dir: (await GitRoot.open(dir)).root, g, base: (await g.run(['rev-parse', 'HEAD'])).trim() };
}

describe('preserving a checkout', () => {
  it('records tracked and untracked changes as a commit, leaving the checkout and its index alone', async () => {
    const { dir, g, base } = await repo();
    expect(await snapshotWorktree(dir, 'nothing to keep')).toBeNull();
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(dir, 'src', 'new.ts'), 'export const n = 1;\n');
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'ignored\n');
    await g.run(['add', 'src/a.ts']); // something staged, to see that the index is kept
    const statusBefore = await g.run(['status', '--porcelain']);

    const commit = (await snapshotWorktree(dir, 'Preserved work of task_x, attempt 1')) as string;
    expect(await g.run(['status', '--porcelain'])).toBe(statusBefore);
    expect((await g.run(['rev-parse', 'HEAD'])).trim()).toBe(base);
    expect((await g.run(['show', `${commit}:src/a.ts`])).trim()).toBe('export const a = 2;');
    expect((await g.run(['show', `${commit}:src/new.ts`])).trim()).toBe('export const n = 1;');
    expect(await g.run(['ls-tree', '-r', '--name-only', commit])).not.toContain('node_modules');
    expect((await g.run(['rev-parse', `${commit}^`])).trim()).toBe(base);

    const prefix = preservedPrefix('task_x');
    const first = await preserveCommit(dir, prefix, 'attempt-1', commit);
    const second = await preserveCommit(dir, prefix, 'attempt-1', commit);
    expect([first, second]).toEqual([`${prefix}attempt-1`, `${prefix}attempt-1-2`]);
    expect(await listRefs(dir, prefix)).toEqual([first, second]);
    expect(await g.run(['branch', '--list'])).not.toContain('preserved');
  });

  it('puts a checkout back at its last commit, keeping ignored files, and counts commits since a base', async () => {
    const { dir, g, base } = await repo();
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 3;\n');
    await g.commitAll('a commit of the attempt');
    expect(await commitsSince(dir, base)).toBe(1);
    expect(await commitsSince(dir, null)).toBeNull();
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'half done\n');
    writeFileSync(path.join(dir, 'src', 'scratch.ts'), 'tmp\n');
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'kept\n');
    await resetWorktree(dir);
    expect(readFileSync(path.join(dir, 'src', 'a.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe('export const a = 3;\n');
    expect(existsSync(path.join(dir, 'src', 'scratch.ts'))).toBe(false);
    expect(existsSync(path.join(dir, 'node_modules', 'dep.js'))).toBe(true);
    // Clean by content (the checkout may hold CRLF where this machine converts line endings).
    expect((await (await GitRoot.open(dir)).identity()).dirty).toBe(false);
  });
});
