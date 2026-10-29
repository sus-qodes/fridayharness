/**
 * The approval modal (macro; plan §7.5, handoff Part 06 §4): the request in full; for a file
 * target the task's current diff (`+N −M` per file, a link to the diff drawer) and an impact list
 * from the code graph; the note that a grant is bound to this task, attempt and exact target; a
 * reach selector (once, this attempt, this task); Approve, held for 1.2 s for high risk or a task
 * reach; Reject with feedback; Reject and release the task.
 *
 * Friday does not know what an agent will write, so there is no "proposed change" (ERRATA F31).
 */
import type { ApprovalRow, TaskDiff } from '@friday/protocol';
import type { GraphQuery, Reach } from '../api/client.js';
import { visible } from '../model/text.js';
import { type AppContext, type Component, type ModalRequest, openDrawer } from '../shell/context.js';
import { append, button, h, replace, setText } from '../ui/dom.js';
import { plural, timeAgo, timeUntil } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { ARMING_TEXT, armDecisions, type Clock } from './arming.js';
import {
  agentKeyOf,
  agentText,
  errorText,
  isExpired,
  nextId,
  reducedMotion,
  riskBadge,
  riskOf,
  taskLine,
} from './common.js';
import { decideApproval, needsHold, REACH_LABEL, takeRequestedReach } from './decisions.js';
import { type HoldButton, holdButton } from './hold-button.js';

export interface ApprovalModalOptions {
  clock?: Clock;
}

// The reach words are the card's and the Allow button's (`REACH_LABEL`): one vocabulary for a grant's reach.
const REACHES: { reach: Reach; label: string; explain: string }[] = [
  { reach: 'once', label: 'Once', explain: 'This one call, then the agent asks again.' },
  {
    reach: 'run',
    label: 'For this attempt',
    explain: 'The same call on this exact target for the rest of this attempt.',
  },
  {
    reach: 'task',
    label: 'For this task',
    explain: 'The same call on this exact target for every attempt of this task.',
  },
];

/** File capabilities name a project-relative path as their target. */
export function isFileTarget(a: Pick<ApprovalRow, 'capability' | 'target'>): boolean {
  return a.capability.startsWith('file.') && !!a.target;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
  return norm(a) === norm(b);
}

