import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evaluate, type PathContext, sensitiveClassOf, sensitiveInText, sensitivePattern } from './index.js';

/**
 * Task worktrees (plan M5a, ADR-0023): a session in a worktree judges paths against its own
 * checkout, the main checkout's protected files stay protected, and `friday-worktrees` (beside
 * the private `Friday` folder) is not mistaken for it.
 */
let base: string;
let main: string;
let worktree: string;
let ctx: PathContext;

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fr-wt-')));
  main = path.join(base, 'shop');
  worktree = path.join(base, 'friday-worktrees', 'abcd1234', 'task0001');
  for (const d of [
    `${main}/.friday/run`,
    `${main}/.git/worktrees/task0001`,
    `${main}/backend/src`,
    `${worktree}/backend/src`,
    `${worktree}/.friday`,
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(path.join(main, '.friday/run/daemon.json'), '{}\n');
  writeFileSync(path.join(main, '.friday/project.db'), '');
  writeFileSync(path.join(worktree, 'backend/src/pay.ts'), 'export {};\n');
  writeFileSync(path.join(worktree, '.friday/config.yaml'), 'project: {}\n');
  ctx = {
    projectRoot: worktree,
    mainRoot: main,
    stateDir: path.join(base, 'Friday'),
    windows: process.platform === 'win32',
  };
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('the private folder is matched as a whole segment', () => {
  it.each([
    ['C:\\Users\\a\\AppData\\Local\\Friday\\projects\\p\\operator.token', true],
    ['C:\\Users\\a\\AppData\\Local\\Friday', true],
    ['%LOCALAPPDATA%\\Friday\\projects', true],
    ['Get-Content $env:LOCALAPPDATA\\Friday\\projects\\p\\agent.json', true],
    ['cat ~/.local/state/friday/projects/p/daemon.json', true],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell expansion.
    ['ls ${XDG_STATE_HOME:-~/.local/state}/friday/projects', true],
    ['C:\\Users\\a\\AppData\\Local\\friday-worktrees\\abcd1234\\task0001\\src\\a.ts', false],
    ['ls $env:LOCALAPPDATA\\friday-worktrees', false],
    ['cat ~/.local/state/friday-worktrees/k/t/src/a.ts', false],
    ['ls $XDG_STATE_HOME/friday-worktrees/k', false],
  ])('%s → private: %s', (text, isPrivate) => {
    expect(sensitiveInText(text, ctx)?.class === 'friday.private').toBe(isPrivate);
    expect(sensitivePattern(text, ctx)?.class === 'friday.private').toBe(isPrivate);
  });
});

describe('a session in a task worktree', () => {
  it('may read and write its own checkout, and never the main checkout protected files', () => {
    expect(sensitiveClassOf(path.join(worktree, 'backend/src/pay.ts'), ctx, 'write')).toBeNull();
    expect(sensitiveClassOf('backend/src/pay.ts', ctx, 'write')).toBeNull();
    expect(sensitiveClassOf(path.join(main, '.friday/run/daemon.json'), ctx, 'read')?.class).toBe('friday.runtime');
    expect(sensitiveClassOf(path.join(main, '.friday/project.db'), ctx, 'read')?.class).toBe('friday.runtime');
    expect(sensitiveClassOf(path.join(main, '.git/worktrees/task0001/HEAD'), ctx, 'read')?.class).toBe('git.internal');
    // The worktree's own tracked Friday config is host configuration there too.
    expect(sensitiveClassOf('.friday/config.yaml', ctx, 'write')?.class).toBe('host.config');
  });

  it('writes inside its scope, but not into the main checkout', () => {
    const task = {
      task_id: 'task_1',
      status: 'RUNNING',
      scope: { write: ['backend/**'], read: [] },
      kind: 'implementation',
    };
    const write = (p: string) => evaluate({ action: { tool: 'Edit', kind: 'write', paths: [p] }, ctx, task });
    expect(write(path.join(worktree, 'backend/src/pay.ts'))).toMatchObject({ decision: 'allow' });
    expect(write(path.join(main, 'backend/src/pay.ts'))).toMatchObject({
      decision: 'deny',
      rule: 'write.outside_project',
    });
  });
});
