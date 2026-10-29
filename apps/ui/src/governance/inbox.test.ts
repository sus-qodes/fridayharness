import { afterEach, describe, expect, it } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeInboxItem, makeSnapshot } from '../test/fixtures.js';
import { inboxDrawer, replyTarget } from './inbox.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const MSG = 'msg_000000000000000000000ms01';
const DLV = 'dlv_000000000000000000000dl01';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function buttonNamed(root: Element, name: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

describe('inbox drawer', () => {
  let ctx: TestContext;
  afterEach(() => document.body.replaceChildren());

  function open(
    items = [makeInboxItem({ subject: `Contract ${HOSTILE}`, preview: `${HOSTILE} ${'p'.repeat(5000)}` })],
  ) {
    ctx = makeContext({
      snapshot: makeSnapshot({ inbox: items }),
      answers: {
        [`GET /messages/${MSG}`]: {
          message_id: MSG,
          body: `The response now carries currency.\n${HOSTILE}\u001b[31m red`,
          body_artifact_ref: null,
          facts: [{ fact: `currency is ISO ${HOSTILE}` }],
        },
        'POST /messages': { message_id: 'msg_reply' },
        'POST /inbox/human/ack': { acknowledged: [DLV] },
      },
    });
    const d = inboxDrawer(ctx, { kind: 'inbox' });
    document.body.appendChild(d.el);
    return d;
  }

  it('lists previews as text, shortened', () => {
    const d = open();
    // The header's word, one name for the drawer (review §4).
    expect(d.title).toBe('Messages');
    expect(d.el.querySelector('img')).toBeNull();
    expect(d.el.textContent).toContain('claude-1');
    expect(d.el.textContent).toContain(`Contract ${HOSTILE}`);
    const preview = d.el.querySelector('.gv-inbox-preview')?.textContent ?? '';
    expect(preview.startsWith(HOSTILE)).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(200);
    d.destroy();
  });

  it('says when nothing waits', () => {
    const d = open([]);
    expect(d.el.textContent).toContain('No messages for you.');
    d.destroy();
  });

  it('opening an item loads its body and shows it as text, without escape sequences', async () => {
    const d = open();
    (d.el.querySelector('.gv-inbox-row') as HTMLButtonElement).click();
    await flush();
    expect(ctx.transport.to('GET', `/messages/${MSG}`)).toHaveLength(1);
    const body = d.el.querySelector('.gv-message-body')?.textContent ?? '';
    expect(body).toContain(HOSTILE);
    expect(body).not.toContain('\u001b');
    expect(d.el.querySelector('img')).toBeNull();
    expect(d.el.querySelector('.gv-facts')?.textContent).toContain('currency is ISO');
    d.destroy();
  });

  it('Reply answers the sender with reply_to; Acknowledge closes the delivery', async () => {
    const d = open();
    (d.el.querySelector('.gv-inbox-row') as HTMLButtonElement).click();
    await flush();
    const reply = d.el.querySelector('.gv-inbox-actions textarea') as HTMLTextAreaElement;
    expect(d.el.querySelector(`label[for="${reply.id}"]`)?.textContent).toBe('Reply to claude-1');
    buttonNamed(d.el, 'Reply').click();
    await flush();
    expect(ctx.transport.to('POST', '/messages')).toHaveLength(0);
    reply.value = 'Thanks, noted';
    buttonNamed(d.el, 'Reply').click();
    await flush();
    expect(ctx.transport.to('POST', '/messages')[0]?.body).toEqual({
      to: 'claude-1',
      content: 'Thanks, noted',
      reply_to: MSG,
    });
    buttonNamed(d.el, 'Acknowledge').click();
    await flush();
    expect(ctx.transport.to('POST', '/inbox/human/ack')[0]?.body).toEqual({ ids: [DLV] });
    d.destroy();
  });

  it('replies go to the agent or the Master Brain, never to Friday itself', () => {
    expect(replyTarget(makeInboxItem())).toBe('claude-1');
    expect(
      replyTarget(makeInboxItem({ from: { kind: 'master_brain', id: 'master-brain', agent_key: null, role: null } })),
    ).toBe('master');
    expect(
      replyTarget(makeInboxItem({ from: { kind: 'system', id: 'friday', agent_key: null, role: null } })),
    ).toBeNull();
  });

  it('keeps the list when a snapshot re-read did not change it', () => {
    const d = open();
    const row = d.el.querySelector('.gv-inbox-row');
    const same = ctx.store.select('board');
    if (same) ctx.board({ ...same });
    expect(d.el.querySelector('.gv-inbox-row')).toBe(row);
    ctx.board(makeSnapshot({ inbox: [] }));
    expect(d.el.textContent).toContain('No messages for you.');
    d.destroy();
  });
});