export function approvalModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
  opts: ApprovalModalOptions = {},
): Component & { title: string; size: 'lg' } {
  const id = request.id ?? '';
  const found = ctx.store.select('board')?.approvals.find((x) => x.approval_id === id) ?? null;
  const el = h('div', { class: 'gv-modal gv-approval-modal' });

  if (found?.status !== 'pending') {
    replace(
      el,
      h('p', { class: 'empty' }, 'This approval is no longer pending: it was decided, revoked or has left the list.'),
      h(
        'div',
        { class: 'gv-actions gv-actions-end' },
        button('Close', () => close(), { class: 'btn' }),
      ),
    );
    return { el, title: 'Approval request', size: 'lg', destroy: () => el.remove() };
  }

  const a: ApprovalRow = found;
  let reach: Reach = takeRequestedReach(id) ?? 'once';
  let busy = false;
  let hold: HoldButton | null = null;
  let plain: HTMLButtonElement | null = null;
  let disposed = false;
  const board = ctx.store.select('board');
  const agent = agentKeyOf(board, a.requested_by_id) ?? a.requested_by_kind;

  const hint = h('div', { class: 'gv-arming-hint', aria: { live: 'polite' } }, ARMING_TEXT);
  const status = h('div', { class: 'gv-status', role: 'status', aria: { live: 'polite' } });
  const gone = h(
    'p',
    { class: 'gv-gone', role: 'alert', hidden: true },
    'This approval was decided elsewhere, or expired. Nothing here will change it.',
  );

  // ---- the request
  const head = h(
    'header',
    { class: 'gv-card-head' },
    h('span', { class: 'gv-card-icon gv-tone-approval' }, icon('shield', 18)),
    h('span', { class: 'gv-card-title mono' }, visible(a.capability)),
    h('span', { class: 'spacer' }),
    riskBadge(a),
    h('span', { class: 'gv-expiry' }, a.expires_at ? `expires ${timeUntil(a.expires_at, ctx.now())}` : 'no expiry'),
  );
  const meta = h(
    'dl',
    { class: 'gv-meta' },
    h('div', { class: 'gv-meta-row' }, h('dt', null, 'Agent'), h('dd', { class: 'mono' }, visible(agent))),
    h('div', { class: 'gv-meta-row' }, h('dt', null, 'Task'), h('dd', null, taskLine(board, a.task_id))),
    a.task_id && board?.runs[a.task_id]?.run_id === a.run_id
      ? h(
          'div',
          { class: 'gv-meta-row' },
          h('dt', null, 'Attempt'),
          h('dd', null, String(board.runs[a.task_id]?.attempt)),
        )
      : null,
    h('div', { class: 'gv-meta-row' }, h('dt', null, 'Asked'), h('dd', null, timeAgo(a.created_at, ctx.now()))),
  );
  const bound = h(
    'p',
    { class: 'gv-policy-note' },
    'A grant is bound to this task, this attempt and this exact target, and ends with its reach or its expiry. ' +
      'Nothing here changes the project policy.',
  );

  // ---- file context
  const fileSection = h('div', { class: 'gv-file-context' });
  if (isFileTarget(a) && a.task_id) {
    const diffBox = h('div', { class: 'gv-diff-summary' }, h('p', { class: 'muted' }, 'Reading the task’s changes…'));
    const impactBox = h('div', { class: 'gv-impact' }, h('p', { class: 'muted' }, 'Asking the code graph…'));
    const taskId = a.task_id;
    const target = a.target ?? '';
    append(
      fileSection,
      h('h4', { class: 'section-title' }, 'What this task has changed so far'),
      h(
        'p',
        { class: 'field-hint' },
        'Friday does not know what the agent will write; this is the task’s current diff.',
      ),
      diffBox,
      h('h4', { class: 'section-title' }, 'Impact of this file'),
      impactBox,
    );
    void ctx.api.taskDiff(taskId, true).then(
      (diff) => {
        if (!disposed) replace(diffBox, diffSummary(ctx, diff, target, taskId, a.approval_id, close));
      },
      (e: unknown) => {
        if (!disposed) replace(diffBox, h('p', { class: 'muted' }, `The diff could not be read (${errorText(e)}).`));
      },
    );
    void ctx.api.graphQuery(target).then(
      (q) => {
        if (!disposed) replace(impactBox, impactList(q));
      },
      () => {
        if (!disposed)
          replace(
            impactBox,
            h(
              'p',
              { class: 'muted' },
              'The code graph has no answer for this file (it covers TypeScript and JavaScript).',
            ),
          );
      },
    );
  }

  // ---- reach and decisions
  const reachButtons = REACHES.map((r) =>
    button(r.label, () => setReach(r.reach), {
      class: 'gv-reach-option',
      aria: { pressed: r.reach === reach ? 'true' : 'false' },
      dataset: { reach: r.reach },
    }),
  );
  const reachId = nextId('reach');
  const reachExplain = h('p', { class: 'field-hint', id: `${reachId}-hint` });
  const reachGroup = h(
    'div',
    { class: 'segmented gv-reach', role: 'group', aria: { labelledby: reachId, describedby: `${reachId}-hint` } },
    ...reachButtons,
  );
  const approveSlot = h('div', { class: 'gv-approve-slot' });
  const noteId = nextId('reject-note');
  const note = h('textarea', {
    class: 'textarea gv-reject-note',
    id: noteId,
    rows: 3,
    // The daemon keeps a reason of at most 500 characters.
    maxLength: 500,
    placeholder: 'e.g. “Do not hardcode secrets; read them from the environment.”',
  });
  const reject = button('Reject with feedback', () => undefined, { class: 'btn btn-danger gv-decide' });
  const rejectRelease = a.task_id
    ? button('Reject and release the task', () => undefined, { class: 'btn btn-ghost gv-decide gv-danger-text' })
    : null;

  append(
    el,
    head,
    meta,
    agentText('Target', a.target, 'gv-target'),
    agentText('Purpose', a.purpose, 'gv-purpose'),
    bound,
    fileSection,
    h(
      'div',
      { class: 'field gv-reach-field' },
      h('span', { class: 'field-label', id: reachId }, 'Reach of the grant'),
      reachGroup,
      reachExplain,
    ),
    approveSlot,
    h(
      'div',
      { class: 'field gv-reject-field' },
      h('label', { class: 'field-label', for: noteId }, 'Feedback for the agent (sent with a rejection)'),
      note,
    ),
    h('div', { class: 'gv-actions' }, reject, rejectRelease),
    gone,
    hint,
    status,
  );

  const arming = armDecisions(el, {
    key: JSON.stringify([a.approval_id, a.capability, a.target, a.purpose, a.risk]),
    hint,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  arming.register(reject);
  if (rejectRelease) arming.register(rejectRelease);

  const live = (): boolean => {
    if (disposed || busy || !gone.hidden) return false;
    if (isExpired(a, ctx.now())) {
      setText(status, 'This request expired; the agent has to ask again.');
      return false;
    }
    return arming.isArmed();
  };

  const approve = async (): Promise<void> => {
    if (!live()) {
      // The view changed while it was held: nothing was authorized; it can be held again.
      hold?.reset();
      setText(status, 'Not authorized: the view changed while you held. Hold again.');
      return;
    }
    busy = true;
    setText(status, `Allowing ${REACH_LABEL[reach]}…`);
    const outcome = await decideApproval(ctx, a, { allow: true, reuse: reach });
    busy = false;
    if (outcome === 'done' || outcome === 'already') finish();
    else {
      setText(status, 'The approval was not decided; it is still pending.');
      hold?.reset();
    }
  };

  const renderApprove = (): void => {
    hold?.destroy();
    hold = null;
    plain = null;
    const held = needsHold(a, reach);
    if (held) {
      hold = holdButton({
        label: `Hold to allow ${REACH_LABEL[reach]}`,
        onComplete: () => void approve(),
        canStart: live,
        ...(opts.clock ? { clock: opts.clock } : {}),
        ...(reducedMotion(ctx) ? { frames: null } : {}),
        className: riskOf(a) === 'high' ? 'gv-hold-high' : 'btn-primary',
      });
      // It looks unready until the card arms, like every other decision (a press before then does nothing).
      arming.register(hold.el);
      replace(
        approveSlot,
        hold.el,
        h(
          'p',
          { class: 'field-hint' },
          riskOf(a) === 'high'
            ? 'High risk: hold the button (or hold Space on it) for 1.2 seconds.'
            : 'A grant for the whole task: hold the button (or hold Space on it) for 1.2 seconds.',
        ),
      );
    } else {
      plain = button(
        `Allow ${REACH_LABEL[reach]}`,
        arming.guard(() => void approve()),
        {
          class: 'btn btn-primary gv-decide',
        },
      );
      arming.register(plain);
      replace(approveSlot, plain);
    }
    for (const b of reachButtons) b.setAttribute('aria-pressed', b.dataset.reach === reach ? 'true' : 'false');
    setText(reachExplain, REACHES.find((r) => r.reach === reach)?.explain ?? '');
  };

  const setReach = (next: Reach): void => {
    if (next === reach) return;
    reach = next;
    renderApprove();
  };

  const finish = (): void => {
    if (disposed) return;
    close();
  };

  reject.addEventListener(
    'click',
    arming.guard(async () => {
      if (!live()) return;
      busy = true;
      setText(status, 'Rejecting…');
      const outcome = await decideApproval(ctx, a, { allow: false, note: note.value });
      busy = false;
      if (outcome === 'done' || outcome === 'already') finish();
      else setText(status, 'The approval was not decided; it is still pending.');
    }),
  );

  rejectRelease?.addEventListener(
    'click',
    arming.guard(async () => {
      if (!live() || !a.task_id) return;
      const taskId = a.task_id;
      const ok = await ctx.confirm({
        title: 'Reject and release the task?',
        body: [
          'The request is rejected with your feedback, and the task goes back to READY.',
          'The agent’s attempt ends; its worktree and commits are kept for the next attempt.',
        ],
        confirmLabel: 'Reject and release',
        danger: true,
      });
      if (!ok || !live()) return;
      busy = true;
      setText(status, 'Rejecting…');
      const outcome = await decideApproval(ctx, a, { allow: false, note: note.value });
      if (outcome === 'done' || outcome === 'already') {
        setText(status, 'Releasing the task…');
        await ctx.act('Release the task', () => ctx.api.taskAction(taskId, 'release'), 'Task released to READY');
        ctx.refresh();
        busy = false;
        finish();
      } else {
        busy = false;
        setText(status, 'The approval was not decided; the task was not released.');
      }
    }),
  );

  renderApprove();

  // Decided elsewhere (the Notch, the CLI) while this was open: say so and stop deciding here.
  const unsubscribe = ctx.store.subscribe('board', (next) => {
    if (busy || disposed) return;
    const still = next?.approvals.some((x) => x.approval_id === a.approval_id && x.status === 'pending');
    if (!still) {
      gone.hidden = false;
      for (const b of [reject, rejectRelease, plain, ...reachButtons]) if (b) b.disabled = true;
      if (hold) hold.el.disabled = true;
    }
  });

  return {
    el,
    title: 'Approval request',
    size: 'lg',
    destroy(): void {
      disposed = true;
      unsubscribe();
      hold?.destroy();
      arming.destroy();
      el.remove();
    },
  };
}

function diffSummary(
  ctx: AppContext,
  diff: TaskDiff,
  target: string,
  taskId: string,
  approvalId: string,
  close: () => void,
): HTMLElement {
  const files = diff.files.slice(0, 40);
  const openDiff = button(
    [icon('file', 14), 'Open the diff'],
    () => {
      // A drawer under this dialog takes no input: close first, and let the drawer come back here.
      close();
      openDrawer(ctx, {
        kind: 'diff',
        id: taskId,
        path: target,
        back: { modal: { kind: 'approval', id: approvalId }, label: 'Back to the approval' },
      });
    },
    { class: 'btn btn-ghost' },
  );
  if (!diff.files.length) {
    return h(
      'div',
      null,
      h(
        'p',
        { class: 'muted' },
        diff.source === 'none' ? 'The task has no checkout to compare yet.' : 'No changes yet.',
      ),
    );
  }
  const total = diff.files.reduce(
    (acc, f) => ({ added: acc.added + (f.added ?? 0), removed: acc.removed + (f.removed ?? 0) }),
    { added: 0, removed: 0 },
  );
  return h(
    'div',
    null,
    h(
      'p',
      { class: 'gv-diff-total' },
      plural(diff.files.length, 'file'),
      ' ',
      h('span', { class: 'gv-add' }, `+${total.added}`),
      ' ',
      h('span', { class: 'gv-del' }, `−${total.removed}`),
    ),
    h(
      'ul',
      { class: 'gv-file-list' },
      ...files.map((f) =>
        h(
          'li',
          { class: ['gv-file', samePath(f.path, target) && 'gv-file-target'] },
          h('span', { class: 'gv-file-path mono' }, visible(f.path)),
          f.protected
            ? h('span', { class: 'badge badge-muted' }, 'protected')
            : f.binary
              ? h('span', { class: 'badge badge-muted' }, 'binary')
              : h(
                  'span',
                  { class: 'gv-file-stat' },
                  h('span', { class: 'gv-add' }, `+${f.added ?? 0}`),
                  ' ',
                  h('span', { class: 'gv-del' }, `−${f.removed ?? 0}`),
                ),
          samePath(f.path, target) ? h('span', { class: 'badge badge-info' }, 'this target') : null,
        ),
      ),
    ),
    diff.files.length > files.length
      ? h('p', { class: 'muted' }, `and ${diff.files.length - files.length} more`)
      : null,
    diff.truncated ? h('p', { class: 'muted' }, 'The diff was cut at Friday’s limits.') : null,
    openDiff,
  );
}

function impactList(q: GraphQuery): HTMLElement {
  const consumers = [...new Set(q.consumers.map((c) => c.from))];
  const list = (items: string[], empty: string) =>
    items.length
      ? h(
          'ul',
          { class: 'gv-file-list' },
          ...items.slice(0, 20).map((p) => h('li', { class: 'gv-file' }, h('span', { class: 'mono' }, visible(p)))),
          items.length > 20 ? h('li', { class: 'muted' }, `and ${items.length - 20} more`) : null,
        )
      : h('p', { class: 'muted' }, empty);
  return h(
    'div',
    null,
    h('p', { class: 'field-hint' }, 'From the main checkout’s code graph.'),
    h('div', { class: 'gv-impact-col' }, h('h5', { class: 'gv-sub' }, `Used by (${consumers.length})`)),
    list(consumers, 'No file imports it.'),
    h('div', { class: 'gv-impact-col' }, h('h5', { class: 'gv-sub' }, `Tests (${q.tests.length})`)),
    list(q.tests, 'No test covers it.'),
  );
}
