/**
 * Plan review (plan §7.5, §7.3): the proposed version of a goal's plan, task by task with its
 * change (new, keep, rework, drop) and note, and its diff against the active version
 * (`plans/:id/diff`); Approve, or Reject with a note.
 */
import type { LivePlanTask, LivePlanVersion } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, plural, truncate } from '../ui/format.js';
import { ARMING_TEXT, armDecisions, type Clock } from './arming.js';
import { errorText, nextId } from './common.js';

export interface PlanReviewOptions {
  clock?: Clock;
}

export const CHANGE_LOOK: Record<string, { label: string; tone: string }> = {
  new: { label: 'new', tone: 'badge-info' },
  keep: { label: 'keep', tone: 'badge-muted' },
  rework: { label: 'rework', tone: 'badge-warn' },
  drop: { label: 'drop', tone: 'badge-danger' },
};

interface DiffTask {
  key: string;
  summary?: string;
}

interface PlanDiffView {
  added: DiffTask[];
  dropped: DiffTask[];
  reworked: DiffTask[];
  changed: { task: DiffTask; fields: string[] }[];
  unchanged: number;
}

/** Reads the diff route's `diff` defensively (its type is the planner's, not the protocol's). */
export function readPlanDiff(raw: unknown): PlanDiffView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tasks = (v: unknown): DiffTask[] =>
    Array.isArray(v)
      ? v
          .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
          .map((t) => ({ key: String(t.key ?? '?'), ...(typeof t.summary === 'string' ? { summary: t.summary } : {}) }))
      : [];
  const changed = Array.isArray(r.changed)
    ? r.changed
        .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
        .map((c) => ({
          task: tasks([c.task])[0] ?? { key: '?' },
          fields: Array.isArray(c.fields) ? c.fields.filter((f): f is string => typeof f === 'string') : [],
        }))
    : [];
  return {
    added: tasks(r.added),
    dropped: tasks(r.dropped),
    reworked: tasks(r.reworked),
    changed,
    unchanged: typeof r.unchanged === 'number' ? r.unchanged : 0,
  };
}

function taskRow(t: LivePlanTask): HTMLElement {
  const look = CHANGE_LOOK[t.change] ?? { label: t.change, tone: 'badge-muted' };
  return h(
    'li',
    { class: ['gv-plan-task', `gv-change-${t.change}`], dataset: { key: t.key } },
    h(
      'div',
      { class: 'gv-plan-task-head' },
      h('span', { class: ['badge', look.tone] }, look.label),
      h('span', { class: 'mono gv-plan-key' }, visible(t.key)),
      h('span', { class: 'gv-plan-summary' }, truncate(cleanText(t.summary), 300)),
    ),
    h(
      'div',
      { class: 'gv-plan-task-meta muted' },
      `${t.kind} · ${t.role} · ${t.priority} priority · ${t.risk_level} risk`,
      t.depends_on.length ? ` · after ${t.depends_on.map((d) => visible(d)).join(', ')}` : '',
      t.acceptance_criteria.length ? ` · ${plural(t.acceptance_criteria.length, 'criterion', 'criteria')}` : '',
    ),
    t.scope?.write?.length
      ? h(
          'div',
          { class: 'gv-plan-scope' },
          h('span', { class: 'gv-k' }, 'Writes '),
          ...t.scope.write.map((g) => h('span', { class: 'pill mono' }, visible(g))),
        )
      : null,
    t.note ? h('p', { class: 'gv-plan-note' }, h('span', { class: 'gv-k' }, 'Note: '), cleanText(t.note)) : null,
  );
}

function diffView(d: PlanDiffView): HTMLElement {
  const line = (label: string, items: DiffTask[]) =>
    items.length
      ? h('li', null, h('strong', null, `${label} (${items.length}): `), items.map((t) => visible(t.key)).join(', '))
      : null;
  return h(
    'ul',
    { class: 'gv-plan-diff' },
    line('Added', d.added),
    line('Dropped', d.dropped),
    line('Reworked', d.reworked),
    d.changed.length
      ? h(
          'li',
          null,
          h('strong', null, `Changed (${d.changed.length}): `),
          d.changed.map((c) => `${visible(c.task.key)} (${c.fields.join(', ')})`).join('; '),
        )
      : null,
    h('li', { class: 'muted' }, `${plural(d.unchanged, 'task')} unchanged`),
  );
}

