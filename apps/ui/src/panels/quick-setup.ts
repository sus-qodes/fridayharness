/**
 * Two switches a person turns on from Settings instead of a terminal (2026-11-16): planning through
 * the installed Claude Code, and checking an agent's work automatically when it finishes. Each sets
 * config.yaml through the daemon (`POST config/settings`), then takes the step Friday's rules still
 * require, in the way the platform offers it: this machine's approval to spend and a restart for
 * the planner, this clone's trust for automatic verification. Nothing here skips one of them.
 */
import type { UiSnapshot } from '@friday/protocol';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { badge, copyLine, input, note, plain, type Teardown } from './common.js';
import { readLoosening } from './settings.js';

/** The daily budget offered for planning through Claude Code, in dollars. */
export const CLAUDE_CODE_BUDGET = 2;

/** Where planning through Claude Code stands, from the board. */
export function claudeCodePlanning(board: UiSnapshot | null | undefined): 'ready' | 'restart' | 'approve' | 'off' {
  const brain = board?.brain ?? null;
  const restart = board?.config.changes?.restart_needed ?? [];
  if (brain?.provider === 'claude-code' && brain.planner_available) return 'ready';
  // config.yaml names it, but Friday reads the planner's provider when it starts.
  if (restart.some((k) => k === 'master_brain.provider' || k.startsWith('providers.claude-code'))) return 'restart';
  if (brain?.provider === 'claude-code') return 'approve';
  return 'off';
}

/** Where automatic verification stands: on, asked for but not yet trusted here, or off. */
export function autoVerification(board: UiSnapshot | null | undefined): 'on' | 'untrusted' | 'off' {
  if (board?.verification.auto_on_completion) return 'on';
  return board?.policy_untrusted ? 'untrusted' : 'off';
}

/** "Plan with Claude Code": no API key, the installed Claude Code's own sign-in. */
export function plannerQuickSetup(ctx: AppContext, td: Teardown): HTMLElement {
  const native = ctx.platform.desktop ?? null;
  let budget = CLAUDE_CODE_BUDGET;
  let busy = false;
  const budgetInput = input({
    type: 'number',
    min: '0',
    step: '1',
    value: String(budget),
    class: 'input pn-qs-budget',
  });
  budgetInput.addEventListener('input', () => {
    const v = Number(budgetInput.value);
    if (budgetInput.value.trim() && Number.isFinite(v)) budget = Math.min(100_000, Math.max(0, v));
  });
  const body = h('div', { class: 'pn-qs-body' });
  const el = h(
    'div',
    { class: 'pn-quick-setup', dataset: { setup: 'planner' } },
    h('div', { class: 'pn-qs-title' }, 'Plan with your Claude Code sign-in'),
    note(
      'Friday writes the plan for each goal using the Claude Code installed on this computer, signed in as it already is: no API key. Plans still wait for your approval.',
    ),
    body,
  );

  async function turnOn() {
    if (busy) return;
    busy = true;
    render();
    const amount = budget;
    // 1. The project asks for it (config.yaml).
    const set = await ctx.act('Plan with Claude Code', () =>
      ctx.api.editSettings({
        'master_brain.provider': 'claude-code',
        'providers.claude-code.allow_remote': true,
        'providers.claude-code.daily_budget_usd': amount,
      }),
    );
    // 2. This machine allows it to spend (the shell's own dialog), then 3. Friday restarts.
    if (set && native) {
      const allowed = await ctx.act('Allow planning to spend', () => native.allowSpending(amount, 'claude-code'));
      if (allowed) await ctx.act('Restart Friday', () => native.restart(), 'Friday restarts with the new planner');
    }
    busy = false;
    if (!td.done) {
      ctx.refresh();
      render();
    }
  }

  function render() {
    const state = claudeCodePlanning(ctx.store.select('board'));
    if (state === 'ready') {
      replace(
        body,
        h('div', { class: 'row' }, badge('on', 'good'), h('span', null, 'The Master Brain plans through Claude Code.')),
      );
      return;
    }
    const start = button([icon('check', 14), 'Use Claude Code to plan'], () => void turnOn(), {
      class: 'btn btn-primary',
      disabled: busy,
    });
    const restart = native
      ? button([icon('rework', 14), 'Restart Friday'], () => void ctx.act('Restart Friday', () => native.restart()), {
          class: 'btn btn-primary',
        })
      : null;
    const terminal = (cmd: string) => h('li', null, 'In a terminal in the project folder:', copyLine(ctx, cmd));
    replace(
      body,
      state === 'restart'
        ? h(
            'div',
            null,
            h(
              'div',
              { class: 'row' },
              badge('restart needed', 'warn'),
              h('span', null, 'Friday picks up the new planner when it restarts.'),
            ),
            restart
              ? h('div', { class: 'pn-actions pn-actions-start' }, restart)
              : note('Restart Friday (its tray icon, or stop and run it again).'),
          )
        : h(
            'div',
            null,
            h('label', { class: 'pn-qs-row' }, h('span', null, 'Daily spending limit (USD)'), budgetInput),
            h('div', { class: 'pn-actions pn-actions-start' }, start),
            native
              ? note('Your computer asks you to allow the spending, then to restart Friday.')
              : h(
                  'ol',
                  { class: 'pn-steps' },
                  h('li', null, 'Click the button above: the project asks for it.'),
                  terminal(`friday brain allow-remote --provider claude-code --budget ${budget}`),
                  h('li', null, 'Restart Friday.'),
                ),
          ),
    );
  }

  render();
  td.add(ctx.store.subscribe('board', () => render()));
  return el;
}

