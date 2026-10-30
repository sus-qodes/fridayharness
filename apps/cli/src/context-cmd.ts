import type { ContextExplanation, ContextPacket } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';

/** Why a context packet holds what it holds (plan M4d, ADR-0022, Part 12 §13). */

export function renderExplanation(packet: ContextPacket, e: ContextExplanation): string {
  const files = e.included.filter((i) => i.section === 'code.related');
  const others = e.included.filter((i) => i.section !== 'code.related');
  const lines = [
    `Context ${packet.context_id}${packet.task_id ? ` for ${packet.task_id}` : ''} (${packet.purpose ?? 'request'}), source version ${e.source_version ?? 'unknown'}${packet.staleness.is_stale ? ` — STALE: ${packet.staleness.reason}` : ''}`,
    `Budget: ${e.budget.used_chars} of ${e.budget.chars} characters, ${e.budget.sources} of at most ${e.budget.max_sources} sources; compiled in ${e.timings_ms.total ?? '?'} ms.`,
    '',
    files.length ? `Files (${files.length}):` : 'Files: none related through the code graph.',
    ...files.map((f, i) => `  ${i + 1}. ${f.source_id}\n     reason: ${f.reason}\n     rule: ${f.rule}`),
    '',
    'Other sources:',
    ...others.map(
      (o) =>
        `  - ${o.section}${o.source_id !== o.section ? ` ${o.source_id}` : ''}: ${o.reason} (${o.protected ? 'protected' : o.rule})`,
    ),
  ];
  if (e.cut_by_budget.length) {
    lines.push(
      '',
      `Cut by the budget (${e.cut_by_budget.length}):`,
      ...e.cut_by_budget.map(
        (c) => `  - ${c.section} ${c.source_id}: ${c.reason} (priority ${c.priority}, ~${c.tokens} tokens)`,
      ),
    );
  }
  if (e.withheld_by_permission)
    lines.push('', `Withheld by permission: ${e.withheld_by_permission} source(s), not named.`);
  if (e.unsupported_edges.length) {
    lines.push(
      '',
      'Not resolved in the code graph (reported, not followed):',
      ...e.unsupported_edges.map((u) => `  - ${u.from}: ${u.specifier ?? '(computed)'} — ${u.reason}`),
    );
  }
  if (e.memory_conflicts.length) {
    lines.push(
      '',
      'Memory conflicts:',
      ...e.memory_conflicts.map(
        (m) => `  - ${m.memory_id} contradicts ${m.contradicts.join(', ')}; precedence keeps ${m.kept}`,
      ),
    );
  }
  lines.push('');
  if (e.escalate)
    lines.push('Escalate: nothing in the code relates to this task; a human or the Master Brain should look.');
  for (const n of e.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

export function registerContextCommands(program: Command, g: () => GlobalOptions): void {
  const context = program.command('context').description('the context Friday compiles for tasks and sessions');
  context
    .command('explain <task-or-context>')
    .description(
      'which files, facts and memories a packet holds, and why; for a task, the newest packet its agent was given (a preview compiled for you when there is none, or with --fresh)',
    )
    .option('--max-chars <n>', 'budget for a fresh packet', Number)
    .option('--fresh', 'compile a preview now, as you may read, instead of the packet the agent was given')
    .option(
      '--files',
      "the files the task may change and the code related to them, compiled now as an agent's scope_files request is answered (the first packet names no files)",
    )
    .action(async (id: string, o: { maxChars?: number; fresh?: boolean; files?: boolean }) => {
      const { client } = operator(g());
      let contextId = id;
      let header = '';
      if (!id.startsWith('ctx_')) {
        // What the task's agent was given, not what a human may read (LESSONS D-49).
        const delivered =
          o.fresh || o.files
            ? null
            : await client.get<{ context_id: string | null; agent_key: string | null }>(
                client.projectPath(`/tasks/${id}/delivered-context`),
              );
        if (delivered?.context_id) {
          contextId = delivered.context_id;
          header = `Delivered to ${delivered.agent_key ?? 'its agent'}: the newest packet Friday gave this task's agent.`;
        } else {
          const packet = await client.post<ContextPacket>(
            client.projectPath('/context/compile'),
            {
              task_id: id,
              purpose: o.files ? 'explain:scope_files' : 'explain',
              ...(o.maxChars ? { max_chars: o.maxChars } : {}),
              ...(o.files ? { request: { kind: 'scope_files' } } : {}),
            },
            { timeoutMs: 120_000 },
          );
          contextId = packet.context_id;
          header = o.files
            ? "The files this task may change and the code related to them, as an agent's scope_files request is answered now, for you, a human; an agent may be shown less (its own grants)."
            : `A preview compiled for you, a human, now${o.fresh ? '' : ': no agent has been given a packet for this task yet'}; an agent may be shown less (its own memories and grants).`;
        }
      }
      const r = await client.get<{ packet: ContextPacket; explanation: ContextExplanation }>(
        client.projectPath(`/context/${contextId}/explain`),
      );
      out(g(), r, () => [header, renderExplanation(r.packet, r.explanation)].filter(Boolean).join('\n'));
    });
}
