/**
 * Two switches a person turns on from Settings instead of a terminal (2026-11-16): planning through
 * the installed Claude Code, and checking an agent's work automatically when it finishes. Each takes
 * the steps Friday's rules still require, in the way the platform offers them. Nothing here skips
 * one of them.
 *
 * Planning (2026-11-17): how a person plans is theirs, so it is kept on their machine
 * (`POST brain/planner-choice`), not in the tracked config.yaml, where one person's choice switched
 * every teammate's planner. The one thing that stays the project's is whether it allows planning
 * through Claude Code at all (`providers.claude-code.allow_remote`): turning that on is asked first
 * and said to be shared. Then this machine's approval to spend (the shell's own dialog), and a
 * restart only when the running planner is another one. Claude Code that Friday did not find is said
 * before anything is changed, so the switch no longer restarts Friday into the same question.
 *
 * Automatic verification: sets `verification.auto_on_completion`, then asks for this clone's
 * trust. Its state is read from that setting itself (`verification.auto_requested`), never from
 * whether some other setting of the project waits for trust.
 */
import type { BrainStatusView, UiSnapshot } from '@friday/protocol';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { badge, copyLine, input, linkButton, note, plain, restartBlocked, type Teardown } from './common.js';
import { readLoosening } from './settings.js';

/** The daily budget offered for planning through Claude Code, in dollars. */
export const CLAUDE_CODE_BUDGET = 2;

const AUTO_VERIFY = 'verification.auto_on_completion';

/** The planner this person (or, when they chose none, the project) wants; the running one on an older daemon. */
function wantedPlanner(brain: BrainStatusView | null): string | null {
  return brain?.choice?.wanted ?? brain?.provider ?? null;
}

/**
 * Where planning through Claude Code stands, from the board: `ready`; `restart`, it is chosen and
 * Friday still runs another planner (or the project's settings for it changed since Friday
 * started); `missing`, it is chosen and Friday did not find Claude Code; `approve`, it runs and
 * this machine or the project has not allowed it yet; `off`.
 */
export function claudeCodePlanning(
  board: UiSnapshot | null | undefined,
): 'ready' | 'restart' | 'missing' | 'approve' | 'off' {
  const brain = board?.brain ?? null;
  const restart = board?.config.changes?.restart_needed ?? [];
  const wanted = wantedPlanner(brain);
  if (wanted !== 'claude-code') return 'off';
  if (brain?.provider !== 'claude-code') return 'restart';
  if (brain.planner_available) return 'ready';
  if (brain.claude_code && !brain.claude_code.found) return 'missing';
  // config.yaml allows it now, and the planner read its settings when Friday started.
  if (restart.some((k) => k === 'master_brain.provider' || k.startsWith('providers.claude-code'))) return 'restart';
  return 'approve';
}

/**
 * Where automatic verification stands: `on` (in force), `untrusted` (config.yaml asks for it and
 * this clone has not trusted it), or `off`. An older daemon does not say whether it is asked for:
 * then it reads `off`, and turning it on sets it again, which changes nothing.
 */