/** "Check the work automatically": verification runs as soon as an agent claims a task. */
export function autoVerifySwitch(ctx: AppContext, td: Teardown): HTMLElement {
  let busy = false;
  const body = h('div', { class: 'pn-qs-body' });
  const el = h(
    'div',
    { class: 'pn-quick-setup', dataset: { setup: 'verify' } },
    h('div', { class: 'pn-qs-title' }, 'Check the work automatically'),
    note(
      "When an agent says it is done, Friday runs the project's checks at once instead of waiting for you to click Verify. They run code the agent wrote, so Friday asks you to trust this setting first.",
    ),
    body,
  );

  /** This clone's trust in the project's loosening, through the platform's confirmation. */
  async function trust() {
    const view = await ctx.act('Read the policy', () => ctx.api.policy());
    const p = readLoosening(view ?? null);
    if (!p.hash || p.trusted) return;
    // The desktop shows its own dialog (`confirm_and_send`); a browser asks here.
    if (!ctx.platform.desktop) {
      const ok = await ctx.confirm({
        title: 'Trust these settings on this computer?',
        body: [
          ...p.items.map(
            (l) => `${plain(l.setting, 120)}: ${plain(l.from, 60)} → ${plain(l.to, 120)} (${plain(l.source, 120)})`,
          ),
          'Anyone who can change the project files chose these settings.',
        ],
        confirmLabel: 'Trust them',
        danger: true,
      });
      if (!ok) return;
    }
    await ctx.act(
      'Trust the setting',
      () => ctx.api.trustPolicy(p.hash as string),
      'Work is now checked automatically',
    );
  }

  async function turnOn() {
    if (busy) return;
    busy = true;
    render();
    const set = await ctx.act('Check the work automatically', () =>
      ctx.api.editSettings({ 'verification.auto_on_completion': true }),
    );
    if (set) await trust();
    busy = false;
    if (!td.done) {
      ctx.refresh();
      render();
    }
  }

  function render() {
    const state = autoVerification(ctx.store.select('board'));
    replace(
      body,
      state === 'on'
        ? h(
            'div',
            { class: 'row' },
            badge('on', 'good'),
            h('span', null, 'Finished work is checked as soon as it is claimed.'),
          )
        : h(
            'div',
            { class: 'pn-actions pn-actions-start' },
            button(
              [icon('check', 14), state === 'untrusted' ? 'Trust and turn on' : 'Turn on'],
              () => void (state === 'untrusted' ? trust().then(() => ctx.refresh()) : turnOn()),
              { class: 'btn btn-primary', disabled: busy },
            ),
          ),
    );
  }

  render();
  td.add(ctx.store.subscribe('board', () => render()));
  return el;
}
