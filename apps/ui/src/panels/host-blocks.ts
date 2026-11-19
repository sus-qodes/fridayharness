/**
 * The notice of what keeps a host out of work, and the way back (2026-11-17).
 *
 * A host that said it is not signed in is given no task until a person says it is: that record has
 * no expiry, and only `friday readiness clear` in a terminal ended it, so signing in again changed
 * nothing and every later task for the host was refused. A host that hit a limit or failed is
 * left out for a while (a bench) and tried again by itself. One row per block, in plain words
 * (`model/host-blocks.ts`), with one button that lifts the record (`POST readiness/clear`); a host
 * still signed out fails its next attempt and is kept out again.
 */
import type { HostBlockView } from '@friday/protocol';
import { blockKey, blockSentence, hostBlocks, hostName, liftLabel } from '../model/host-blocks.js';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { note, plain, type Teardown } from './common.js';

/** Lifts a block through the daemon; resolves true when it was lifted. */
export async function liftBlock(ctx: AppContext, b: HostBlockView): Promise<boolean> {
  const done = await ctx.act(
    b.kind === 'sign_in' ? 'Try the sign-in again' : 'Try the host again',
    () => ctx.api.clearReadiness(b.host, b.model),
    `${hostName(b.host)} is tried again with the next task`,
  );
  if (done) ctx.refresh();
  return Boolean(done);
}

/**
 * The notice: one row per block with its button. Empty and hidden while nothing is kept out.
 * `host` limits it to one host's blocks.
 */
export function hostBlocksNotice(ctx: AppContext, td: Teardown, host?: string): HTMLElement {
  const el = h('div', { class: 'pn-host-blocks', hidden: true });
  const busy = new Set<string>();

  async function lift(b: HostBlockView) {
    const key = blockKey(b);
    if (busy.has(key)) return;
    busy.add(key);
    render();
    await liftBlock(ctx, b);
    busy.delete(key);
    if (!td.done) render();
  }

  function render() {
    const blocks = hostBlocks(ctx.store.select('board'), host);
    el.hidden = blocks.length === 0;
    replace(
      el,
      ...blocks.map((b) =>
        h(
          'div',
          {
            class: ['pn-host-block', `pn-host-block-${b.kind}`],
            role: 'status',
            dataset: { host: b.host, kind: b.kind },
          },
          note(blockSentence(b)),
          b.detail ? h('p', { class: 'muted pn-host-block-detail' }, `It said: ${plain(b.detail, 200)}`) : null,
          h(
            'div',
            { class: 'pn-actions pn-actions-start' },
            button(liftLabel(b), () => void lift(b), {
              class: b.kind === 'sign_in' ? 'btn btn-primary' : 'btn',
              disabled: busy.has(blockKey(b)),
            }),
          ),
        ),
      ),
    );
  }

  render();
  td.add(ctx.store.subscribe('board', () => render()));
  return el;
}
