import type { RecoveryAssessment, TaskView } from '@friday/protocol';
import { type Command, Option } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { shortTime } from './output.js';

/** Recovering a task's lost or failed attempt (plan M5d, ADR-0026). */

function assessmentLines(a: RecoveryAssessment): string[] {
  const lines = [
    `${a.task_id}  ${a.task_status}${a.waiting_reason ? ` (${a.waiting_reason})` : ''}  attempts: ${a.attempts}`,
  ];
  if (a.run)
    lines.push(
      `  last attempt: ${a.run.run_id} #${a.run.attempt} ${a.run.status}${a.run.outcome ? ` (${a.run.outcome})` : ''}`,
    );
  if (a.harness) {
    const alive = a.harness.process_alive === null ? 'unknown' : a.harness.process_alive ? 'still running' : 'gone';
    lines.push(
      `  session: ${a.harness.agent_key ?? '?'} on ${a.harness.harness_id}, ${a.harness.status}; last heartbeat ${shortTime(a.harness.last_heartbeat_at)}; host process ${alive}`,
    );
    if (a.harness.reconnect_until) lines.push(`  it may come back until ${a.harness.reconnect_until}`);
  }
  if (a.last_activity) lines.push(`  last activity: ${a.last_activity.type} at ${shortTime(a.last_activity.at)}`);
  if (a.worktree) {
    lines.push(
      a.worktree.exists
        ? `  worktree: ${a.worktree.path} on ${a.worktree.branch}; ${a.worktree.commits_since_base ?? '?'} commit(s) since its base, ${a.worktree.uncommitted.length} uncommitted change(s)`
        : `  worktree: ${a.worktree.path} is gone (branch ${a.worktree.branch} remains)`,
    );
  }
  if (a.errors.total)
    lines.push(`  agent errors: ${a.errors.total}; the last one ${a.errors.same_as_last} time(s): ${a.errors.last}`);
  for (const ref of a.preserved) lines.push(`  preserved: ${ref}`);
  lines.push('  options:');
  for (const o of a.options) {
    lines.push(`    ${o.recommended ? '*' : o.available ? ' ' : '-'} ${o.action.replace('_', '-')}: ${o.reason}`);
  }
  lines.push('  (* recommended, - not possible now)');
  return lines;
}

export function registerRecoveryCommands(program: Command, g: () => GlobalOptions): void {
  program
    .command('recover <task>')
    .description('assess a lost or failed attempt, or recover it: reassign, restart, needs-human, cancel')
    .addOption(
      new Option('--action <action>', 'what to do; without it, only the assessment is shown').choices([
        'reassign',
        'restart',
        'needs-human',
        'cancel',
      ]),
    )
    .option('--reason <text>', 'why (recorded with the recovery)')
    .action(async (taskId: string, o: { action?: string; reason?: string }) => {
      const { client } = operator(g());
      if (!o.action) {
        const r = await client.get<{ assessment: RecoveryAssessment }>(client.projectPath(`/tasks/${taskId}/recovery`));
        out(g(), r, () => assessmentLines(r.assessment).join('\n'));
        return;
      }
      const r = await client.post<{ task: TaskView; preserved_ref: string | null; assessment: RecoveryAssessment }>(
        client.projectPath(`/tasks/${taskId}/recover`),
        { action: o.action.replace('-', '_'), ...(o.reason ? { reason: o.reason } : {}) },
        { timeoutMs: 600_000 },
      );
      out(g(), r, () =>
        [
          `${taskId}: ${o.action} done; the task is ${r.task.status}`,
          ...(r.preserved_ref ? [`  the uncommitted work of the last attempt is kept in ${r.preserved_ref}`] : []),
        ].join('\n'),
      );
    });
}
