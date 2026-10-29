/**
 * The goal card (handoff Part 04 §2, plan §7.3): goal id, the request (or the planner's objective),
 * a status pill, the human's constraints as pills with the planner's inferred ones marked, a
 * progress bar (completed of total), the plan badge (version, a proposed revision waiting), the
 * integration state, and "Ready to land" once the goal is completed (FD-27). An open goal without
 * a plan, active or proposed, offers "Write the plan" and, while a planner is ready, "Let the
 * Master Brain plan": the card is the way back to a plan after its editor was closed or the page
 * reloaded. Once the goal has tasks, one line says what Friday did for it (plan M12.7), read from
 * the goal detail's `summary` and refreshed when the goal's tasks change; the full set, one row per
 * fact, is the line's tooltip and the landing dialog's "What Friday did".
 */
import type { GoalSummary, UiSnapshot } from '@friday/protocol';
import type { GoalGroup } from '../model/board.js';
import { type AppContext, openModal } from '../shell/context.js';
import { button, h, replace, setVar, toggleClass } from '../ui/dom.js';
import { cleanText, compact, plural, shortId, truncate, usd } from '../ui/format.js';
import { actionButton, badge, fingerprint, type NodeView, nodeIcon, pill, type Tone } from './common.js';

export interface GoalCardModel {
  group: GoalGroup;
}

const GOAL_TONE: Record<string, Tone> = { OPEN: 'info', ACTIVE: 'good', COMPLETED: 'good', CANCELLED: 'muted' };

/** "1 claim" / "3 claims". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 of 2 attempts". */
const attemptsOf = (n: number, h: GoalSummary['hosts']) => `(${n} of ${count(h.attempts, 'attempt')})`;

/**
 * "184k tokens, $0.42 (2 of 2 attempts)": what the hosts reported, as they reported it, with how
 * many of the goal's attempts the figures come from; the cost gets its own count when fewer hosts
 * named one. Null when no host reported anything.
 */
export function hostsWords(h: GoalSummary['hosts']): string | null {
  if (h.tokens === null && h.cost_usd === null) return null;
  const same = h.tokens === null || h.cost_usd === null || h.tokens_reporters === h.cost_reporters;
  if (same) {
    const parts = [
      h.tokens === null ? null : `${compact(h.tokens)} tokens`,
      h.cost_usd === null ? null : usd(h.cost_usd),
    ];
    return `${parts.filter(Boolean).join(', ')} ${attemptsOf(h.tokens === null ? h.cost_reporters : h.tokens_reporters, h)}`;
  }
  return `${compact(h.tokens as number)} tokens ${attemptsOf(h.tokens_reporters, h)}, ${usd(h.cost_usd as number)} ${attemptsOf(h.cost_reporters, h)}`;
}

/** ", reworked" when every refused claim was reworked, ", 1 reworked" when fewer; nothing when none. */
const followed = (n: number, of: number, word: string) => (n === 0 ? '' : n === of ? `, ${word}` : `, ${n} ${word}`);

/**
 * The card's one line: the facts with something to say, in the words of plan M12.7 ("3 of 3 tasks
 * verified · 1 claim refused by the checks, reworked · 2 actions held for you · 1 session recovered
 * · hosts reported 184k tokens, $0.42 (2 of 2 attempts)"). A count of zero is left out of the line;
 * a figure nobody reported is never written as 0. Null while the goal has no work on record.
 */
export function goalSummaryLine(s: GoalSummary): string | null {
  if (s.tasks.total === 0 && s.hosts.attempts === 0 && s.planning.calls === 0) return null;
  const parts: string[] = [];
  if (s.tasks.total > 0) parts.push(`${s.tasks.verified} of ${plural(s.tasks.total, 'task')} verified`);
  if (s.claims_refused > 0) {
    parts.push(
      `${count(s.claims_refused, 'claim')} refused by the checks${followed(s.reworked, s.claims_refused, 'reworked')}`,
    );
  }
  if (s.held_for_human > 0) parts.push(`${count(s.held_for_human, 'action')} held for you`);
  if (s.refused_by_policy > 0) parts.push(`${count(s.refused_by_policy, 'action')} refused by policy`);
  if (s.sessions_lost > 0) {
    parts.push(
      s.sessions_recovered === s.sessions_lost
        ? `${count(s.sessions_recovered, 'session')} recovered`
        : s.sessions_recovered === 0
          ? `${count(s.sessions_lost, 'session')} lost`
          : `${s.sessions_recovered} of ${s.sessions_lost} sessions recovered`,
    );
  }
  const hosts = hostsWords(s.hosts);
  if (hosts) parts.push(`hosts reported ${hosts}`);
  if (s.planning.calls > 0) {
    parts.push(
      `Friday planned in ${count(s.planning.calls, 'call')}${s.planning.cost_usd === null ? '' : `, ${usd(s.planning.cost_usd)}`}`,
    );
  }
  return parts.join(' · ');
}

/**
 * The full set, one row per fact, for the landing dialog and the line's tooltip. Every row is a
 * count from Friday's records, so a zero is a fact and reads "none"; a figure nobody reported is
 * left out: no token figure for a goal whose hosts reported nothing, no planning row for a plan a
 * human wrote. Empty while the goal has no work on record.
 */
