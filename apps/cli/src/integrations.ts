import type { IntegrationView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { shortTime, table } from './output.js';

/** Integration of verified task branches into goal branches (plan M5c, ADR-0025). */

export function registerIntegrationCommands(program: Command, g: () => GlobalOptions): void {
  program
    .command('integrations')
    .description('verified task work brought into goal branches (friday/goal-<goal>), newest last')
    .option('--goal <goal>', 'one goal only')
    .option('--task <task>', 'one task only')
    .action(async (o: { goal?: string; task?: string }) => {
      const { client } = operator(g());
      const r = await client.get<{ integrations: IntegrationView[] }>(client.projectPath('/integrations'), {
        query: { goal: o.goal, task: o.task },
      });
      out(g(), r, () => {
        if (!r.integrations.length)
          return 'Nothing was integrated yet. Completed tasks of a goal are integrated into its goal branch.';
        const lines = [
          table(
            ['TASK', 'GOAL BRANCH', 'STATUS', 'COMMIT', 'WHEN', 'SUMMARY'],
            r.integrations.map((i) => [
              i.task_id,
              i.branch ?? '',
              i.status,
              i.merged_commit?.slice(0, 12) ?? '',
              shortTime(i.created_at),
              i.summary ?? '',
            ]),
            { maxWidth: 60 },
          ),
        ];
        for (const i of r.integrations.filter((x) => x.conflicts.length)) {
          lines.push(`${i.task_id} conflicts in: ${i.conflicts.join(', ')}`);
        }
        const last = r.integrations.filter((i) => i.status === 'integrated').at(-1);
        if (last?.branch) {
          lines.push(`Land the verified work yourself when ready, for example: git merge ${last.branch}`);
        }
        return lines.join('\n');
      });
    });

  program
    .command('integrate <task>')
    .description(
      'integrate a completed task into its goal branch again: after a failure whose cause is gone, or a conflict you resolved',
    )
    .option(
      '--repaired',
      'you repaired the failed or conflicted integration on the task branch: its tip (keeping the verified work) is checked, then integrated',
    )
    .action(async (taskId: string, o: { repaired?: boolean }) => {
      const { client } = operator(g());
      const r = await client.post<{ integration: IntegrationView }>(
        client.projectPath(`/tasks/${taskId}/integrate`),
        o.repaired ? { repaired: true } : {},
        { timeoutMs: 3_700_000 },
      );
      out(g(), r, () =>
        [
          `${taskId}: ${r.integration.status}${r.integration.merged_commit ? ` as ${r.integration.merged_commit.slice(0, 12)}` : ''} on ${r.integration.branch}`,
          ...(r.integration.summary ? [`  ${r.integration.summary}`] : []),
          ...r.integration.conflicts.map((p) => `  conflict: ${p}`),
        ].join('\n'),
      );
    });
}
