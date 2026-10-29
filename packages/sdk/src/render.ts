import type { ContextPacket } from '@friday/protocol';

/**
 * Renders a context packet as compact Markdown with inline provenance tags, within `maxChars`.
 * Sections are dropped from the end except the protocol reminder, which is always kept. A host
 * without Friday's own tools (`fridayTools: false`, a spawn adapter's host) is not pointed at them.
 */
export function renderContextMarkdown(
  packet: ContextPacket,
  maxChars = 9000,
  opts: { fridayTools?: boolean } = {},
): string {
  const tools = opts.fridayTools !== false;
  const header = `<friday-context id="${packet.context_id}" task="${packet.task_id ?? 'none'}" state="${packet.state_version}" created="${packet.created_at}">`;
  const footer = tools ? `Full packet: friday://context/${packet.context_id}\n</friday-context>` : '</friday-context>';
  const render = (s: ContextPacket['sections'][number]) => {
    const src = s.sources[0];
    const tag = src ? ` [${s.kind} · ${src.source_type}:${src.source_id} · ${s.authority}]` : ` [${s.kind}]`;
    return `## ${titleOf(s.kind)}${tag}\n${s.content.trim()}\n`;
  };
  const reminder = packet.sections.find((s) => s.kind === 'protocol.reminder');
  const others = packet.sections.filter((s) => s !== reminder);
  const tail = reminder ? render(reminder) : '';
  let body = '';
  let dropped = 0;
  for (const s of others) {
    const block = render(s);
    if (header.length + body.length + block.length + tail.length + footer.length + 80 > maxChars) {
      dropped += 1;
      continue;
    }
    body += block;
  }
  const note =
    dropped > 0
      ? `_(${dropped} section(s) omitted to fit the budget${tools ? '; request them with friday_request_context' : ''})_\n`
      : '';
  return `${header}\n${body}${note}${tail}${footer}`;
}

function titleOf(kind: string): string {
  const map: Record<string, string> = {
    'agent.identity': 'You',
    'task.contract': 'Task',
    'task.acceptance': 'Acceptance criteria',
    'task.scope': 'Scope',
    'task.plan': 'Goal, plan and decisions',
    'task.progress': 'Progress so far',
    'repo.head': 'Repository',
    'repo.dirty': 'Uncommitted changes',
    'repo.recent_commits': 'Recent commits in scope',
    'repo.history': 'History you asked for',
    'code.requested': 'What you asked for',
    'code.related': 'Related code',
    'memory.relevant': 'What Friday remembers',
    'task.requirements': "The human's requirements",
    'request.note': 'About your request',
    'inbox.summary': 'Inbox',
    'tasks.claimable': 'Tasks you can claim',
    'protocol.reminder': 'How to work with Friday',
  };
  return map[kind] ?? kind;
}
