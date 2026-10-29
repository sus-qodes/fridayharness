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
  lines.push(
    '',
    `Semantic fallback: ${e.semantic_fallback.enabled ? `on, ${e.semantic_fallback.results} result(s)` : 'off'}.`,
  );
  if (e.escalate)
    lines.push('Escalate: nothing in the code relates to this task; a human or the Master Brain should look.');
  for (const n of e.notes) lines.push(`Note: ${n}`);
  return lines.join('\n');
}

export function registerContextCommands(program: Command, g: () => GlobalOptions): void {
  const context = program.command('context').description('the context Friday compiles for tasks and sessions');
  context
    .command('explain <task-or-context>')
    .description('which files, facts and memories a packet holds, and why; a task id compiles a fresh packet first')
    .option('--max-chars <n>', 'budget for a fresh packet', Number)
    .action(async (id: string, o: { maxChars?: number }) => {
      const { client } = operator(g());
      let contextId = id;
      if (!id.startsWith('ctx_')) {
        const packet = await client.post<ContextPacket>(
          client.projectPath('/context/compile'),
          { task_id: id, purpose: 'explain', ...(o.maxChars ? { max_chars: o.maxChars } : {}) },
          { timeoutMs: 120_000 },
        );
        contextId = packet.context_id;
      }
      const r = await client.get<{ packet: ContextPacket; explanation: ContextExplanation }>(
        client.projectPath(`/context/${contextId}/explain`),
      );
      out(g(), r, () => renderExplanation(r.packet, r.explanation));
    });
}
