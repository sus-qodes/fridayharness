/**
 * A proposed plan version on the canvas (plan §7.3, §7.5): dashed ghost cards for its new and
 * reworked tasks, and a review bar under the goal (Approve, Reject with a note, Review, which opens
 * the plan review with the diff against the active version). The decision buttons arm only after
 * the bar has been visible and still for 700 ms and the pointer moved onto it or the user focused
 * it (FD-28); any change of content or position arms them again.
 */
import type { LivePlanVersion } from '@friday/protocol';
import type { PlanGhost } from '../model/board.js';
import { TASK_KIND } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, openModal } from '../shell/context.js';
import { button, h, replace, setVar, toggleClass } from '../ui/dom.js';
import { cleanText, humanize, shortId, truncate } from '../ui/format.js';
import { actionButton, badge, fingerprint, type NodeView, nodeIcon, pill, pills } from './common.js';

export const ARM_DELAY_MS = 700;

/**
 * Arms decision controls (FD-28): `reset()` when the content or position changes, `engage()` when
 * the pointer moves onto the controls or the user focuses them; armed once both the delay passed
 * since the last reset and an engagement came after it.
 */
export class Arming {
  #armed = false;
  #stable = false;
  #engaged = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onChange: (armed: boolean) => void,
    private readonly delayMs = ARM_DELAY_MS,
  ) {
    this.reset();
  }

  get armed(): boolean {
    return this.#armed;
  }

  reset(): void {
    if (this.#timer) clearTimeout(this.#timer);
    const was = this.#armed;
    this.#armed = false;
    this.#stable = false;
    this.#engaged = false;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#stable = true;
      this.#check();
    }, this.delayMs);
    if (was) this.onChange(false);
  }

  engage(): void {
    this.#engaged = true;
    this.#check();
  }

  destroy(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #check(): void {
    if (this.#armed || !this.#stable || !this.#engaged) return;
    this.#armed = true;
    this.onChange(true);
  }
}

export interface PlanBarModel {
  goalId: string;
  plan: LivePlanVersion;
}

/** New, reworked, dropped and kept tasks of a plan version. */
export function planCounts(plan: Pick<LivePlanVersion, 'tasks'>): {
  new: number;
  rework: number;
  drop: number;
  keep: number;
} {
  const out = { new: 0, rework: 0, drop: 0, keep: 0 };
  for (const t of plan.tasks) out[t.change] += 1;
  return out;
}

export function proposer(plan: Pick<LivePlanVersion, 'proposed_by'>): string {
  const kind = plan.proposed_by?.kind;
  if (kind === 'master_brain') return 'the Master Brain';
  if (kind === 'human') return 'a human';
  return kind ? humanize(kind) : 'someone';
}

export function createPlanReviewBar(ctx: AppContext, initial: PlanBarModel): NodeView<PlanBarModel> {
  let model = initial;
  let printed = '';
  let noteOpen = false;
  const decisions: HTMLButtonElement[] = [];
  const arming = new Arming((armed) => {
    for (const b of decisions) {
      b.setAttribute('aria-disabled', String(!armed));
      toggleClass(b, 'nd-unarmed', !armed);
      b.title = armed ? '' : 'Ready in a moment';
    }
  });

  const body = h('div', { class: 'nd-body' });
  const controls = h('div', { class: 'nd-review-actions' });
  const notePanel = h('div', {
    class: 'nd-reject',
    hidden: true,
    on: {
      keydown: (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        closeNote();
        el.focus();
      },
    },
  });
  const el = h(
    'div',
    {
      class: ['nd-card', 'nd-planbar'],
      role: 'group',
      tabIndex: 0,
      dataset: { id: `planbar:${initial.goalId}`, kind: 'planbar' },
      on: {
        pointermove: () => arming.engage(),
        focusin: () => arming.engage(),
      },
    },
    body,
    controls,
    notePanel,
  );

  const decide = (run: () => unknown) => (): unknown => (arming.armed ? run() : undefined);

  const approve = () => {
    const p = model.plan;
    return ctx
      .act('Approve the plan', () => ctx.api.approvePlan(p.plan_id, p.version), `Plan v${p.version} approved`)
      .then(() => ctx.refresh());
  };

  function closeNote(): void {
    noteOpen = false;
    notePanel.hidden = true;
    replace(notePanel);
  }

  function openNote(): void {
    noteOpen = true;
    const field = h('textarea', {
      class: 'textarea nd-reject-note',
      rows: 2,
      maxLength: 2000,
      placeholder: 'What should change (sent with the rejection)',
      aria: { label: 'Why the plan is rejected' },
    });
    const send = button(
      'Reject the plan',
      () => {
        const p = model.plan;
        const note = field.value.trim();
        closeNote();
        void ctx
          .act(
            'Reject the plan',
            () => ctx.api.rejectPlan(p.plan_id, p.version, note || undefined),
            `Plan v${p.version} rejected`,
          )
          .then(() => ctx.refresh());
      },
      { class: 'btn btn-danger', dataset: { action: 'reject-send' } },
    );
    replace(
      notePanel,
      field,
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'spacer' }),
        button('Back', closeNote, { class: 'btn btn-ghost' }),
        send,
      ),
    );
    notePanel.hidden = false;
    field.focus();
  }

  function render(force = false): void {
    const p = model.plan;
    const counts = planCounts(p);
    const print = fingerprint([p.plan_id, p.version, p.status, p.summary, counts, p.proposed_by]);
    if (!force && print === printed) return;
    printed = print;
    if (noteOpen) closeNote();
    const parts = [
      counts.new && `${counts.new} new`,
      counts.rework && `${counts.rework} rework`,
      counts.drop && `${counts.drop} dropped`,
      counts.keep && `${counts.keep} kept`,
    ].filter(Boolean);
    replace(
      body,
      h(
        'div',
        { class: 'nd-head', dataset: { dragHandle: '' } },
        nodeIcon('layers', 14),
        h('span', { class: 'nd-title' }, `Plan v${p.version} proposed`),
        h('span', { class: 'muted nd-by' }, `by ${proposer(p)}`),
        h('span', { class: 'spacer' }),
        badge(parts.join(' · ') || 'no tasks', 'warn'),
      ),
      h(
        'p',
        { class: 'nd-summary nd-plan-summary', title: truncate(cleanText(p.summary), 2000) },
        truncate(cleanText(p.summary), 200),
      ),
    );
    decisions.length = 0;
    const approveBtn = actionButton('Approve', 'check', decide(approve), {
      cls: 'nd-act-primary',
      action: 'approve',
      busyLabel: 'Approving…',
    });
    const rejectBtn = actionButton('Reject…', 'cross', decide(openNote), { cls: 'nd-act-danger', action: 'reject' });
    decisions.push(approveBtn, rejectBtn);
    replace(
      controls,
      approveBtn,
      rejectBtn,
      actionButton('Review', 'eye', () => openModal(ctx, { kind: 'plan-review', id: model.goalId }), {
        action: 'review',
        title: 'Open the plan review with the diff',
      }),
    );
    el.setAttribute('aria-label', `Plan version ${p.version} waits for review`);
    arming.reset();
    for (const b of decisions) {
      b.setAttribute('aria-disabled', 'true');
      toggleClass(b, 'nd-unarmed', true);
      b.title = 'Ready in a moment';
    }
  }

  render(true);
  return {
    el,
    update(next) {
      model = next;
      render();
    },
    moved() {
      arming.reset();
    },
    destroy() {
      arming.destroy();
      el.remove();
    },
  };
}