export function planReview(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
  opts: PlanReviewOptions = {},
): Component & { title: string; size: 'lg' } {
  const goalId = request.id ?? '';
  const board = ctx.store.select('board');
  const goal = board?.goals.find((g) => g.goal_id === goalId) ?? null;
  const plans = board?.plans[goalId] ?? null;
  const proposed: LivePlanVersion | null = plans?.proposed ?? null;
  const active: LivePlanVersion | null = plans?.active ?? null;
  const el = h('div', { class: 'gv-modal gv-plan-review' });

  if (!proposed) {
    replace(
      el,
      h('p', { class: 'empty' }, 'No proposed plan waits for this goal.'),
      h(
        'div',
        { class: 'gv-actions gv-actions-end' },
        button('Close', () => close(), { class: 'btn' }),
      ),
    );
    return { el, title: 'Plan review', size: 'lg', destroy: () => el.remove() };
  }

  const p = proposed;
  let busy = false;
  let disposed = false;
  const hint = h('div', { class: 'gv-arming-hint', aria: { live: 'polite' } }, ARMING_TEXT);
  const status = h('div', { class: 'gv-status', role: 'status', aria: { live: 'polite' } });
  const gone = h(
    'p',
    { class: 'gv-gone', role: 'alert', hidden: true },
    'This proposal was decided elsewhere or replaced by a newer one.',
  );
  const diffBox = h(
    'div',
    { class: 'gv-plan-diff-box' },
    active
      ? h('p', { class: 'muted' }, 'Comparing with the active plan…')
      : h('p', { class: 'muted' }, 'This is the goal’s first plan.'),
  );
  const noteId = nextId('plan-note');
  const note = h('textarea', {
    class: 'textarea',
    id: noteId,
    rows: 2,
    maxLength: 2000,
    placeholder: 'Why it is rejected (the planner reads it when it revises)',
  });
  const approve = button('Approve plan', () => undefined, { class: 'btn btn-primary gv-decide' });
  const reject = button('Reject with note', () => undefined, { class: 'btn btn-danger gv-decide' });
  const tasks = [...p.tasks].sort((x, y) => x.position - y.position);

  replace(
    el,
    h(
      'header',
      { class: 'gv-card-head' },
      h('span', { class: 'gv-card-title' }, `Proposed plan v${p.version}`),
      h('span', { class: 'spacer' }),
      h(
        'span',
        { class: 'badge badge-info' },
        p.proposed_by.kind === 'master_brain' ? 'Master Brain' : humanOrOther(p.proposed_by.kind),
      ),
    ),
    goal ? h('p', { class: 'gv-from' }, 'Goal: ', truncate(cleanText(goal.request), 300)) : null,
    p.summary ? h('p', { class: 'gv-question-text' }, cleanText(p.summary)) : null,
    p.rationale
      ? h('p', { class: 'gv-why' }, h('span', { class: 'gv-k' }, 'Rationale: '), cleanText(p.rationale))
      : null,
    h('p', { class: 'field-hint' }, `Trigger: ${cleanText(p.trigger)}`),
    p.needs_human
      ? h(
          'div',
          { class: 'gv-needs-human' },
          h('strong', null, 'The planner asks: '),
          cleanText(p.needs_human.question),
          p.needs_human.why ? h('p', { class: 'field-hint' }, cleanText(p.needs_human.why)) : null,
        )
      : null,
    h('h4', { class: 'section-title' }, `Tasks (${tasks.length})`),
    h('ol', { class: 'gv-plan-tasks' }, ...tasks.map(taskRow)),
    h('h4', { class: 'section-title' }, active ? `Against the active plan v${active.version}` : 'Changes'),
    diffBox,
    h(
      'div',
      { class: 'field' },
      h('label', { class: 'field-label', for: noteId }, 'Note (sent with a rejection)'),
      note,
    ),
    h('div', { class: 'gv-actions' }, approve, reject),
    gone,
    hint,
    status,
  );

  if (active) {
    ctx.api.planDiff(p.plan_id, active.version, p.version).then(
      (r) => {
        if (disposed) return;
        const d = readPlanDiff(r.diff);
        replace(diffBox, d ? diffView(d) : h('p', { class: 'muted' }, 'The diff could not be read.'));
      },
      (e: unknown) => {
        if (!disposed) replace(diffBox, h('p', { class: 'muted' }, `The diff could not be read (${errorText(e)}).`));
      },
    );
  }

  const arming = armDecisions(el, {
    key: JSON.stringify([p.plan_id, p.version, p.tasks.length]),
    hint,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  arming.register(approve);
  arming.register(reject);

  approve.addEventListener(
    'click',
    arming.guard(async () => {
      if (busy || !gone.hidden) return;
      busy = true;
      approve.disabled = true;
      setText(status, 'Approving…');
      const r = await ctx.act('Approve the plan', () => ctx.api.approvePlan(p.plan_id, p.version), 'Plan approved');
      busy = false;
      approve.disabled = false;
      if (r) {
        ctx.refresh();
        if (!disposed) close();
      } else setText(status, '');
    }),
  );
  reject.addEventListener(
    'click',
    arming.guard(async () => {
      if (busy || !gone.hidden) return;
      busy = true;
      reject.disabled = true;
      setText(status, 'Rejecting…');
      const text = note.value.trim();
      const r = await ctx.act(
        'Reject the plan',
        () => ctx.api.rejectPlan(p.plan_id, p.version, text || undefined),
        'Plan rejected',
      );
      busy = false;
      reject.disabled = false;
      if (r) {
        ctx.refresh();
        if (!disposed) close();
      } else setText(status, '');
    }),
  );

  const unsubscribe = ctx.store.subscribe('board', (next) => {
    if (busy || disposed) return;
    const now = next?.plans[goalId]?.proposed;
    if (!now || now.plan_id !== p.plan_id || now.version !== p.version) {
      gone.hidden = false;
      approve.disabled = true;
      reject.disabled = true;
    }
  });

  return {
    el,
    title: 'Plan review',
    size: 'lg',
    destroy(): void {
      disposed = true;
      unsubscribe();
      arming.destroy();
      el.remove();
    },
  };
}

function humanOrOther(kind: string): string {
  return kind === 'human' ? 'written by a person' : kind;
}