export function autoVerification(board: UiSnapshot | null | undefined): 'on' | 'untrusted' | 'off' {
  if (board?.verification.auto_on_completion) return 'on';
  return board?.verification.auto_requested === true ? 'untrusted' : 'off';
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
  const body = h('div', { class: 'pn-qs-body' });
  const limitNote = h('div', { class: 'pn-qs-limit muted', hidden: true });
  budgetInput.addEventListener('input', () => {
    const v = Number(budgetInput.value);
    if (budgetInput.value.trim() && Number.isFinite(v)) budget = Math.min(100_000, Math.max(0, v));
    renderLimit();
  });
  const el = h(
    'div',
    { class: 'pn-quick-setup', dataset: { setup: 'planner' } },
    h('div', { class: 'pn-qs-title' }, 'Plan with your Claude Code sign-in'),
    note(
      'Friday writes the plan for each goal using the Claude Code installed on this computer, signed in as it already is: no API key. Plans still wait for your approval. This is your own choice, kept on this computer.',
    ),
    body,
  );
  const brainNow = () => ctx.store.select('board')?.brain ?? null;

  /** The project's own daily limit holds whatever a person allows themselves. */
  function renderLimit() {
    const cap = brainNow()?.claude_code?.project_budget_usd;
    const over = typeof cap === 'number' && budget > cap;
    limitNote.hidden = !over;
    limitNote.textContent = over
      ? `The project's own limit is $${cap} a day: Friday holds planning to that, whatever you allow here.`
      : '';
  }

  async function restart(why: string) {
    if (!native || restartBlocked(ctx)) return;
    // A cancelled restart answers false: only a restart that happened says so.
    await ctx.act(
      'Restart Friday',
      () => native.restart(),
      (done) => (done ? why : ''),
    );
  }

  async function turnOn() {
    if (busy) return;
    const cc = brainNow()?.claude_code;
    // Friday did not find Claude Code: nothing is changed for a planner that cannot run.
    if (cc && !cc.found) return;
    busy = true;
    render();
    try {
      const amount = budget;
      let sharedChanged = false;
      // 1. The project allows it: the one setting of this that the team shares, asked first.
      if (!cc?.allowed) {
        const ok = await ctx.confirm({
          title: 'Allow planning through Claude Code in this project?',
          body: [
            'To plan, Friday sends the goal and a summary of the project to Claude, through the Claude Code installed here.',
            'Whether a project allows that is the project’s own setting, in .friday/config.yaml, which your team shares. Turning it on changes that file: commit it to share it.',
          ],
          confirmLabel: 'Allow it for this project',
        });
        if (!ok) return;
        const set = await ctx.act('Allow planning through Claude Code', () =>
          ctx.api.editSettings({ 'providers.claude-code.allow_remote': true }),
        );
        if (!set) return;
        sharedChanged = set.changed.length > 0;
      }
      // 2. This person plans with it: kept on this computer.
      const chosen = await ctx.act('Plan with Claude Code', () => ctx.api.choosePlanner('claude-code'));
      if (!chosen) return;
      if (!native) return;
      // 3. This machine allows it to spend (the shell's own dialog), unless it already has.
      if (!cc?.approved) {
        const allowed = await ctx.act('Allow planning to spend', () => native.allowSpending(amount, 'claude-code'));
        if (!allowed) return;
      }
      // 4. A restart only when the running planner is another one, or reads the project's old settings.
      if (chosen.provider !== 'claude-code' || sharedChanged) await restart('Friday restarts with the new planner');
    } finally {
      busy = false;
      if (!td.done) {
        ctx.refresh();
        render();
      }
    }
  }

  /** "I'll write plans myself": this person's choice too, and the planner stops with a restart. */
  async function writeMyself() {
    if (busy) return;
    busy = true;
    render();
    try {
      const chosen = await ctx.act(
        'Write plans myself',
        () => ctx.api.choosePlanner('none'),
        'You write the plans: Friday asks no model',
      );
      if (chosen && native && chosen.provider !== 'none') await restart('Friday restarts without a planner');
    } finally {
      busy = false;
      if (!td.done) {
        ctx.refresh();
        render();
      }
    }
  }

  function render() {
    const board = ctx.store.select('board');
    const brain = board?.brain ?? null;
    const state = claudeCodePlanning(board);
    renderLimit();
    if (state === 'ready') {
      replace(
        body,
        h('div', { class: 'row' }, badge('on', 'good'), h('span', null, 'The Master Brain plans through Claude Code.')),
        h(
          'div',
          { class: 'pn-actions pn-actions-start' },
          linkButton('I’ll write plans myself instead', () => void writeMyself()),
        ),
      );
      return;
    }
    const cc = brain?.claude_code;
    const notFound = Boolean(cc && !cc.found);
    const restartBtn = native
      ? button([icon('rework', 14), 'Restart Friday'], () => void restart('Friday is restarting'), {
          class: 'btn btn-primary',
        })
      : null;
    const start = button([icon('check', 14), 'Use Claude Code to plan'], () => void turnOn(), {
      class: 'btn btn-primary',
      disabled: busy || notFound,
      ...(notFound ? { title: 'Friday did not find Claude Code on this computer' } : {}),
    });
    // The step a browser cannot take: this machine's approval, in a terminal. Kept in view until done.
    const approveHere =
      !native && !cc?.approved
        ? h(
            'li',
            null,
            'Allow it to spend on this computer, in a terminal in the project folder:',
            copyLine(ctx, `friday brain allow-remote --provider claude-code --budget ${budget}`),
          )
        : null;
    if (state === 'restart') {
      replace(
        body,
        h(
          'div',
          { class: 'row' },
          badge('restart needed', 'warn'),
          h('span', null, 'Friday picks up the new planner when it restarts.'),
        ),
        restartBtn
          ? h('div', { class: 'pn-actions pn-actions-start' }, restartBtn)
          : h(
              'ol',
              { class: 'pn-steps' },
              approveHere,
              h('li', null, 'Restart Friday (its tray icon, or stop and run it again).'),
            ),
      );
      return;
    }
    replace(
      body,
      notFound || state === 'missing'
        ? h(
            'div',
            { class: 'pn-qs-missing', role: 'status' },
            note(
              'Friday did not find Claude Code on this computer when it started. Install Claude Code and sign in to it; if you just did, restart Friday so it looks again.',
            ),
            restartBtn ? h('div', { class: 'pn-actions pn-actions-start' }, restartBtn) : null,
          )
        : null,
      h('label', { class: 'pn-qs-row' }, h('span', null, 'Daily spending limit (USD)'), budgetInput),
      limitNote,
      h('div', { class: 'pn-actions pn-actions-start' }, start),
      native
        ? note(
            cc?.approved
              ? 'Friday restarts if it has to, to start planning with it.'
              : 'Your computer asks you to allow the spending; Friday restarts if it has to.',
          )
        : h(
            'ol',
            { class: 'pn-steps' },
            h('li', null, 'Click the button above: it records your choice.'),
            approveHere,
            h('li', null, 'Restart Friday.'),
          ),
      wantedPlanner(brain) !== 'none'
        ? h(
            'div',
            { class: 'pn-actions pn-actions-start' },
            linkButton('I’ll write plans myself (no planner)', () => void writeMyself()),
          )
        : null,
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

  /**
   * This clone's trust in the project's loosening, through the platform's confirmation. Only when
   * automatic verification is among what waits for trust: this switch never trusts some other
   * setting on its own. Trust covers the whole list, which the confirmation shows.
   */
  async function trust(): Promise<boolean> {
    const view = await ctx.act('Read the policy', () => ctx.api.policy());
    const p = readLoosening(view ?? null);
    if (!p.hash || p.trusted) return false;
    if (!p.items.some((l) => l.setting === AUTO_VERIFY)) {
      ctx.toast({
        kind: 'warn',
        text: 'Automatic checks are not among the settings that wait for trust',
        detail: 'config.yaml may have changed; look at the list under this switch, and try again.',
      });
      return false;
    }
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
      if (!ok) return false;
    }
    const done = await ctx.act(
      'Trust the setting',
      () => ctx.api.trustPolicy(p.hash as string),
      'Work is now checked automatically',
    );
    return Boolean(done);
  }

  /** Sets the setting when config.yaml does not ask for it yet, then asks for the trust it needs. */
  async function turnOn() {
    if (busy) return;
    busy = true;
    render();
    try {
      const asked = autoVerification(ctx.store.select('board')) === 'untrusted';
      const set = asked
        ? true
        : await ctx.act('Check the work automatically', () => ctx.api.editSettings({ [AUTO_VERIFY]: true }));
      if (set) await trust();
    } finally {
      busy = false;
      if (!td.done) {
        ctx.refresh();
        render();
      }
    }
  }

  function render() {
    const board = ctx.store.select('board');
    const state = autoVerification(board);
    // Without checks of the project's own, checking is Friday's part alone: said, so "checked" is not over-read.
    const noChecks = board ? board.verification.checks.length === 0 : false;
    replace(
      body,
      noChecks
        ? note(
            'This project has no checks of its own set yet (tests, lint, build), so Friday checks only that the changes stay in scope, hold no credentials and were run.',
          )
        : null,
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
            button([icon('check', 14), state === 'untrusted' ? 'Trust and turn on' : 'Turn on'], () => void turnOn(), {
              class: 'btn btn-primary',
              disabled: busy,
            }),
          ),
      state === 'untrusted'
        ? note('config.yaml already asks for it; it applies once you trust it on this computer.')
        : null,
    );
  }

  render();
  td.add(ctx.store.subscribe('board', () => render()));
  return el;
}
