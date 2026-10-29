import type { OperationResult, OperationRunView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { shortTime, table } from './output.js';

/** Operations Friday's gateway runs for agents with stored secrets (plan M6c, ADR-0029). */

/** An operation as `GET /operations` lists it: secret names, never values. */
interface DeclaredOperation {
  name: string;
  source: string;
  risk: string;
  command: string;
  args: string[];
  credentials: Record<string, string>;
}

export function registerOperationCommands(program: Command, g: () => GlobalOptions): void {
  const ops = program
    .command('operations')
    .description('operations the project declares, which Friday runs for agents with secrets they never see')
    .action(async () => {
      const { client } = operator(g());
      const r = await client.get<{
        operations: DeclaredOperation[];
        held: { name: string; source: string; reason: string }[];
      }>(client.projectPath('/operations'));
      out(g(), r, () => {
        const lines: string[] = [];
        if (r.operations.length) {
          lines.push(
            table(
              ['OPERATION', 'RISK', 'RUNS', 'SECRETS', 'SOURCE'],
              r.operations.map((o) => [
                o.name,
                o.risk,
                `${o.command} ${o.args.join(' ')}`,
                Object.entries(o.credentials)
                  .map(([v, n]) => `${v}=${n}`)
                  .join(' '),
                o.source,
              ]),
              { maxWidth: 60 },
            ),
          );
        } else {
          lines.push(
            'No operation is available. Declare them under operations: in .friday/config.yaml or a policy file.',
          );
        }
        for (const h of r.held) lines.push(`NOT AVAILABLE ${h.name} (${h.source}): ${h.reason}`);
        return lines.join('\n');
      });
    });

  ops
    .command('runs')
    .description('recent runs, newest first: outcome, the secrets used (names only) and the approval')
    .option('--task <task>', 'one task only')
    .option('--limit <n>', 'how many', '20')
    .action(async (o: { task?: string; limit: string }) => {
      const { client } = operator(g());
      const r = await client.get<{ runs: OperationRunView[] }>(client.projectPath('/operation-runs'), {
        query: { task: o.task, limit: o.limit },
      });
      out(g(), r, () =>
        r.runs.length
          ? table(
              ['RUN', 'OPERATION', 'TASK', 'STATUS', 'SECRETS', 'APPROVAL', 'WHEN', 'SUMMARY'],
              r.runs.map((x) => [
                x.operation_run_id,
                x.operation,
                x.task_id,
                x.status,
                x.credentials.join(','),
                x.approval_id ?? '',
                shortTime(x.started_at),
                x.summary ?? '',
              ]),
              { maxWidth: 50 },
            )
          : 'No operation has run yet.',
      );
    });

  ops
    .command('show <run>')
    .description('one run and the end of its output (secrets removed)')
    .action(async (id: string) => {
      const { client } = operator(g());
      const r = await client.get<{ run: OperationRunView; result: OperationResult | null }>(
        client.projectPath(`/operation-runs/${id}`),
      );
      out(g(), r, () =>
        [
          `${r.run.operation_run_id} ${r.run.operation} for ${r.run.task_id}: ${r.run.status}${r.run.exit_code !== null ? ` (exit ${r.run.exit_code})` : ''}`,
          `  ran ${r.run.binary} in ${r.run.cwd}`,
          `  secrets: ${r.run.credentials.join(', ') || 'none'}; approval: ${r.run.approval_id ?? 'none needed'}; removed from output: ${r.run.redactions}`,
          ...(r.run.summary ? [`  ${r.run.summary}`] : []),
          ...(r.result?.output ? ['', r.result.output] : []),
        ].join('\n'),
      );
    });
}
