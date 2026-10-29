/**
 * Task worktrees (plan M5a, ADR-0023).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { allocateWorktree, GitRoot, removeWorktree, rootKey, worktreesDir } from './index.js';

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
