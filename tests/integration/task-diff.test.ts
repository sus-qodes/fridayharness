import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { readWorkingFile } from '@friday/daemon';
import type { GoalDiff, TaskDiff } from '@friday/protocol';
import { deterministicGit, useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';
import { attachedSession } from '../helpers/ui.js';

/** Task and goal diffs (docs/frontend/PLAN.md §5.4, FD-11, LESSONS UI-25, UI-31). */

const ws = useTestWorkspace();

describe('the task diff', () => {
  it('returns each changed file with both sides, committed and uncommitted', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, dir, wrote } = await attachedSession(td);
    await wrote('README.md', '# test project\n\nchanged\n');
    await deterministicGit(dir, { startEpoch: 1_767_226_000 }).commitAll('agent commit');
    await wrote('new.ts', 'export const x = 1;\n');
    await wrote('data.bin', Buffer.from([0, 1, 2, 3]));
    await wrote('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const d = await td.operator.get<TaskDiff>(td.operator.projectPath(`/tasks/${task.task_id}/diff`));
    expect(d.source).toBe('worktree');
    const readme = d.files.find((f) => f.path === 'README.md');
    expect(readme).toMatchObject({ change: 'modified', committed: true, before: '# test project\n', protected: false });
    expect(readme?.after).toContain('changed');
    expect(d.files.find((f) => f.path === 'new.ts')).toMatchObject({
      change: 'added',
      before: null,
      after: 'export const x = 1;\n',
    });
    expect(d.files.find((f) => f.path === 'data.bin')).toMatchObject({ binary: true, before: null, after: null });
    // Not valid UTF-8: shown as binary, never garbled.
    expect(d.files.find((f) => f.path === 'latin1.txt')).toMatchObject({ binary: true, after: null });
  });

  it('counts lines in stat mode, untracked files as all added', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, wrote } = await attachedSession(td);
    await wrote('README.md', '# changed title\nline two\n');
    await wrote('notes.md', 'a\nb\nc\n');
    const d = await td.operator.get<TaskDiff>(td.operator.projectPath(`/tasks/${task.task_id}/diff?stat=1`));
    const readme = d.files.find((f) => f.path === 'README.md');
    expect(readme).toMatchObject({ added: 2, removed: 1, before: null, after: null });
    expect(d.files.find((f) => f.path === 'notes.md')).toMatchObject({ added: 3, removed: 0 });
  });

  // In the trial a task in the project folder showed "13 files, +3509 −3" for one changed file:
  // Friday's own setup files and the person's edits were counted as the task's (2026-11-18).
  it('counts only what the task changed in the project folder, not what else is there', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, dir, wrote } = await attachedSession(td);
    await wrote('eslint.config.js', 'export default [];\n');
    // What else is in the folder: Friday's harness files and the person's own edit.
    mkdirSync(path.join(dir, '.agents', '.friday', 'harness'), { recursive: true });
    writeFileSync(path.join(dir, '.agents', '.friday', 'harness', 'hook.mjs'), 'x\n'.repeat(3000));
    writeFileSync(path.join(dir, 'AGENTS.md'), '# Friday\n');
    writeFileSync(path.join(dir, 'mine.txt'), 'the person was here\n');
    const d = await td.operator.get<TaskDiff>(td.operator.projectPath(`/tasks/${task.task_id}/diff?stat=1`));
    expect(d.files.map((f) => f.path)).toEqual(['eslint.config.js']);
    expect(d.notes.join(' ')).toMatch(/3 other change\(s\) in the project folder are not this task's/);
  });

  it('never reads through a link in any component, and never shows protected files', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { task, dir, wrote } = await attachedSession(td);
    const outside = path.join(ws().root, 'outside-secrets');
    mkdirSync(path.join(outside, 'deep'), { recursive: true });
    writeFileSync(path.join(outside, 'deep', 'token.txt'), 'operator-token-value');
    // A junction as a parent folder: git lists the files behind it as untracked.
    symlinkSync(outside, path.join(dir, 'linked'), 'junction');
    // Both are the agent's changes: in the project folder a diff lists only those (2026-11-18).
    await wrote('linked/deep/token.txt', 'operator-token-value');
    await wrote('.env', 'STRIPE_KEY=sk_live_abcdefghijklmnop\n');
    const d = await td.operator.get<TaskDiff>(td.operator.projectPath(`/tasks/${task.task_id}/diff`));
    expect(d.files.some((f) => f.path.startsWith('linked'))).toBe(true);
    for (const f of d.files.filter((x) => x.path.startsWith('linked'))) {
      expect(f.after).toBeNull();
      expect(f.link).toBe(true);
    }
    expect(JSON.stringify(d)).not.toContain('operator-token-value');
    const env = d.files.find((f) => f.path === '.env');
    expect(env).toMatchObject({ protected: true, before: null, after: null });
    expect(JSON.stringify(d)).not.toContain('sk_live_abcdefghijklmnop');
  });

  it('reads a working file only when every path component is real', () => {
    const root = path.join(ws().root, 'checkout');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'ok\n');
    const other = path.join(ws().root, 'elsewhere');
    mkdirSync(other, { recursive: true });
    writeFileSync(path.join(other, 'a.ts'), 'secret\n');
    symlinkSync(other, path.join(root, 'via'), 'junction');
    expect(readWorkingFile(root, 'src/a.ts').text).toBe('ok\n');
    expect(readWorkingFile(root, 'via/a.ts')).toMatchObject({ text: null, link: true });
    expect(readWorkingFile(root, '../elsewhere/a.ts')).toMatchObject({ text: null, link: true });
    expect(readWorkingFile(root, 'src/a.ts', 2)).toMatchObject({ text: null, tooLarge: true });
  });
});

describe('the goal diff', () => {
  it('says there is nothing to land before the goal has a branch', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const goal = await td.operator.post<{ goal_id: string }>(td.operator.projectPath('/goals'), {
      request: 'a goal with no work yet',
      plan: false,
    });
    const d = await td.operator.get<GoalDiff>(td.operator.projectPath(`/goals/${goal.goal_id}/diff`));
    expect(d).toMatchObject({ source: 'goal', branch: `friday/goal-${goal.goal_id}`, head: null, files: [] });
    expect(d.notes[0]).toContain('no branch');
  });

  it('lists the goal branch commits and files ahead of the main checkout', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const goal = await td.operator.post<{ goal_id: string }>(td.operator.projectPath('/goals'), {
      request: 'land something',
      plan: false,
    });
    const git = deterministicGit(ws().projectDir, { startEpoch: 1_767_300_000 });
    await git.run(['branch', `friday/goal-${goal.goal_id}`]);
    await git.run(['checkout', '-q', `friday/goal-${goal.goal_id}`]);
    writeFileSync(path.join(ws().projectDir, 'feature.ts'), 'export const feature = true;\n');
    await git.commitAll('add the feature');
    await git.run(['checkout', '-q', '-']);
    const d = await td.operator.get<GoalDiff>(td.operator.projectPath(`/goals/${goal.goal_id}/diff`));
    expect(d.commits_ahead.map((c) => c.subject)).toEqual(['add the feature']);
    expect(d.files).toEqual([
      expect.objectContaining({ path: 'feature.ts', change: 'added', after: 'export const feature = true;\n' }),
    ]);
  });
});