export function goalSummaryRows(s: GoalSummary): { label: string; value: string }[] {
  if (s.tasks.total === 0 && s.hosts.attempts === 0 && s.planning.calls === 0) return [];
  const none = (n: number, words: string) => (n === 0 ? 'none' : words);
  const rows = [
    { label: 'Tasks verified', value: `${s.tasks.verified} of ${s.tasks.total}` },
    {
      label: 'Claims refused by the checks',
      value: none(s.claims_refused, `${s.claims_refused}${followed(s.reworked, s.claims_refused, 'reworked')}`),
    },
    { label: 'Actions held for you', value: none(s.held_for_human, String(s.held_for_human)) },
    { label: 'Actions refused by policy', value: none(s.refused_by_policy, String(s.refused_by_policy)) },
    {
      label: 'Sessions lost',
      value: none(s.sessions_lost, `${s.sessions_lost}${followed(s.sessions_recovered, s.sessions_lost, 'recovered')}`),
    },
  ];
  if (s.hosts.attempts > 0) {
    rows.push({ label: 'Hosts reported', value: hostsWords(s.hosts) ?? `nothing ${attemptsOf(0, s.hosts)}` });
  }
  if (s.planning.calls > 0) {
    rows.push({
      label: "Friday's planning",
      value: `${count(s.planning.calls, 'call')}${s.planning.cost_usd === null ? '' : `, ${usd(s.planning.cost_usd)}`}`,
    });
  }
  return rows;
}

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

/** What an open goal without a plan can do about it (null for any other goal). */
export function planNeed(
  g: Pick<GoalGroup, 'goal' | 'active' | 'proposed'>,
  board: Pick<UiSnapshot, 'brain' | 'brain_jobs'> | null,
): { planning: boolean; brain: boolean } | null {
  if (g.goal.status !== 'OPEN' || g.active || g.proposed) return null;
  const planning = (board?.brain_jobs ?? []).some(
    (j) => j.goal_id === g.goal.goal_id && (j.kind === 'plan' || j.kind === 'replan'),
  );
  return { planning, brain: !planning && !!board?.brain?.planner_available };
}

export function createGoalNode(ctx: AppContext, initial: GoalCardModel): NodeView<GoalCardModel> {
  let model = initial;
  let printed = '';
  let destroyed = false;
  // What Friday did, read from the goal detail once the goal has tasks and again when they change.
  let summary: GoalSummary | null = null;
  let summaryPrint = '';
  const body = h('div', { class: 'nd-body' });
  const foot = h('div', { class: 'nd-foot nd-goal-foot' });
  const did = h('p', { class: ['nd-note-text', 'muted', 'nd-goal-did'], dataset: { role: 'did' } });

  /** The line and its tooltip from the summary on hand; hidden while there is nothing to say. */
  function renderDid(): void {
    const line = summary ? goalSummaryLine(summary) : null;
    if (!line) {
      did.hidden = true;
      did.textContent = '';
      did.removeAttribute('title');
      return;
    }
    did.hidden = false;
    did.textContent = line;
    did.title = goalSummaryRows(summary as GoalSummary)
      .map((r) => `${r.label}: ${r.value}`)
      .join('\n');
  }

  /** Reads the summary when the goal's work changed since the last read; a late answer for older work is dropped. */
  function loadSummary(print: string): void {
    if (print === summaryPrint) return;
    summaryPrint = print;
    const goalId = model.group.goal.goal_id;
    void (async () => {
      try {
        const detail = await ctx.api.goal(goalId);
        if (destroyed || print !== summaryPrint) return;
        summary = detail.summary ?? null;
      } catch {
        // The card keeps the last line it had; the landing dialog says when the read fails.
        if (destroyed || print !== summaryPrint) return;
      }
      renderDid();
    })();
  }
  const land = () => openModal(ctx, { kind: 'land', id: model.group.goal.goal_id });
  const writePlan = () => openModal(ctx, { kind: 'plan-editor', id: model.group.goal.goal_id, mode: 'first' });
  const brainPlan = async () => {
    const goalId = model.group.goal.goal_id;
    const r = await ctx.act('Let the Master Brain plan', () => ctx.api.replan(goalId));
    if (!r) return;
    ctx.refresh();
    const result = typeof r.result === 'string' ? r.result : '';
    if (result.startsWith('proposed'))
      ctx.toast({ kind: 'success', text: 'The Master Brain proposed a plan: review it on the board' });
    else
      ctx.toast({
        kind: 'warn',
        text: 'The Master Brain proposed no plan',
        ...(result ? { detail: truncate(cleanText(result), 300) } : {}),
      });
  };
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
    const board = ctx.store.select('board');
    // The goal's work as the board knows it: a task's status or its last change moves the line,
    // which the card's own fingerprint below does not see (a refused claim leaves the progress as it was).
    if (g.progress.total > 0) {
      const tasks = (board?.tasks ?? []).filter((t) => t.goal_id === goal.goal_id);
      loadSummary(fingerprint([goal.status, goal.updated_at, g.progress, tasks.map((t) => [t.status, t.updated_at])]));
    }
    const need = planNeed(g, board);
    const print = fingerprint([
      goal,
      g.progress,
      g.integration,
      g.active?.version,
      g.active?.status,
      g.proposed?.version,
      g.taskIds.length,
      need,
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
      did,
    );
    renderDid();

    const integration = integrationText(g.integration);
    replace(
      foot,
      g.active
        ? badge(`Plan v${g.active.version}`, 'muted', truncate(cleanText(g.active.summary), 300))
        : need?.planning
          ? badge('Master Brain planning', 'info', 'The Master Brain is writing a plan for this goal')
          : need
            ? null
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
      need
        ? actionButton('Write the plan', 'goal', writePlan, {
            cls: 'nd-act-primary',
            action: 'write-plan',
            title: 'Write this goal’s plan in the plan editor',
          })
        : null,
      need?.brain
        ? actionButton('Let the Master Brain plan', 'bolt', brainPlan, {
            action: 'brain-plan',
            busyLabel: 'Planning…',
            title: 'Ask the Master Brain for a plan; you review it before anything starts',
          })
        : null,
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
      destroyed = true;
      el.remove();
    },
  };
}
