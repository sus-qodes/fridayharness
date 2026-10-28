import type { InboxItem, MessageView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out, UsageError } from './context.js';
import { clip, shortTime, table } from './output.js';

/** Agent messaging from the operator's side (plan M3, ADR-0017). */

const fromOf = (m: MessageView) => m.sender.agent_key ?? m.sender.kind;
const toOf = (m: MessageView) =>
  m.deliveries
    .map(
      (d) => d.agent_key ?? (d.recipient_kind === 'agent' ? d.recipient_id : `${d.recipient_kind}:${d.recipient_id}`),
    )
    .join(', ') || m.target;

export function renderMessage(m: MessageView): string {
  return [
    `${m.message_id}  ${m.mode}  ${m.status}${m.settled_reason ? ` (${m.settled_reason})` : ''}  ${m.priority}${m.blocking ? ', blocking' : ''}`,
    `From ${fromOf(m)} to ${m.target}${m.task_id ? ` about ${m.task_id}` : ''}; correlation ${m.correlation_id}${m.response_to ? `; answers ${m.response_to}` : ''}`,
    m.subject ? `Subject: ${m.subject}` : '',
    m.body,
    m.facts.length ? `Facts (unverified):\n${m.facts.map((f) => `  - ${f.fact}`).join('\n')}` : '',
    m.reply_by ? `Reply by ${m.reply_by}` : '',
    'Deliveries:',
    ...m.deliveries.map(
      (d) =>
        `  ${d.delivery_id}  ${d.agent_key ?? `${d.recipient_kind}:${d.recipient_id}`}  ${d.state}${d.attempts ? ` (${d.attempts} attempt${d.attempts > 1 ? 's' : ''})` : ''}${d.end_reason ? ` ${d.end_reason}` : ''}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}

export function renderInboxItem(i: InboxItem): string {
  return [
    `${i.delivery_id}  ${i.mode} from ${i.from.agent_key ?? i.from.kind}  ${i.priority}${i.blocking ? ', blocking' : ''}  ${shortTime(i.sent_at)}  (message ${i.message_id})`,
    i.in_reply_to ? `  in reply to: ${i.in_reply_to}` : '',
    i.subject ? `  ${i.subject}` : '',
    `  ${clip(i.body, 400)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function registerMessageCommands(program: Command, g: () => GlobalOptions): void {
  const messages = program
    .command('messages')
    .description('messages agents and humans sent through Friday (M3)')
    .option('--task <task>', 'about this task')
    .option('--agent <key>', 'sent or received by this agent')
    .option('--status <status>', 'open, settled or expired')
    .option('--limit <n>', 'how many', (v) => Number.parseInt(v, 10), 30)
    .action(async (o: { task?: string; agent?: string; status?: string; limit: number }) => {
      const { client } = operator(g());
      const r = await client.get<{ messages: MessageView[] }>(client.projectPath('/messages'), {
        query: {
          limit: String(o.limit),
          ...(o.task ? { task: o.task } : {}),
          ...(o.agent ? { agent: o.agent } : {}),
          ...(o.status ? { status: o.status } : {}),
        },
      });
      out(g(), r.messages, () =>
        r.messages.length
          ? table(
              ['MESSAGE', 'TIME', 'FROM', 'TO', 'MODE', 'STATUS', 'TEXT'],
              r.messages.map((m) => [
                m.message_id,
                shortTime(m.created_at),
                fromOf(m),
                clip(toOf(m), 24),
                m.mode,
                m.status,
                clip(m.subject ?? m.body, 50),
              ]),
            )
          : 'No messages.',
      );
    });
  messages
    .command('show <message>')
    .description('one message with its deliveries')
    .action(async (id: string) => {
      const { client } = operator(g());
      const m = await client.get<MessageView>(client.projectPath(`/messages/${id}`));
      out(g(), m, () => renderMessage(m));
    });
  messages
    .command('ack <ids...>')
    .description('acknowledge messages addressed to humans')
    .action(async (ids: string[]) => {
      const { client } = operator(g());
      const r = await client.post<{ acknowledged: string[] }>(client.projectPath('/inbox/human/ack'), { ids });
      out(g(), r, () => `Acknowledged ${r.acknowledged.length}.`);
    });

  program
    .command('inbox <who>')
    .description('what waits for "human", "master" (the Master Brain) or an agent key (a peek; nothing is reserved)')
    .action(async (who: string) => {
      const { client } = operator(g());
      const r = await client.get<{ items: InboxItem[] }>(client.projectPath(`/inbox/${encodeURIComponent(who)}`));
      out(g(), r.items, () => (r.items.length ? r.items.map(renderInboxItem).join('\n\n') : 'Nothing waiting.'));
    });

  program
    .command('say <to> <text...>')
    .description('send a message as a human: an agent key, role:<role>, task:<task_id> or broadcast')
    .option('--reply-to <message>', 'answer this message (it settles a request)')
    .option('--subject <text>')
    .option('--priority <p>', 'low, normal, high or urgent', 'normal')
    .action(async (to: string, text: string[], o: { replyTo?: string; subject?: string; priority: string }) => {
      if (!['low', 'normal', 'high', 'urgent'].includes(o.priority)) {
        throw new UsageError('--priority is low, normal, high or urgent');
      }
      const { client } = operator(g());
      const r = await client.post<{
        message_id: string;
        deliveries: { delivery_id: string; recipient: { kind: string; id: string; agent_key: string | null } }[];
        note: string | null;
      }>(client.projectPath('/messages'), {
        to,
        content: text.join(' '),
        ...(o.subject ? { subject: o.subject } : {}),
        ...(o.replyTo ? { reply_to: o.replyTo } : {}),
        priority: o.priority,
      });
      const who = r.deliveries.map((d) => d.recipient.agent_key ?? `${d.recipient.kind}:${d.recipient.id}`).join(', ');
      out(g(), r, () => `Message ${r.message_id} queued for ${who}${r.note ? ` (${r.note})` : ''}.`);
    });
}
