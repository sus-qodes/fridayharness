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
/** How long after a Tab key a focus counts as the user moving it there. */
const USER_FOCUS_MS = 600;

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
  let last: { x: number; y: number } | null = null;
  let lastTab = Number.NEGATIVE_INFINITY;
  const onTab = (e: KeyboardEvent) => {
    if (e.key === 'Tab') lastTab = performance.now();
  };
  document.addEventListener('keydown', onTab, true);
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
        // Only a real move counts, and focus only right after a Tab: a click's own focus never arms.
        pointermove: (e) => {
          const p = e as PointerEvent;
          const moved =
            p.movementX !== 0 || p.movementY !== 0 || (last !== null && (last.x !== p.clientX || last.y !== p.clientY));
          last = { x: p.clientX, y: p.clientY };
          if (moved) arming.engage();
        },
        pointerleave: () => {
          last = null;
        },
        focusin: () => {
          if (performance.now() - lastTab <= USER_FOCUS_MS) arming.engage();
        },
      },
    },
    body,
    controls,
    notePanel,
  );

  const decide = (run: () => unknown) => (): unknown => (arming.armed ? run() : undefined);

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
    // A plan is approved where every task's instructions are shown in full: the review (review M9i).
    const approveBtn = actionButton(
      'Review and approve',
      'check',
      () => openModal(ctx, { kind: 'plan-review', id: model.goalId }),
      {
        cls: 'nd-act-primary',
        action: 'review',
        title: 'Open the plan with every task in full, the diff, and Approve',
      },
    );
    const rejectBtn = actionButton('Reject…', 'cross', decide(openNote), { cls: 'nd-act-danger', action: 'reject' });
    decisions.push(rejectBtn);
    replace(controls, approveBtn, rejectBtn);
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
      document.removeEventListener('keydown', onTab, true);
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
    // A new task's note is the ceiling cut (plan M12.2): the reviewer reads that the plan asked
    // for more than the role may hold, here and in full in the review.
    const note = pt.note ? cleanText(pt.note) : '';
    replace(
      foot,
      h(
        'span',
        { class: 'muted nd-ghost-note', ...(note ? { title: truncate(note, 1000) } : {}) },
        g.change === 'rework' && g.taskId
          ? `Rework of ${shortId(g.taskId)}${note ? `: ${truncate(note, 80)}` : ''}`
          : `Proposed in plan v${g.version}${note ? `: ${truncate(note, 80)}` : ''}`,
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
