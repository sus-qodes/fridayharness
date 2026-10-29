/**
 * The goal card (handoff Part 04 §2, plan §7.3): goal id, the request (or the planner's objective),
 * a status pill, the human's constraints as pills with the planner's inferred ones marked, a
 * progress bar (completed of total), the plan badge (version, a proposed revision waiting), the
 * integration state, and "Ready to land" once the goal is completed (FD-27).
 */
import type { GoalGroup } from '../model/board.js';
import { type AppContext, openModal } from '../shell/context.js';
import { button, h, replace, setVar, toggleClass } from '../ui/dom.js';
import { cleanText, plural, shortId, truncate } from '../ui/format.js';
import { badge, fingerprint, type NodeView, nodeIcon, pill, type Tone } from './common.js';

export interface GoalCardModel {
  group: GoalGroup;
}

const GOAL_TONE: Record<string, Tone> = { OPEN: 'info', ACTIVE: 'good', COMPLETED: 'good', CANCELLED: 'muted' };

/** The percentage shown on the bar (0 for a goal without tasks). */
export function progressPercent(p: { completed: number; total: number }): number {
  return p.total > 0 ? Math.round((p.completed / p.total) * 100) : 0;
}

/** "2 integrated · 1 conflicted", or null when nothing was integrated yet. */
export function integrationText(i: GoalGroup['integration']): string | null {
  const parts: string[] = [];
  if (i.integrated) parts.push(`${i.integrated} integrated`);
  if (i.conflicted) parts.push(`${i.conflicted} conflicted`);
  if (i.failed) parts.push(`${i.failed} failed`);
  if (i.not_needed) parts.push(`${i.not_needed} not needed`);
  return parts.length ? parts.join(' · ') : null;
}

export function createGoalNode(ctx: AppContext, initial: GoalCardModel): NodeView<GoalCardModel> {
  let model = initial;
  let printed = '';
  const body = h('div', { class: 'nd-body' });
  const foot = h('div', { class: 'nd-foot nd-goal-foot' });
  const land = () => openModal(ctx, { kind: 'land', id: model.group.goal.goal_id });
  const el = h(
    'div',
    {
      class: ['nd-card', 'nd-goal'],
      role: 'group',
      tabIndex: 0,
      dataset: { id: initial.group.id, kind: 'goal' },
      on: {
        keydown: (e) => {
          if (e.target === el && e.key === 'Enter' && model.group.goal.status === 'COMPLETED') {
            e.preventDefault();
            land();
          }
        },
      },
    },
    body,
    foot,
  );

  function render(force = false): void {
    const g = model.group;
    const goal = g.goal;
    const print = fingerprint([
      goal,
      g.progress,
      g.integration,
      g.active?.version,
      g.active?.status,
      g.proposed?.version,
      g.taskIds.length,
    ]);
    if (!force && print === printed) return;
    printed = print;

    const text = goal.objective || goal.request;
    const constraints = [
      ...goal.constraints.map((c) => ({ c, inferred: false })),
      ...goal.inferred_constraints.map((c) => ({ c, inferred: true })),
    ];
    const shown = constraints.slice(0, 4);
    const pct = progressPercent(g.progress);
    const bar = h('div', { class: 'nd-progress-fill' });
    setVar(bar, '--nd-progress', `${pct}%`);

    replace(
      body,
      h(
        'div',
        { class: 'nd-head', dataset: { dragHandle: '' } },
        nodeIcon('target', 14),
        h('span', { class: 'nd-id mono', title: goal.goal_id }, shortId(goal.goal_id)),
        h('span', { class: 'spacer' }),
        badge(goal.status, GOAL_TONE[goal.status] ?? 'muted'),
      ),
      h(
        'p',
        { class: 'nd-summary nd-goal-text', title: truncate(cleanText(goal.request), 2000) },
        truncate(cleanText(text), 300),
      ),
      constraints.length
        ? h(
            'div',
            { class: 'nd-constraints', aria: { label: 'Constraints' } },
            shown.map(({ c, inferred }) =>
              pill(
                inferred
                  ? [h('span', { class: 'nd-inferred-mark' }, 'inferred'), truncate(cleanText(c), 60)]
                  : truncate(cleanText(c), 60),
                inferred ? 'nd-pill-inferred' : 'nd-pill-constraint',
                inferred ? `Inferred by the planner: ${truncate(cleanText(c), 300)}` : truncate(cleanText(c), 300),
              ),
            ),
            constraints.length > shown.length ? pill(`+${constraints.length - shown.length}`, 'nd-pill-more') : null,
          )
        : null,
      h(
        'div',
        { class: 'nd-progress-row' },
        h(
          'div',
          {
            class: 'nd-progress',
            role: 'progressbar',
            aria: { valuemin: 0, valuemax: 100, valuenow: pct, label: 'Goal progress' },
          },
          bar,
        ),
        h(
          'span',
          { class: 'nd-progress-text' },
          `${pct}% (${g.progress.completed} of ${plural(g.progress.total, 'task')})`,
        ),
      ),
    );

    const integration = integrationText(g.integration);
    replace(
      foot,
      g.active
        ? badge(`Plan v${g.active.version}`, 'muted', truncate(cleanText(g.active.summary), 300))
        : badge('No plan yet', 'muted'),
      g.proposed ? badge(`v${g.proposed.version} proposed`, 'warn', 'A plan version waits for your review') : null,
      integration
        ? h(
            'span',
            {
              class: ['nd-integration', (g.integration.conflicted || g.integration.failed) > 0 && 'nd-integration-bad'],
            },
            nodeIcon('branch', 11),
            integration,
          )
        : null,
      h('span', { class: 'spacer' }),
      goal.status === 'COMPLETED'
        ? button([nodeIcon('check', 13), 'Ready to land'], land, {
            class: 'btn btn-primary nd-land',
            title: `Land friday/goal-${goal.goal_id}`,
            dataset: { action: 'land' },
          })
        : null,
    );
    el.dataset.status = goal.status;
    el.setAttribute('aria-label', `Goal ${goal.status.toLowerCase()}: ${truncate(cleanText(text), 120)}`);
    toggleClass(el, 'nd-goal-done', goal.status === 'COMPLETED');
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