export interface GhostCardModel {
  ghost: PlanGhost;
}

export function createPlanGhost(ctx: AppContext, initial: GhostCardModel): NodeView<GhostCardModel> {
  let model = initial;
  let printed = '';
  const body = h('div', { class: 'nd-body' });
  const foot = h('div', { class: 'nd-foot' });
  const el = h(
    'div',
    {
      class: ['nd-card', 'nd-ghost'],
      role: 'group',
      tabIndex: 0,
      dataset: { id: initial.ghost.id, kind: 'ghost' },
    },
    body,
    foot,
  );

  function render(force = false): void {
    const g = model.ghost;
    const pt = g.planTask;
    const print = fingerprint([g.id, g.change, g.taskId, pt.summary, pt.kind, pt.role, pt.scope, pt.note, g.deps]);
    if (!force && print === printed) return;
    printed = print;
    const kind = TASK_KIND[pt.kind] ?? { label: pt.kind, color: 'var(--color-slate-400)' };
    const write = pt.scope?.write ?? [];
    replace(
      body,
      h(
        'div',
        { class: 'nd-head', dataset: { dragHandle: '' } },
        badge(g.change === 'new' ? 'New' : 'Rework', g.change === 'new' ? 'info' : 'warn'),
        h('span', { class: 'pill nd-kind', ref: (k) => setVar(k, '--nd-kind', kind.color) }, kind.label),
        h('span', { class: 'nd-id mono', title: visible(pt.key) }, truncate(visible(pt.key), 32)),
        h('span', { class: 'spacer' }),
        pt.role ? h('span', { class: 'muted nd-role' }, truncate(visible(pt.role), 24)) : null,
      ),
      h(
        'p',
        { class: 'nd-summary', title: truncate(cleanText(pt.summary), 1000) },
        truncate(cleanText(pt.summary), 200),
      ),
      write.length
        ? h(
            'div',
            { class: 'nd-scope' },
            h('span', { class: 'nd-label' }, 'writes'),
            pills(write, 3, (glob) => pill(visible(glob), 'mono', visible(glob))),
          )
        : null,
    );
    replace(
      foot,
      h(
        'span',
        { class: 'muted nd-ghost-note' },
        g.change === 'rework' && g.taskId
          ? `Rework of ${shortId(g.taskId)}${pt.note ? `: ${truncate(cleanText(pt.note), 80)}` : ''}`
          : `Proposed in plan v${g.version}`,
      ),
      h('span', { class: 'spacer' }),
      actionButton('Review', 'eye', () => openModal(ctx, { kind: 'plan-review', id: g.goalId }), { action: 'review' }),
    );
    el.setAttribute(
      'aria-label',
      `Proposed ${g.change === 'new' ? 'new task' : 'rework'}: ${truncate(cleanText(pt.summary), 120)}`,
    );
  }

  render(true);
  return {
    el,
    update(next) {
      model = next;
      render();
    },
    destroy() {
      el.remove();
    },
  };
}
