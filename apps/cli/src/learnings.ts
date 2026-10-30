import type { LearningProposalView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { clip, shortTime, table } from './output.js';

/**
 * What agents proposed for the whole project (ADR-0034 §7). A proposal becomes a learning every
 * agent sees once its task passes verification or a human approves it here; rejecting closes it.
 */

const STATUS_WORDS: Record<LearningProposalView['status'], string> = {
  proposed: 'waiting',
  promoted: 'learned',
  rejected: 'rejected',
};

function renderList(list: LearningProposalView[]): string {
  if (!list.length) return 'No learnings proposed.';
  return table(
    ['LEARNING', 'STATUS', 'KIND', 'FROM', 'TASK', 'WHEN', 'LESSON'],
    list.map((l) => [
      l.proposal_id,
      STATUS_WORDS[l.status],
      l.kind,
      l.proposed_by.agent_key,
      l.task_id,
      shortTime(l.created_at),
      clip(`${l.subject}: ${l.content}`, 70),
    ]),
    { maxWidth: 100 },
  );
}

function renderOne(l: LearningProposalView): string {
  const lines = [
    `${l.proposal_id}  ${STATUS_WORDS[l.status]}  ${l.kind}`,
    `  ${l.subject}: ${l.content}`,
    `  proposed by ${l.proposed_by.agent_key} for ${l.task_id}${l.run_id ? ` (${l.run_id})` : ''}, ${shortTime(l.created_at)}`,
  ];
  if (l.paths.length) lines.push(`  about: ${l.paths.join(', ')}`);
  if (l.memory_id) lines.push(`  project memory: ${l.memory_id}`);
  if (l.decided_by) {
    lines.push(
      `  ${l.status === 'rejected' ? 'rejected' : 'learned'} by ${l.decided_by.id}${l.decision_note ? `: ${l.decision_note}` : ''}`,
    );
  }
  return lines.join('\n');
}

export function registerLearningCommands(program: Command, g: () => GlobalOptions): void {
  program
    .command('learnings')
    .description('lessons agents proposed for the project; waiting ones by default')
    .option('--all', 'also those already learned or rejected')
    .option('--task <task>', 'only those from one task')
    .action(async (o: { all?: boolean; task?: string }) => {
      const { client } = operator(g());
      const q = new URLSearchParams();
      if (!o.all) q.set('status', 'proposed');
      if (o.task) q.set('task', o.task);
      const r = await client.get<{ learnings: LearningProposalView[] }>(
        `${client.projectPath('/learnings')}${q.size ? `?${q}` : ''}`,
      );
      out(g(), r, () =>
        [
          renderList(r.learnings),
          ...(r.learnings.some((l) => l.status === 'proposed')
            ? ['', 'Approve one: friday learning approve <id>   reject: friday learning reject <id>']
            : []),
        ].join('\n'),
      );
    });

  const learning = program.command('learning').description('one proposed lesson: show, approve or reject it');
  learning
    .command('show <id>')
    .description('a proposed lesson and what happened to it')
    .action(async (id: string) => {
      const { client } = operator(g());
      const l = await client.get<LearningProposalView>(client.projectPath(`/learnings/${id}`));
      out(g(), l, () => renderOne(l));
    });
  for (const [verb, help] of [
    ['approve', 'make it a learning every agent sees, with your authority'],
    ['reject', 'close it; it never reaches an agent'],
  ] as const) {
    learning
      .command(`${verb} <id>`)
      .description(help)
      .option('--note <text>', 'why')
      .action(async (id: string, o: { note?: string }) => {
        const { client } = operator(g());
        const l = await client.post<LearningProposalView>(
          client.projectPath(`/learnings/${id}/${verb}`),
          o.note ? { note: o.note } : {},
        );
        out(g(), l, () => renderOne(l));
      });
  }
}
