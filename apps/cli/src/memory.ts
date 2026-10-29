import type { Command } from 'commander';
import { type GlobalOptions, operator, out, UsageError } from './context.js';
import { clip, shortTime, table } from './output.js';

/** Scoped project memory from the operator's side (plan M4c, ADR-0021). */

interface Memory {
  memory_id: string;
  scope_type: string;
  scope_id: string;
  kind: string;
  subject: string;
  content: string;
  tags: string[];
  source: { kind: string; id: string };
  authority: string;
  verification_status: string;
  status: string;
  supersedes: string | null;
  superseded_by: string | null;
  contradicts: string[];
  needs_review: boolean;
  updated_at: string;
  score?: number;
}

const KINDS =
  'decision, architecture, constraint, convention, bug-pattern, dependency, operational-runbook, human-preference, outcome, learned-risk, unresolved-question, summary';

const scopeText = (m: Memory) => (m.scope_type === 'project' ? 'project' : `${m.scope_type}:${m.scope_id}`);

function renderList(list: Memory[]): string {
  return list.length
    ? table(
        ['MEMORY', 'KIND', 'SCOPE', 'SUBJECT', 'AUTHORITY', 'STATUS', 'CONTENT'],
        list.map((m) => [
          m.memory_id,
          m.kind,
          scopeText(m),
          m.subject,
          m.authority,
          m.needs_review ? `${m.status}, review` : m.status,
          clip(m.content, 60),
        ]),
      )
    : 'No memories.';
}

function renderOne(m: Memory): string {
  return [
    `${m.memory_id}  ${m.kind}  ${scopeText(m)}  ${m.status}${m.needs_review ? ' (needs review)' : ''}`,
    `Subject: ${m.subject}`,
    m.content,
    `Authority: ${m.authority}, ${m.verification_status}; recorded by ${m.source.kind} ${m.source.id}; updated ${shortTime(m.updated_at)}`,
    m.tags.length ? `Tags: ${m.tags.join(', ')}` : '',
    m.supersedes ? `Supersedes: ${m.supersedes}` : '',
    m.superseded_by ? `Superseded by: ${m.superseded_by}` : '',
    m.contradicts.length ? `Contradicts: ${m.contradicts.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** `project`, `team:<role>`, `agent:<key>`, `task:<id>` or `session:<harness>`. */
function parseScope(s: string): { scope_type: string; scope_id?: string } {
  if (s === 'project') return { scope_type: 'project' };
  const m = s.match(/^(team|agent|task|session|organization):(.+)$/);
  if (!m)
    throw new UsageError(`--scope is project, team:<role>, agent:<key>, task:<id> or session:<harness>, not ${s}`);
  return { scope_type: m[1] as string, scope_id: m[2] as string };
}

const collect = (v: string, prev: string[] = []) => [...prev, v];

export function registerMemoryCommands(program: Command, g: () => GlobalOptions): void {
  const memory = program
    .command('memory')
    .description('project memory: decisions, conventions, constraints and what was learned');
  memory
    .command('add <content...>')
    .description('record a memory as a human (it is human-approved)')
    .requiredOption('--kind <kind>', KINDS)
    .requiredOption('--subject <subject>', 'what it is about; memories with the same kind and subject are compared')
    .option('--scope <scope>', 'project (default), team:<role>, agent:<key>, task:<id>', 'project')
    .option('--tag <tag>', 'a tag (repeatable)', collect)
    .action(async (content: string[], o: { kind: string; subject: string; scope: string; tag?: string[] }) => {
      const { client } = operator(g());
      const r = await client.post<{
        memory: Memory;
        deduplicated: boolean;
        superseded: string[];
        contradicts: string[];
      }>(client.projectPath('/memory'), {
        ...parseScope(o.scope),
        kind: o.kind,
        subject: o.subject,
        content: content.join(' '),
        tags: o.tag ?? [],
      });
      out(g(), r, () =>
        [
          r.deduplicated
            ? `Already recorded as ${r.memory.memory_id}; nothing changed.`
            : `Recorded ${r.memory.memory_id}.`,
          r.superseded.length ? `It supersedes ${r.superseded.join(', ')} (kept, marked superseded).` : '',
          r.contradicts.length
            ? `It contradicts ${r.contradicts.join(', ')} in another scope; precedence decides.`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    });
  memory
    .command('search [words...]')
    .description('find memories, best first (authority, verification, recency and reuse count)')
    .option('--kind <kind>', 'only this kind (repeatable)', collect)
    .option('--all', 'include superseded and retracted memories')
    .option('--limit <n>', 'at most this many', Number, 20)
    .action(async (words: string[], o: { kind?: string[]; all?: boolean; limit: number }) => {
      const { client } = operator(g());
      const params = new URLSearchParams();
      if (words.length) params.set('query', words.join(' '));
      for (const k of o.kind ?? []) params.append('kind', k);
      if (o.all) params.set('all', 'true');
      params.set('limit', String(o.limit));
      const r = await client.get<{ memories: Memory[] }>(`${client.projectPath('/memory')}?${params}`);
      out(g(), r.memories, () => renderList(r.memories));
    });
  memory
    .command('review')
    .description('memories waiting for a human: they contradict something with more authority')
    .action(async () => {
      const { client } = operator(g());
      const r = await client.get<{ memories: Memory[] }>(client.projectPath('/memory/review'));
      out(g(), r.memories, () =>
        r.memories.length
          ? `${renderList(r.memories)}\nApprove, supersede or retract each: friday memory approve|supersede|retract <id>`
          : 'Nothing waits for review.',
      );
    });
  memory
    .command('show <id>')
    .description('one memory with its provenance and links')
    .action(async (id: string) => {
      const { client } = operator(g());
      const m = await client.get<Memory>(client.projectPath(`/memory/${id}`));
      out(g(), m, () => renderOne(m));
    });
  memory
    .command('approve <id>')
    .description('make a memory human-approved and verified')
    .action(async (id: string) => {
      const { client } = operator(g());
      const m = await client.post<Memory>(client.projectPath(`/memory/${id}/approve`), {});
      out(g(), m, () => `${m.memory_id} is now human-approved.`);
    });
  memory
    .command('supersede <id>')
    .description('replace a memory with another one (the old one is kept, marked superseded)')
    .requiredOption('--by <id>', 'the memory that replaces it')
    .option('--reason <text>', 'why')
    .action(async (id: string, o: { by: string; reason?: string }) => {
      const { client } = operator(g());
      const m = await client.post<Memory>(client.projectPath(`/memory/${id}/supersede`), {
        by: o.by,
        ...(o.reason ? { reason: o.reason } : {}),
      });
      out(g(), m, () => `${m.memory_id} is superseded by ${m.superseded_by}.`);
    });
  memory
    .command('retract <id>')
    .description('withdraw a memory (it is kept, marked retracted)')
    .option('--reason <text>', 'why')
    .action(async (id: string, o: { reason?: string }) => {
      const { client } = operator(g());
      const m = await client.post<Memory>(
        client.projectPath(`/memory/${id}/retract`),
        o.reason ? { reason: o.reason } : {},
      );
      out(g(), m, () => `${m.memory_id} is retracted.`);
    });
}
