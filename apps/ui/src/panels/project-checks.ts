/**
 * The project's checks, set from Settings (2026-11-17).
 *
 * Verification ran only Friday's own checks (scope, credentials, evidence) until someone wrote
 * `verification.checks` into config.yaml by hand, from an example in the Verify dialog; the
 * checklist's way to fix "No project checks" was "Open config.yaml". This card lists the checks the
 * project has, with what each runs, and the ones Friday found in the scripts of its package.json
 * (tests, lint, type check, build), each added with one click or all at once, and removed again.
 * The page sends names only: the daemon builds each command from what it read itself.
 *
 * They are kept in .friday/config.yaml, which the team shares: said, with the reminder to commit.
 */
import type {
  CheckTrialRow,
  CheckTrialView,
  ProjectCheck,
  ProjectChecksView,
  SuggestedProjectCheck,
} from '../api/client.js';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { badge, errorOf, note, plain, projectPath, type Teardown } from './common.js';

/** A kind of check, as a person says it. */
const KIND_WORDS: Record<string, string> = {
  test: 'Tests',
  lint: 'Lint',
  typecheck: 'Type check',
  build: 'Build',
  other: 'Check',
};

export function kindOfCheck(kind: string): string {
  return KIND_WORDS[kind] ?? 'Check';
}

/** The command of a check on one line, as it would be typed. */
export function commandLine(c: Pick<ProjectCheck, 'command' | 'args'>): string {
  return [c.command, ...c.args].join(' ');
}

