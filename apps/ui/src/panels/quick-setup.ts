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
 * whether some other setting of the project waits for trust. Starting plans without approval
 * (`master_brain.auto_approve`) is the same kind of switch (2026-11-17), and both turn off again.
 */
import type { BrainStatusView, UiSnapshot } from '@friday/protocol';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { badge, copyLine, input, linkButton, note, restartBlocked, type Teardown } from './common.js';
import { trustLoosening, trustWhatStays } from './trust.js';

/** The daily budget offered for planning through Claude Code, in dollars. */
export const CLAUDE_CODE_BUDGET = 2;

const AUTO_VERIFY = 'verification.auto_on_completion';
const AUTO_APPROVE = 'master_brain.auto_approve';

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
        h('div', { class: 'row' }, badge('on', 'good'), h('span', null, 'Friday plans through Claude Code.')),
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

/** A setting that loosens Friday's defaults, as a switch: what it sets, and the words around it. */
interface LooseningSwitch {
  /** `data-setup` of the card. */
  setup: string;
  /** The key in config.yaml. */
  setting: string;
  title: string;
  what: string;
  state(board: UiSnapshot | null | undefined): 'on' | 'untrusted' | 'off';
  /** Said beside "on". */
  on: string;
  /** The label of the act of turning it on, for an error. */
  act: string;
  turnedOn: string;
  turnedOff: string;
  /** Said when the setting is not among what waits for trust. */
  missing: string;
  /** A note above the switch, from the board (null: none). */
  before?(board: UiSnapshot | null | undefined): HTMLElement | null;
}

/**
 * A switch for a loosening (2026-11-17): on sets the setting when config.yaml does not ask for it
 * yet, then asks for the trust it needs; off sets it back, which needs no trust, and asks again for
 * the settings that stay on, since they were trusted with it as one list. Before, a setting turned
 * on here could only be turned off by editing config.yaml.
 */
/**
 * An on/off switch: a track with a thumb and the word "On" or "Off" in it, so it reads as a state
 * and not as an order. `label` is what pressing it does, for a screen reader.
 */
export function onOffSwitch(opts: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}): HTMLButtonElement {
  return button(
    [
      h('span', { class: 'pn-switch-track', aria: { hidden: 'true' } }, h('span', { class: 'pn-switch-thumb' })),
      h('span', { class: 'pn-switch-word', aria: { hidden: 'true' } }, opts.on ? 'On' : 'Off'),
    ],
    () => opts.onChange(),
    {
      class: `pn-switch ${opts.on ? 'is-on' : ''}`.trim(),
      role: 'switch',
      aria: { checked: opts.on ? 'true' : 'false' },
      ariaLabel: opts.label,
      disabled: opts.disabled ?? false,
    },
  );
}

