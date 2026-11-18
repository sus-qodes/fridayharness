/**
 * Task worktrees (plan M5a, ADR-0023).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { allocateWorktree, GitRoot, refreshWorktree, removeWorktree, rootKey, worktreesDir } from './index.js';

const ws = useTestWorkspace();

async function project() {
  const dir = path.join(ws().root, 'shop');
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{}}\n');
  const g = deterministicGit(dir);
  await g.init();
  await g.commitAll('init');
  const main = await GitRoot.open(dir);
  return { dir: main.root, g, wt: path.join(ws().root, 'friday-worktrees') };
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

describe('where worktrees live', () => {
  it('sits beside the state directory unless FRIDAY_WORKTREES_DIR says otherwise', () => {
    expect(worktreesDir({ FRIDAY_WORKTREES_DIR: '/x/wt' })).toBe(path.resolve('/x/wt'));
    expect(worktreesDir({ FRIDAY_STATE_DIR: '/tmp/ws/state' })).toBe(
      path.join(path.resolve('/tmp/ws'), 'friday-worktrees'),
    );
    expect(rootKey('C:/demo/shop')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('allocation', () => {
  it('creates a worktree on its own branch, and reuses it instead of creating another', async () => {
    const { dir, wt } = await project();
    const first = await allocateWorktree({
      mainRoot: dir,
      worktreesDir: wt,
      taskId: 'task_0000000000000000000000abcd',
      project: { project_id: 'proj_x', name: 'shop' },
    });
    expect(first).toMatchObject({
      created: true,
      reused_branch: false,
      branch: 'friday/task_0000000000000000000000abcd',
    });
    expect(first.path).toBe(path.join(wt, rootKey(dir), '0000abcd'));
    // Worktrees check out with the user's git config (core.autocrlf on Windows): compare the text, not line endings.
    expect(readFileSync(path.join(first.path, 'src', 'a.ts'), 'utf8').replace(/\r\n/g, '\n')).toBe(
      'export const a = 1;\n',
    );
    expect(JSON.parse(readFileSync(path.join(wt, rootKey(dir), 'project.json'), 'utf8'))).toMatchObject({
      name: 'shop',
    });
    const again = await allocateWorktree({
      mainRoot: dir,
      worktreesDir: wt,
      taskId: 'task_0000000000000000000000abcd',
    });
    expect(again).toMatchObject({ created: false, path: first.path, base_commit: first.base_commit });
    const wroot = await GitRoot.open(first.path);
    expect(await wroot.refs()).toMatchObject({ linked: true, branch: 'friday/task_0000000000000000000000abcd' });
  });

  it('checks out the existing branch again when the folder was lost: no duplicate branch', async () => {
    const { dir, g, wt } = await project();
    const taskId = 'task_000000000000000000000lost1';
    const first = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId });
    writeFileSync(path.join(first.path, 'src', 'b.ts'), 'export const b = 2;\n');
    await deterministicGit(first.path).commitAll('work on the task');
    const work = await deterministicGit(first.path).headSha();
    rmSync(first.path, { recursive: true, force: true });
    const again = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId });
    expect(again).toMatchObject({ created: true, reused_branch: true, base_commit: work });
    expect(existsSync(path.join(again.path, 'src', 'b.ts'))).toBe(true);
    const branches = (await g.run(['branch', '--list', 'friday/*'])).split('\n').filter(Boolean);
    expect(branches).toHaveLength(1);
  });

  it('leaves a folder that is not its worktree alone', async () => {
    const { dir, wt } = await project();
    const taskId = 'task_00000000000000000000000busy';
    const occupied = path.join(wt, rootKey(dir), taskId.slice(-8));
    mkdirSync(occupied, { recursive: true });
    writeFileSync(path.join(occupied, 'notes.txt'), 'mine\n');
    expect((await refusal(allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId }))).message).toMatch(
      /not a worktree of this project/,
    );
    expect(readFileSync(path.join(occupied, 'notes.txt'), 'utf8')).toBe('mine\n');
  });

  it('copies per-developer settings, and warns when the harness files are not committed', async () => {
    const { dir, wt } = await project();
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{"enabledMcpjsonServers":["friday"]}\n');
    writeFileSync(path.join(dir, '.git', 'info', 'exclude'), '/.claude/settings.local.json\n');
    writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"friday":{}}}\n');
    const a = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId: 'task_0000000000000000000000cfg1' });
    expect(readFileSync(path.join(a.path, '.claude', 'settings.local.json'), 'utf8')).toContain('friday');
    expect(a.warnings.join(' ')).toMatch(/uncommitted changes \(\.mcp\.json\)/);
    expect((await (await GitRoot.open(a.path)).status()).clean).toBe(true);
  });
});

describe('refreshing a reused worktree', () => {
  async function changedGoal() {
    const p = await project();
    const taskId = 'task_0000000000000000000refresh';
    const alloc = await allocateWorktree({ mainRoot: p.dir, worktreesDir: p.wt, taskId });
    writeFileSync(path.join(p.dir, 'checks.ts'), 'export const check = 2;\n');
    await p.g.commitAll('correct the independent check');
    return { ...p, alloc, taskId, goalHead: await p.g.headSha() };
  }

  it('brings new goal commits into a clean worktree and is idempotent', async () => {
    const { dir, alloc, taskId, goalHead } = await changedGoal();
    const refreshed = await refreshWorktree({ dir: alloc.path, goalHead, taskId });
    expect(refreshed).toMatchObject({
      from: alloc.base_commit,
      head: goalHead,
      goal_head: goalHead,
      commits: [goalHead],
      conflicts: [],
    });
    expect(readFileSync(path.join(alloc.path, 'checks.ts'), 'utf8').trim()).toBe('export const check = 2;');
    expect((await (await GitRoot.open(alloc.path)).identity()).dirty).toBe(false);
    expect((await refreshWorktree({ dir: alloc.path, goalHead, taskId })).commits).toEqual([]);
    expect(await deterministicGit(dir).headSha()).toBe(goalHead);
  });

  it('keeps committed task work and restores staged, deleted and untracked edits as uncommitted', async () => {
    const { alloc, taskId, goalHead } = await changedGoal();
    const git = deterministicGit(alloc.path);
    writeFileSync(path.join(alloc.path, 'committed.ts'), 'committed task work\n');
    await git.commitAll('task progress');
    writeFileSync(path.join(alloc.path, 'src', 'a.ts'), 'export const a = 9;\n');
    await git.run(['add', 'src/a.ts']);
    rmSync(path.join(alloc.path, '.mcp.json'));
    writeFileSync(path.join(alloc.path, 'new.ts'), 'untracked work\n');
    const refreshed = await refreshWorktree({ dir: alloc.path, goalHead, taskId });
    expect(refreshed.conflicts).toEqual([]);
    expect(refreshed.preserved_ref).toMatch(/^refs\/friday\/preserved\//);
    expect(readFileSync(path.join(alloc.path, 'checks.ts'), 'utf8').trim()).toBe('export const check = 2;');
    expect(readFileSync(path.join(alloc.path, 'committed.ts'), 'utf8').trim()).toBe('committed task work');
    expect(readFileSync(path.join(alloc.path, 'src', 'a.ts'), 'utf8').trim()).toBe('export const a = 9;');
    expect(readFileSync(path.join(alloc.path, 'new.ts'), 'utf8').trim()).toBe('untracked work');
    expect(existsSync(path.join(alloc.path, '.mcp.json'))).toBe(false);
    expect(await git.run(['diff', '--cached', '--name-only'])).toBe('');
    expect(await git.run(['show', 'HEAD:src/a.ts'])).toContain('a = 1');
    expect(await git.run(['status', '--porcelain'])).toContain('?? new.ts');
    expect((await (await GitRoot.open(alloc.path)).changesSince(goalHead)).changes.map((c) => c.path)).not.toContain(
      'checks.ts',
    );
  });

  // A collision is merged by Friday as far as git can (2026-11-18): the folder gets the goal's work,
  // the task's own work stays, and the file git cannot merge holds both versions marked. The agent
  // finishes it by editing; the branch descends from the goal revision, so it integrates after.
  it.each([false, true])('merges a collision into the folder with both versions marked (dirty=%s)', async (dirty) => {
    const { dir, g, wt } = await project();
    const taskId = 'task_0000000000000000000conflict';
    const alloc = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId });
    const taskGit = deterministicGit(alloc.path);
    writeFileSync(path.join(alloc.path, 'src', 'a.ts'), 'export const a = 3;\n');
    writeFileSync(path.join(alloc.path, 'mine.ts'), 'export const mine = true;\n');
    if (!dirty) await taskGit.commitAll('task changes a');
    const head = await taskGit.headSha();
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    writeFileSync(path.join(dir, 'theirs.ts'), 'export const theirs = true;\n');
    await g.commitAll('goal changes a');
    const goalHead = await g.headSha();
    const refreshed = await refreshWorktree({ dir: alloc.path, goalHead, taskId });
    expect(refreshed.marked).toBe(true);
    expect(refreshed.conflicts).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        task: expect.stringContaining('+export const a = 3;'),
        goal: expect.stringContaining('+export const a = 2;'),
      }),
    ]);
    // Both versions, the task's first; the rest of both sides' work is in the folder as it was made.
    const text = readFileSync(path.join(alloc.path, 'src', 'a.ts'), 'utf8').replace(/\r/g, '');
    expect(text).toMatch(/^<<<<<<< .*\nexport const a = 3;\n=======\nexport const a = 2;\n>>>>>>> .*\n$/);
    expect(readFileSync(path.join(alloc.path, 'mine.ts'), 'utf8').trim()).toBe('export const mine = true;');
    expect(readFileSync(path.join(alloc.path, 'theirs.ts'), 'utf8').trim()).toBe('export const theirs = true;');
    // The branch descends from the goal revision and from the task's work; nothing is uncommitted.
    const now = await taskGit.headSha();
    expect(now).toBe(refreshed.head);
    expect(await taskGit.run(['merge-base', '--is-ancestor', goalHead, now]).then(() => true)).toBe(true);
    expect(await taskGit.run(['merge-base', '--is-ancestor', head, now]).then(() => true)).toBe(true);
    expect((await (await GitRoot.open(alloc.path)).identity()).dirty).toBe(false);
    // What the agent had not committed is kept as it was, under a name of its own.
    if (dirty) {
      expect(refreshed.preserved_ref).toMatch(/^refs\/friday\/preserved\//);
      expect(await taskGit.run(['show', `${refreshed.preserved_ref}:src/a.ts`])).toContain('a = 3');
    }
    // Asked again, nothing is left to bring: the agent's edits are not merged a second time.
    writeFileSync(path.join(alloc.path, 'src', 'a.ts'), 'export const a = 5;\n');
    expect(await refreshWorktree({ dir: alloc.path, goalHead, taskId })).toMatchObject({ commits: [], conflicts: [] });
    expect(readFileSync(path.join(alloc.path, 'src', 'a.ts'), 'utf8').trim()).toBe('export const a = 5;');
  });

  it('keeps both sides where each only added lines to the same file, and asks nothing of the agent', async () => {
    const { dir, g, wt } = await project();
    writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n- first\n');
    writeFileSync(path.join(dir, '.gitattributes'), '* -text\n');
    await g.commitAll('a changelog');
    const taskId = 'task_000000000000000000000joined';
    const alloc = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId });
    writeFileSync(path.join(alloc.path, 'CHANGELOG.md'), '# Changelog\n\n- first\n- the task\n');
    writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n- first\n- another task\n');
    await g.commitAll('another task adds its line');
    const refreshed = await refreshWorktree({ dir: alloc.path, goalHead: await g.headSha(), taskId });
    expect(refreshed).toMatchObject({ conflicts: [], joined: ['CHANGELOG.md'] });
    expect(refreshed.marked ?? false).toBe(false);
    expect(readFileSync(path.join(alloc.path, 'CHANGELOG.md'), 'utf8')).toBe(
      '# Changelog\n\n- first\n- the task\n- another task\n',
    );
  });
});

describe('removal and hygiene', () => {
  it('never removes uncommitted work, and leaves the main checkout clean', async () => {
    const { dir, g, wt } = await project();
    const a = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId: 'task_00000000000000000000000ww1' });
    const b = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId: 'task_00000000000000000000000ww2' });
    expect(await g.run(['status', '--porcelain'])).toBe('');
    writeFileSync(path.join(a.path, 'src', 'a.ts'), 'export const a = 2;\n');
    expect((await refusal(removeWorktree(dir, a.path))).code).toBe('COS-8001');
    expect(existsSync(path.join(a.path, 'src', 'a.ts'))).toBe(true);
    await removeWorktree(dir, b.path);
    expect(existsSync(b.path)).toBe(false);
    expect((await g.run(['branch', '--list', 'friday/task_00000000000000000000000ww2'])).trim()).not.toBe('');
  });

  it('removes a worktree whose only difference is a line-ending conversion', async () => {
    const { dir, g, wt } = await project();
    await g.run(['config', 'core.autocrlf', 'true']); // checkouts write CRLF, as on many Windows machines
    const c = await allocateWorktree({ mainRoot: dir, worktreesDir: wt, taskId: 'task_00000000000000000000000ww3' });
    const file = path.join(c.path, 'src', 'a.ts');
    expect(readFileSync(file, 'utf8')).toBe('export const a = 1;\r\n');
    writeFileSync(file, 'export const a = 1;\n'); // an editor writes LF back: git reports a change
    expect((await (await GitRoot.open(c.path)).status()).clean).toBe(false);
    await removeWorktree(dir, c.path);
    expect(existsSync(c.path)).toBe(false);
  });
});