/** How long a check took, as a person says it. */
export function tookWords(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return 'under a second';
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * What a finished trial means, in one sentence: whether an agent's work can be judged fairly. A
 * required check that fails on the untouched project would fail every task, whatever the work.
 */
export function trialVerdict(t: CheckTrialView): { tone: 'good' | 'warn' | 'danger'; text: string } | null {
  if (t.status === 'failed') return { tone: 'danger', text: t.problem ?? 'The checks could not be tried.' };
  if (t.status !== 'done') return null;
  const failed = t.checks.filter((c) => c.status === 'failed');
  const must = failed.filter((c) => c.required);
  if (must.length) {
    return {
      tone: 'danger',
      text: `${must.map((c) => `“${plain(c.name, 60)}”`).join(', ')} ${must.length === 1 ? 'fails' : 'fail'} before any agent has changed anything. Every task would be sent back for it, whatever the work: put it right first, or make it advisory.`,
    };
  }
  if (failed.length) {
    return {
      tone: 'warn',
      text: `Every required check passes. ${failed.map((c) => `“${plain(c.name, 60)}”`).join(', ')} (advisory) ${failed.length === 1 ? 'fails' : 'fail'} already, so a failure of it later is not the agent’s doing.`,
    };
  }
  return { tone: 'good', text: 'Every check passes on your project as it is, so a failure later comes from the work.' };
}

const TRIAL_POLL_MS = 1500;

export function projectChecksCard(ctx: AppContext, td: Teardown): HTMLElement {
  const body = h('div', { class: 'pn-pc-body' }, note('Reading the project’s checks…'));
  const el = h(
    'div',
    { class: 'pn-project-checks', dataset: { setup: 'checks' } },
    h('div', { class: 'pn-qs-title' }, 'Your project’s tests'),
    note(
      'When an agent says it is done, Friday runs these on its work before you see it: your tests, lint or build. They are optional. Without them Friday still checks that the agent changed only the files it was given, left no passwords or keys in them, and finished; whether the code works is then yours to try.',
    ),
    body,
  );
  let view: ProjectChecksView | null = null;
  let busy = false;
  let trial: CheckTrialView | null = null;
  let polling: ReturnType<typeof setTimeout> | null = null;
  td.add(() => {
    if (polling) clearTimeout(polling);
  });

  /** Follows a running trial until it ends; an older daemon has none, and then nothing is offered. */
  async function followTrial() {
    polling = null;
    try {
      const got = (await ctx.api.checkTrial()) as Partial<CheckTrialView> | null;
      trial = got && typeof got.status === 'string' && Array.isArray(got.checks) ? (got as CheckTrialView) : null;
    } catch {
      trial = null;
    }
    if (td.done) return;
    render();
    if (trial?.status === 'running') polling = setTimeout(() => void followTrial(), TRIAL_POLL_MS);
  }

  async function tryChecks() {
    if (busy || trial?.status === 'running') return;
    const started = await ctx.act('Run the checks', () => ctx.api.startCheckTrial());
    if (td.done || !started) return;
    trial = started;
    render();
    if (!polling) polling = setTimeout(() => void followTrial(), TRIAL_POLL_MS);
  }

  function trialRow(c: CheckTrialRow): HTMLElement {
    const mark =
      c.status === 'passed'
        ? badge('passed', 'good')
        : c.status === 'failed'
          ? badge('failed', c.required ? 'danger' : 'warn')
          : c.status === 'running'
            ? badge('running…', 'info')
            : badge('waiting', 'muted');
    return h(
      'li',
      { class: 'pn-item pn-pc-item pn-pc-trial-row', dataset: { status: c.status } },
      mark,
      h('span', { class: 'pn-pc-name' }, plain(c.name, 60)),
      h(
        'span',
        { class: 'muted' },
        [c.required ? '' : 'advisory', tookWords(c.duration_ms)].filter(Boolean).join(' · '),
      ),
      c.status === 'failed' && c.output_tail
        ? h(
            'details',
            { class: 'pn-pc-output' },
            h('summary', null, 'What it printed'),
            h('pre', { class: 'mono' }, plain(c.output_tail, 3000)),
          )
        : null,
    );
  }

  function trialSection(checks: readonly ProjectCheck[]): HTMLElement | null {
    if (!checks.length || !trial) return null;
    const running = trial.status === 'running';
    const verdict = trialVerdict(trial);
    return h(
      'div',
      { class: 'pn-pc-trial', dataset: { trial: trial.status } },
      h(
        'div',
        { class: 'pn-actions pn-actions-start' },
        button(
          [
            icon('play', 14),
            running ? 'Running the checks…' : trial.status === 'idle' ? 'Run the checks now' : 'Run them again',
          ],
          () => void tryChecks(),
          { class: 'btn', disabled: busy || running, dataset: { action: 'try-checks' } },
        ),
        h(
          'span',
          { class: 'muted' },
          running
            ? trial.running === 'preparing'
              ? 'Getting a copy of your project ready…'
              : `Running “${plain(trial.running ?? '', 60)}”…`
            : trial.status === 'idle'
              ? 'On your project as it is, before any agent changes it.'
              : '',
        ),
      ),
      trial.status === 'idle'
        ? null
        : h('ul', { class: 'pn-list', dataset: { list: 'trial' } }, trial.checks.map(trialRow)),
      verdict ? h('div', { class: `pn-pc-verdict is-${verdict.tone}`, role: 'status' }, verdict.text) : null,
      trial.status === 'done' && trial.problem ? note(plain(trial.problem, 600)) : null,
      trial.status === 'done' && trial.uncommitted
        ? note('Changes in your folder that are not committed yet were not part of this run.')
        : null,
    );
  }

  async function load() {
    try {
      view = await ctx.api.projectChecks();
      if (!td.done) render();
    } catch (e) {
      if (td.done) return;
      replace(
        body,
        h('div', { class: 'field-error' }, `The checks could not be read: ${plain(errorOf(e).message, 300)}`),
      );
    }
  }

  async function change(
    what: { add?: string[]; remove?: string[]; strength?: { name: string; required: boolean } },
    success: string,
  ) {
    if (busy) return;
    busy = true;
    render();
    const r = await ctx.act('Change the project’s checks', () => ctx.api.changeProjectChecks(what), success);
    busy = false;
    if (td.done) return;
    if (r) {
      view = r;
      // The board lists the checks too (the Verify dialog, the checklist): read it again.
      ctx.refresh();
    }
    render();
  }

  function have(c: ProjectCheck): HTMLElement {
    return h(
      'li',
      { class: 'pn-item pn-pc-item' },
      badge(kindOfCheck(c.kind), 'info'),
      h('span', { class: 'pn-pc-name' }, plain(c.name, 60)),
      // Its strength, always said, and changed with one click: required holds work back, advisory does not.
      button(
        c.required ? 'Required' : 'Advisory',
        () =>
          void change(
            { strength: { name: c.name, required: !c.required } },
            c.required
              ? `“${plain(c.name, 60)}” is now advisory: it is shown, and holds nothing back`
              : `“${plain(c.name, 60)}” is now required: it must pass`,
          ),
        {
          class: `btn pn-pc-strength ${c.required ? 'is-required' : 'is-advisory'}`,
          disabled: busy,
          title: c.required
            ? 'It must pass, or the work goes back to the agent. Click to make it advisory.'
            : 'It is run and shown; a failure holds nothing back. Click to make it required.',
          ariaLabel: `${plain(c.name, 60)} is ${c.required ? 'required' : 'advisory'}; make it ${c.required ? 'advisory' : 'required'}`,
          dataset: { strength: c.required ? 'required' : 'advisory' },
        },
      ),
      h('span', { class: 'mono muted pn-pc-cmd' }, plain(commandLine(c), 200)),
      button('Remove', () => void change({ remove: [c.name] }, `“${plain(c.name, 60)}” is no longer run`), {
        class: 'btn btn-ghost',
        disabled: busy,
        ariaLabel: `Remove the check ${plain(c.name, 60)}`,
      }),
    );
  }

  function offer(s: SuggestedProjectCheck): HTMLElement {
    return h(
      'li',
      { class: 'pn-item pn-pc-item' },
      badge(kindOfCheck(s.kind), 'muted'),
      h('span', { class: 'mono' }, plain(commandLine(s), 200)),
      h(
        'span',
        { class: 'muted pn-pc-cmd', title: 'What that script is in package.json' },
        `runs: ${plain(s.runs, 160)}`,
      ),
      button([icon('plus', 14), 'Add'], () => void change({ add: [s.name] }, `${kindOfCheck(s.kind)} added`), {
        class: 'btn',
        disabled: busy,
        ariaLabel: `Add the check ${plain(commandLine(s), 120)}`,
      }),
    );
  }

  function render() {
    if (!view) return;
    const { checks, suggested } = view;
    const root = ctx.store.select('board')?.project.root ?? '';
    const openConfig = button(
      [icon('file', 14), 'Open config.yaml in VS Code'],
      () => {
        if (root) ctx.platform.openInEditor(projectPath(root, '.friday/config.yaml'));
      },
      { class: 'btn btn-ghost', disabled: !root },
    );
    replace(
      body,
      checks.length
        ? h('ul', { class: 'pn-list', dataset: { list: 'have' } }, checks.map(have))
        : h(
            'div',
            { class: 'row', dataset: { state: 'none' } },
            badge('none yet', 'muted'),
            h('span', null, 'None yet. That is fine for a project just starting: add them when you have tests.'),
          ),
      suggested.length
        ? h(
            'div',
            { class: 'pn-pc-suggested' },
            h('div', { class: 'field-label' }, 'Found in your package.json: add the ones you want'),
            h('ul', { class: 'pn-list', dataset: { list: 'suggested' } }, suggested.map(offer)),
            suggested.length > 1
              ? h(
                  'div',
                  { class: 'pn-actions pn-actions-start' },
                  button(
                    [icon('plus', 14), `Add all ${suggested.length}`],
                    () =>
                      void change(
                        { add: suggested.map((s) => s.name) },
                        `${suggested.length} checks added: they judge the next verification`,
                      ),
                    { class: 'btn btn-primary', disabled: busy },
                  ),
                )
              : null,
          )
        : checks.length
          ? null
          : note(
              'Friday found no test, lint or build script in a package.json here. A check can be any command your project runs: add it under verification.checks in .friday/config.yaml.',
            ),
      trialSection(checks),
      note(
        'They are kept in .friday/config.yaml in your project. A change is used the next time work is checked; nothing restarts. To give your team the same checks, commit that file with your own work: Friday never commits it for you.',
      ),
      h('div', { class: 'pn-actions pn-actions-start' }, openConfig),
    );
  }

  void load();
  void followTrial();
  // config.yaml may change under the page (an editor, a pull): the list follows the board's own.
  const names = () => JSON.stringify(ctx.store.select('board')?.verification.checks.map((c) => c.name) ?? []);
  let seen = names();
  td.add(
    ctx.store.subscribe('board', () => {
      const now = names();
      if (now === seen) return;
      seen = now;
      if (!busy) void load();
    }),
  );
  return el;
}