function looseningSwitch(ctx: AppContext, td: Teardown, spec: LooseningSwitch): HTMLElement {
  let busy = false;
  const body = h('div', { class: 'pn-qs-body' });
  const el = h(
    'div',
    { class: 'pn-quick-setup', dataset: { setup: spec.setup } },
    h('div', { class: 'pn-qs-title' }, spec.title),
    note(spec.what),
    body,
  );

  async function run(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    render();
    try {
      await work();
    } finally {
      busy = false;
      if (!td.done) {
        ctx.refresh();
        render();
      }
    }
  }

  /** Sets the setting when config.yaml does not ask for it yet, then asks for the trust it needs. */
  const turnOn = () =>
    run(async () => {
      const asked = spec.state(ctx.store.select('board')) === 'untrusted';
      const set = asked ? true : await ctx.act(spec.act, () => ctx.api.editSettings({ [spec.setting]: true }));
      if (set) await trustLoosening(ctx, { expects: spec.setting, missing: spec.missing, success: spec.turnedOn });
    });

  /** Sets it back: a tightening, in force at once. What stays on is asked for again. */
  const turnOff = () =>
    run(async () => {
      const set = await ctx.act('Turn it off', () => ctx.api.editSettings({ [spec.setting]: false }), spec.turnedOff);
      if (set) await trustWhatStays(ctx);
    });

  function render() {
    const board = ctx.store.select('board');
    const state = spec.state(board);
    replace(
      body,
      spec.before?.(board) ?? null,
      // One switch, which says where it stands (2026-11-18): a "Turn on" button with a tick read as
      // already on, and once on the way back was a link of another kind.
      h(
        'div',
        { class: 'row pn-switch-row' },
        onOffSwitch({
          on: state === 'on',
          disabled: busy,
          label: state === 'on' ? 'Turn off' : state === 'untrusted' ? 'Trust and turn on' : 'Turn on',
          onChange: () => void (state === 'on' ? turnOff() : turnOn()),
        }),
        // The switch itself says "Off": beside it stands only what adds something.
        state === 'off'
          ? null
          : h(
              'span',
              { class: state === 'on' ? '' : 'muted' },
              state === 'on' ? spec.on : 'Off until you approve it on this computer.',
            ),
      ),
      state === 'untrusted'
        ? note('config.yaml already asks for it; it applies once you trust it on this computer.')
        : null,
      state === 'untrusted'
        ? h(
            'div',
            { class: 'pn-actions pn-actions-start' },
            linkButton('Take it out of config.yaml', () => void turnOff()),
          )
        : null,
    );
  }

  render();
  td.add(ctx.store.subscribe('board', () => render()));
  return el;
}

/** "Check the work automatically": verification runs as soon as an agent claims a task. */
const LANDING = 'landing.mode';
type LandingMode = 'ask' | 'goal' | 'task';

const LANDING_CHOICES: { mode: LandingMode; label: string; what: string }[] = [
  { mode: 'ask', label: 'Ask me', what: 'Finished work waits until you press Land.' },
  {
    mode: 'goal',
    label: 'When the whole goal has passed',
    what: 'Friday puts a goal into your project once every task of it has passed its checks.',
  },
  {
    mode: 'task',
    label: 'Each task as it passes',
    what: 'Friday puts each task into your project as soon as it has passed its checks.',
  },
];

/** What is in force for landing on this computer, and what config.yaml asks for. */
export function landingState(board: UiSnapshot | null | undefined): { mode: LandingMode; requested: LandingMode } {
  return { mode: board?.landing?.mode ?? 'ask', requested: board?.landing?.requested ?? 'ask' };
}

/**
 * "Put finished work into my project" (2026-11-17): `landing.mode`. A finished goal waited for a
 * click on Land, always. The two other choices are loosenings this computer trusts first, they
 * apply only in a project with a required check, and Friday never pushes; a file you changed
 * yourself always stops it, and the goal then waits for its Land button as before.
 */
