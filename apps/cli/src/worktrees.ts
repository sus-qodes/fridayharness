import type { WorktreeView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { shortTime, table } from './output.js';

/** Task worktrees from the operator's side (plan M5a, ADR-0023). */

type Listed = WorktreeView & { present: boolean; uncommitted: number | null };

export function registerWorktreeCommands(program: Command, g: () => GlobalOptions): void {
  const worktrees = program
    .command('worktrees')
    .description("task worktrees: one checkout per task, beside Friday's state directory")
    .option('--all', 'include removed worktrees')
    .action(async (o: { all?: boolean }) => {
      const { client } = operator(g());
      const r = await client.get<{ dir: string; worktrees: Listed[] }>(
        `${client.projectPath('/worktrees')}${o.all ? '?all=true' : ''}`,
      );
      out(g(), r, () =>
        r.worktrees.length
          ? `${table(
              ['TASK', 'STATUS', 'BRANCH', 'CHANGES', 'SINCE', 'PATH'],
              r.worktrees.map((w) => [
                w.task_id,
                w.status,
                w.branch,
                w.present ? (w.uncommitted ? `${w.uncommitted} uncommitted` : 'clean') : 'missing',
                shortTime(w.updated_at),
                w.path,
              ]),
              { maxWidth: 80 },
            )}\nWorktrees live in ${r.dir}.`
          : `No task worktrees. They are created for spawn-mode runs, or with "friday task worktree <task>". Location: ${r.dir}`,
      );
    });
  worktrees
    .command('prune')
    .description('remove released worktrees that hold no uncommitted work (their branches stay)')
    .action(async () => {
      const { client } = operator(g());
      const r = await client.post<{ removed: string[]; kept: { path: string; reason: string }[] }>(
        client.projectPath('/worktrees/prune'),
        {},
        { timeoutMs: 300_000 },
      );
      out(g(), r, () =>
        [
          r.removed.length ? `Removed ${r.removed.length}: ${r.removed.join(', ')}` : 'Nothing to remove.',
          ...r.kept.map((k) => `Kept ${k.path}: ${k.reason}`),
        ].join('\n'),
      );
    });

  const task = program.commands.find((c) => c.name() === 'task');
  (task ?? program)
    .command('worktree <task>')
    .description("prepare the task's own worktree and say where to start a session for it")
    .action(async (taskId: string) => {
      const { client } = operator(g());
      const r = await client.post<{ worktree: WorktreeView; warnings: string[]; created: boolean }>(
        client.projectPath(`/tasks/${taskId}/worktree`),
        {},
        { timeoutMs: 600_000 },
      );
      out(g(), r, () =>
        [
          `${r.created ? 'Created' : 'Found'} the worktree of ${taskId} on branch ${r.worktree.branch}:`,
          `  ${r.worktree.path}`,
          'Open it in VS Code (or run Claude Code there); a session started in it works on this task only.',
          ...r.warnings.map((w) => `Warning: ${w}`),
        ].join('\n'),
      );
    });
}
