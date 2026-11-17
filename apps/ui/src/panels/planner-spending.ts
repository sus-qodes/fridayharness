/**
 * What planning may spend, changed after it was allowed (2026-11-17).
 *
 * Once a person had allowed planning to spend, the page showed the limit and offered nothing more:
 * a different limit meant a terminal (`friday brain allow-remote --budget`), and so did taking the
 * approval back (`friday brain deny-remote`). This card says the limit that holds and what was
 * spent today, changes the limit, and turns spending off.
 *
 * Friday's rule stands: allowing a computer to spend is that computer's own act. A new limit goes
 * through the desktop's own dialog (`allowSpending`), as the first one did; a browser is given the
 * command. Taking the approval back only tightens, so the daemon takes it from the page
 * (`POST brain/deny-remote`), after a confirmation here.
 *
 * The limit is a person's own, kept on their computer. The project has one too, in the shared
 * config.yaml, and the lower of the two holds: said when a person asks for more, with the way to
 * raise the project's (shared, and read when Friday starts).
 */
import type { BrainStatusView } from '@friday/protocol';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { usd } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { copyLine, input, linkButton, note, restartBlocked, type Teardown } from './common.js';
import { clampNumber } from './settings.js';

export type Spending = NonNullable<BrainStatusView['spending']>;

/** The limit that holds: the lower of this computer's and the project's. */
export function limitInForce(s: Spending): number {
  return Math.min(s.yours_usd ?? Number.POSITIVE_INFINITY, s.project_usd);
}

/** Whose planner it is, in a sentence. */
function whose(s: Spending): string {
  return s.provider === 'claude-code' ? 'through your Claude Code sign-in' : 'with your Anthropic key';
}

const PROVIDERS = new Set(['anthropic', 'claude-code']);

/**
 * The card, or null where there is nothing to change: no planner that spends (a model on this
 * machine, plans written by hand), an older daemon that does not say, or spending not allowed here
 * yet (the steps that allow it are their own card).
 */
export function plannerSpendingCard(
  ctx: AppContext,
  td: Teardown,
  brain: BrainStatusView | null | undefined,
): HTMLElement | null {
  const said = brain?.spending;
  if (!brain || !said?.approved || !brain.remote || !PROVIDERS.has(said.provider)) return null;
  const s: Spending = said;
  const provider = s.provider as 'anthropic' | 'claude-code';
  const native = ctx.platform.desktop ?? null;
  const inForce = limitInForce(s);
  let amount = inForce;
  let busy = false;
  const amountInput = input({
    type: 'number',
    min: '0',
    step: '1',
    value: String(amount),
    class: 'input pn-qs-budget',
    aria: { label: 'New daily limit in dollars' },
  });
  const under = h('div', { class: 'pn-spend-under' });
  const change = button([icon('check', 14), 'Change the limit…'], () => void changeLimit(), { class: 'btn' });
  const off = button('Turn spending off', () => void turnOff(), { class: 'btn btn-danger' });

  amountInput.addEventListener('input', () => {
    const v = clampNumber(amountInput.value, 0, 100_000);
    if (v !== null) amount = v;
    renderUnder();
  });

  /** A limit above the project's does not hold: said, with the way to raise the project's. */
  function renderUnder() {
    const over = amount > s.project_usd;
    replace(
      under,
      over
        ? h(
            'div',
            { class: 'pn-qs-limit muted', dataset: { role: 'project-limit' } },
            `The project’s own limit is ${usd(s.project_usd)} a day: Friday holds planning to that, whatever you allow here. `,
            linkButton(`Raise the project’s limit to ${usd(amount)}`, () => void raiseProject(amount)),
          )
        : null,
      native
        ? null
        : h(
            'div',
            { class: 'pn-spend-terminal' },
            note('In a browser, a new limit is set in a terminal in the project folder:'),
            copyLine(ctx, `friday brain allow-remote --provider ${provider} --budget ${amount}`),
          ),
    );
    change.hidden = !native;
    change.disabled = busy || amount === (s.yours_usd ?? Number.NaN);
  }

  async function changeLimit() {
    if (!native || busy) return;
    busy = true;
    renderUnder();
    const wanted = amount;
    // The shell asks in its own dialog; a cancel answers false, and nothing changed.
    const done = await ctx.act('Change the spending limit', () => native.allowSpending(wanted, provider));
    busy = false;
    if (done) {
      ctx.toast({
        kind: 'success',
        text:
          wanted > s.project_usd
            ? `You allow ${usd(wanted)} a day; the project’s limit of ${usd(s.project_usd)} holds`
            : `Planning may spend up to ${usd(wanted)} a day on this computer`,
      });
      ctx.refresh();
    }
    if (!td.done) renderUnder();
  }

  /** The project's own limit: the team's setting, in the shared file, read when Friday starts. */
  async function raiseProject(to: number) {
    if (busy) return;
    const ok = await ctx.confirm({
      title: `Raise the project’s limit to ${usd(to)} a day?`,
      body: [
        'The project’s limit is in .friday/config.yaml, which your team shares: it holds for everyone who plans in this project, each within what they allow on their own computer. Commit the file to share the change.',
        'Friday reads it when it starts: the new limit holds after a restart.',
      ],
      confirmLabel: 'Raise it',
    });
    if (!ok) return;
    busy = true;
    const set = await ctx.act(
      'Raise the project’s limit',
      () => ctx.api.editSettings({ [`providers.${provider}.daily_budget_usd`]: to }),
      `The project’s limit is ${usd(to)} a day once Friday restarts`,
    );
    busy = false;
    if (set && native && !restartBlocked(ctx)) {
      await ctx.act(
        'Restart Friday',
        () => native.restart(),
        (done) => (done ? 'Friday restarts with the new limit' : ''),
      );
    }
    if (!td.done) {
      ctx.refresh();
      renderUnder();
    }
  }

  async function turnOff() {
    if (busy) return;
    const ok = await ctx.confirm({
      title: 'Turn planning’s spending off on this computer?',
      body: [
        `Friday stops planning ${whose(s)} until you allow it again. Goals wait for a plan you write yourself.`,
        'Agents are not affected: what an agent spends is its own limit (Agents → Edit).',
      ],
      confirmLabel: 'Turn it off',
      danger: true,
    });
    if (!ok) return;
    busy = true;
    off.disabled = true;
    const r = await ctx.act(
      'Turn spending off',
      () => ctx.api.denySpending(provider),
      'Planning may no longer spend on this computer',
    );
    busy = false;
    if (td.done) return;
    off.disabled = false;
    if (r) ctx.refresh();
  }

  const el = h(
    'div',
    { class: 'pn-quick-setup pn-spending', dataset: { setup: 'spending' } },
    h('div', { class: 'pn-qs-title' }, 'What planning may spend'),
    h(
      'div',
      { class: 'row', dataset: { role: 'limit' } },
      h('span', null, `Up to ${usd(inForce)} a day ${whose(s)}, on this computer.`),
      h('span', { class: 'muted' }, `Spent today: ${usd(brain.spent_today_usd)}.`),
    ),
    s.yours_usd !== null && s.yours_usd > s.project_usd
      ? note(`You allowed ${usd(s.yours_usd)}; the project’s own limit of ${usd(s.project_usd)} holds.`)
      : null,
    note(
      'When a day’s limit is reached, Friday stops planning and asks you. This limit is yours, kept on this computer.',
    ),
    h('label', { class: 'pn-qs-row' }, h('span', null, 'Daily limit (USD)'), amountInput),
    under,
    h('div', { class: 'pn-actions pn-actions-start' }, change, off),
  );
  renderUnder();
  return el;
}