export function landingChoice(ctx: AppContext, td: Teardown): HTMLElement {
  let busy = false;
  const body = h('div', { class: 'pn-qs-body' });
  const el = h(
    'div',
    { class: 'pn-quick-setup', dataset: { setup: 'landing' } },
    h('div', { class: 'pn-qs-title' }, 'Put finished work into my project'),
    note(
      'When work has passed its checks it is merged into the branch your project folder is on. Friday never sends anything to GitHub, and it stops and leaves everything as it is when a file you changed yourself is in the way.',
    ),
    body,
  );

  async function choose(mode: LandingMode) {
    if (busy) return;
    busy = true;
    render();
    try {
      const { mode: now, requested } = landingState(ctx.store.select('board'));
      if (mode === 'ask') {
        const set = await ctx.act(
          'Ask me before landing',
          () => ctx.api.editSettings({ [LANDING]: 'ask' }),
          'Finished work waits for you to press Land',
        );
        if (set) await trustWhatStays(ctx);
      } else {
        const set =
          requested === mode && now !== mode
            ? true
            : await ctx.act('Land without asking', () => ctx.api.editSettings({ [LANDING]: mode }));
        if (set) {
          await trustLoosening(ctx, {
            expects: LANDING,
            missing: 'Landing without asking is not among the settings that wait for trust',
            success: mode === 'task' ? 'Each task now lands as it passes' : 'A goal now lands when it has passed',
          });
        }
      }
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
    const { mode, requested } = landingState(board);
    const checked = board ? board.verification.checks.some((c) => c.required) : true;
    replace(
      body,
      checked
        ? null
        : note(
            'This project has no required check of its own yet, so Friday lands nothing by itself whatever is chosen here: unchecked work always waits for you.',
          ),
      h(
        'div',
        {
          class: 'pn-landing-choices',
          role: 'radiogroup',
          aria: { label: 'When finished work is put into the project' },
        },
        LANDING_CHOICES.map((c) =>
          button(
            [h('span', { class: 'pn-landing-label' }, c.label), h('span', { class: 'pn-landing-what muted' }, c.what)],
            () => void choose(c.mode),
            {
              class: ['btn', 'pn-landing-choice', mode === c.mode ? 'is-on' : ''].filter(Boolean).join(' '),
              disabled: busy || (mode === c.mode && requested === c.mode),
              role: 'radio',
              aria: { checked: mode === c.mode ? 'true' : 'false' },
              dataset: { mode: c.mode },
            },
          ),
        ),
      ),
      requested !== mode
        ? note(
            'config.yaml already asks for landing without asking; it applies once you trust it on this computer: choose it again here.',
          )
        : null,
    );
  }

  td.add(ctx.store.subscribe('board', () => (busy ? undefined : render())));
  render();
  return el;
}

export function autoVerifySwitch(ctx: AppContext, td: Teardown): HTMLElement {
  return looseningSwitch(ctx, td, {
    setup: 'verify',
    setting: AUTO_VERIFY,
    title: 'Check the work automatically',
    what: "When an agent says it is done, Friday runs the project's checks at once instead of waiting for you to click Verify. They run code the agent wrote, so Friday asks you to trust this setting first.",
    state: autoVerification,
    on: 'Finished work is checked as soon as it is claimed.',
    act: 'Check the work automatically',
    turnedOn: 'Work is now checked automatically',
    turnedOff: 'Finished work waits for you to click Verify',
    missing: 'Automatic checks are not among the settings that wait for trust',
    // Without checks of the project's own, checking is Friday's part alone: said, so "checked" is not over-read.
    before: (board) =>
      board && board.verification.checks.length === 0
        ? note(
            'This project has no checks of its own set yet (tests, lint, build), so Friday checks only that the changes stay in scope, hold no credentials and were run.',
          )
        : null,
  });
}

/**
 * Where approving plans automatically stands: `on` (in force), `untrusted` (config.yaml asks for
 * it and this clone has not trusted it), or `off`. An older daemon does not say whether it is asked
 * for: then it reads `off`, and turning it on sets it again, which changes nothing.
 */
export function autoApproval(board: UiSnapshot | null | undefined): 'on' | 'untrusted' | 'off' {
  if (board?.brain?.auto_approve) return 'on';
  return board?.brain?.auto_approve_requested === true ? 'untrusted' : 'off';
}

/**
 * "Start plans without asking me" (2026-11-17): `master_brain.auto_approve`, which was a line to
 * write into config.yaml and a command to trust it. A plan the planner has a question about still
 * waits for a person, as does every change an agent needs approval for.
 */
export function autoApproveSwitch(ctx: AppContext, td: Teardown): HTMLElement {
  return looseningSwitch(ctx, td, {
    setup: 'auto-approve',
    setting: AUTO_APPROVE,
    title: 'Start plans without asking me',
    what: 'When the planner proposes a plan, Friday approves it and the agents start, instead of waiting for you to review it. A plan the planner has a question about still waits for you. Agents then work on a plan nobody read, so Friday asks you to trust this setting first.',
    state: autoApproval,
    on: 'Plans start as soon as the planner proposes them.',
    act: 'Start plans without asking',
    turnedOn: 'Plans now start without waiting for you',
    turnedOff: 'Each plan waits for your approval',
    missing: 'Starting plans automatically is not among the settings that wait for trust',
  });
}
