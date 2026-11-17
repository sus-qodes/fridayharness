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
import type { ProjectCheck, ProjectChecksView, SuggestedProjectCheck } from '../api/client.js';
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

export function projectChecksCard(ctx: AppContext, td: Teardown): HTMLElement {
  const body = h('div', { class: 'pn-pc-body' }, note('Reading the project’s checks…'));
  const el = h(
    'div',
    { class: 'pn-project-checks', dataset: { setup: 'checks' } },
    h('div', { class: 'pn-qs-title' }, 'The project’s own checks'),
    note(
      'What Friday runs to verify an agent’s work, besides its own checks that the changes stay in scope, hold no credentials and were run. Without any, no test decides whether the work is right.',
    ),
    body,
  );
  let view: ProjectChecksView | null = null;
  let busy = false;

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

  async function change(what: { add?: string[]; remove?: string[] }, success: string) {
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
      c.required ? null : h('span', { class: 'muted' }, 'advisory'),
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
      button([icon('check', 14), 'Add'], () => void change({ add: [s.name] }, `${kindOfCheck(s.kind)} added`), {
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
            badge('none yet', 'warn'),
            h('span', null, 'This project has no checks of its own.'),
          ),
      suggested.length
        ? h(
            'div',
            { class: 'pn-pc-suggested' },
            h('div', { class: 'field-label' }, 'Found in package.json'),
            h('ul', { class: 'pn-list', dataset: { list: 'suggested' } }, suggested.map(offer)),
            suggested.length > 1
              ? h(
                  'div',
                  { class: 'pn-actions pn-actions-start' },
                  button(
                    [icon('check', 14), `Add all ${suggested.length}`],
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
              'Friday found no test, lint, type-check or build script in a package.json here. A check can be any command: write it under verification.checks in .friday/config.yaml.',
            ),
      note(
        'Checks are kept in .friday/config.yaml, which your team shares: commit the file to share a change. A new check judges the next verification; nothing restarts.',
      ),
      h('div', { class: 'pn-actions pn-actions-start' }, openConfig),
    );
  }

  void load();
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
