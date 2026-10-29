/**
 * The Messages drawer (plan §7.5; one name everywhere, the header's): the snapshot's open deliveries
 * with a short preview; opening one loads the message body (`GET messages/:id`) and shows it as
 * text; Reply sends a response to the sender (`POST messages` with `reply_to`), Acknowledge closes
 * the delivery (`POST inbox/human/ack`). Messages are information, never approval or permission.
 */
import type { MessageView, SnapshotInboxItem } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component, DrawerRequest } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, timeAgo, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { errorText, nextId, taskLine } from './common.js';

/** Who a reply goes to: the sending agent's key, or the Master Brain; null when nobody can read one. */
export function replyTarget(item: Pick<SnapshotInboxItem, 'from'>): string | null {
  if (item.from.kind === 'agent') return item.from.agent_key ?? null;
  if (item.from.kind === 'master_brain') return 'master';
  return null;
}

function senderText(item: Pick<SnapshotInboxItem, 'from'>): string {
  if (item.from.kind === 'agent') return item.from.agent_key ?? item.from.id;
  if (item.from.kind === 'master_brain') return 'Master Brain';
  if (item.from.kind === 'system') return 'Friday';
  return item.from.kind;
}

export function inboxDrawer(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  let openId: string | null = request.id ?? null;
  let disposed = false;
  let loadToken = 0;
  const list = h('ul', { class: 'gv-inbox-list', aria: { label: 'Messages' } });
  const detail = h('div', { class: 'gv-inbox-detail', aria: { live: 'polite' } });
  const el = h('div', { class: 'gv-inbox' }, list, detail);

  const items = (): SnapshotInboxItem[] => ctx.store.select('board')?.inbox ?? [];

  const renderList = (): void => {
    const all = items();
    if (!all.length) {
      replace(list, h('li', { class: 'empty' }, 'No messages for you.'));
      return;
    }
    replace(
      list,
      ...all.map((item) => {
        const isOpen = item.delivery_id === openId || item.message_id === openId;
        const sent = (item as { sent_at?: string }).sent_at;
        return h(
          'li',
          { class: ['gv-inbox-item', isOpen && 'gv-inbox-open'], dataset: { deliveryId: item.delivery_id } },
          button(
            [
              h(
                'span',
                { class: 'gv-inbox-head' },
                h('span', { class: 'mono gv-inbox-from' }, visible(senderText(item))),
                item.priority === 'high' || item.priority === 'urgent'
                  ? h('span', { class: 'badge badge-warn' }, item.priority)
                  : null,
                item.blocking || item.mode === 'request'
                  ? h('span', { class: 'badge badge-info' }, 'waits for a reply')
                  : null,
                h('span', { class: 'spacer' }),
                sent ? h('span', { class: 'muted gv-age' }, timeAgo(sent, ctx.now())) : null,
              ),
              item.subject ? h('span', { class: 'gv-inbox-subject' }, truncate(cleanText(item.subject), 160)) : null,
              h('span', { class: 'gv-inbox-preview muted' }, truncate(cleanText(item.preview), 200)),
            ],
            () => open(item),
            { class: 'gv-inbox-row', aria: { expanded: isOpen ? 'true' : 'false' } },
          ),
        );
      }),
    );
  };

  const open = (item: SnapshotInboxItem): void => {
    openId = item.delivery_id;
    renderList();
    const token = ++loadToken;
    replace(detail, h('p', { class: 'muted' }, 'Loading the message…'));
    ctx.api.get<MessageView>(`/messages/${encodeURIComponent(item.message_id)}`).then(
      (m) => {
        if (disposed || token !== loadToken) return;
        renderDetail(item, m);
      },
      (e: unknown) => {
        if (disposed || token !== loadToken) return;
        replace(detail, h('p', { class: 'muted' }, `The message could not be read (${errorText(e)}).`));
        renderActions(item);
      },
    );
  };

  const actionsBox = h('div', { class: 'gv-inbox-actions' });

  const renderDetail = (item: SnapshotInboxItem, m: MessageView): void => {
    replace(
      detail,
      h(
        'header',
        { class: 'gv-card-head' },
        h('span', { class: 'gv-card-icon gv-tone-message' }, icon('message', 16)),
        h('h3', { class: 'gv-card-title' }, item.subject ? truncate(cleanText(item.subject), 200) : 'Message'),
      ),
      h(
        'p',
        { class: 'gv-from' },
        'From ',
        h('strong', { class: 'mono' }, visible(senderText(item))),
        item.task_id ? [' · ', taskLine(ctx.store.select('board'), item.task_id)] : null,
      ),
      h('div', { class: 'gv-message-body' }, cleanText(m.body)),
      m.body_artifact_ref
        ? h('p', { class: 'field-hint' }, 'The full message is longer and kept as an artifact.')
        : null,
      m.facts?.length
        ? h('ul', { class: 'gv-facts' }, ...m.facts.slice(0, 20).map((f) => h('li', null, cleanText(f.fact))))
        : null,
      h('p', { class: 'field-hint' }, 'Messages are information from an agent; they never grant anything.'),
      actionsBox,
    );
    renderActions(item);
  };

  const renderActions = (item: SnapshotInboxItem): void => {
    const to = replyTarget(item);
    const replyId = nextId('inbox-reply');
    const reply = h('textarea', {
      class: 'textarea',
      id: replyId,
      rows: 3,
      maxLength: 8000,
      placeholder: 'Your reply…',
    });
    const status = h('div', { class: 'gv-status', role: 'status', aria: { live: 'polite' } });
    const send = button(
      'Reply',
      async () => {
        const content = reply.value.trim();
        if (!to || !content) {
          setText(status, 'Write the reply first.');
          return;
        }
        send.disabled = true;
        const r = await ctx.act(
          'Reply',
          () => ctx.api.send({ to, content, reply_to: item.message_id }),
          `Reply sent to ${to}`,
        );
        send.disabled = false;
        if (r) {
          reply.value = '';
          setText(status, 'Sent');
          ctx.refresh();
        }
      },
      { class: 'btn btn-primary' },
    );
    const ack = button(
      'Acknowledge',
      async () => {
        ack.disabled = true;
        const r = await ctx.act('Acknowledge', () => ctx.api.ackHuman([item.delivery_id]), 'Acknowledged');
        ack.disabled = false;
        if (r) {
          setText(status, 'Acknowledged');
          ctx.refresh();
        }
      },
      { class: 'btn' },
    );
    replace(
      actionsBox,
      to
        ? h(
            'div',
            { class: 'field' },
            h('label', { class: 'field-label', for: replyId }, `Reply to ${visible(to)}`),
            reply,
          )
        : h('p', { class: 'field-hint' }, 'Nobody reads replies to this sender.'),
      h('div', { class: 'gv-actions' }, to ? send : null, ack),
      status,
    );
    if (!actionsBox.isConnected) detail.append(actionsBox);
  };

  renderList();
  if (!openId) replace(detail, h('p', { class: 'muted gv-inbox-hint' }, 'Open a message to read it.'));
  else {
    const first = items().find((i) => i.delivery_id === openId || i.message_id === openId);
    if (first) open(first);
  }

  // Re-render only when the list itself changed, so a snapshot re-read keeps focus where it is.
  const signature = (): string =>
    items()
      .map((i) => `${i.delivery_id}:${i.preview}:${i.subject ?? ''}`)
      .join('|');
  let shown = signature();
  const unsubscribe = ctx.store.subscribe('board', () => {
    if (disposed) return;
    const next = signature();
    if (next === shown) return;
    shown = next;
    renderList();
  });

  return {
    el,
    title: 'Messages',
    destroy(): void {
      disposed = true;
      unsubscribe();
      el.remove();
    },
  };
}
