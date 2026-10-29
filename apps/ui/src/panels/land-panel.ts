/**
 * Landing a goal (plan §7.7, FD-27): what is ready on `friday/goal-<id>` (its commits ahead of the
 * main checkout's HEAD and its files with `+N −M`), a way to the full goal diff, and the steps to
 * merge it in VS Code or git, each with a copy button. Friday never merges into a human's branch.
 */
import type { GoalDiff } from '@friday/protocol';
import { hasHidden, visible } from '../model/text.js';
import { type AppContext, type Component, type ModalRequest, openDrawer } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { humanize, timeAgo } from '../ui/format.js';
import { copyIcon, copyLine, errorOf, linkButton, note, panel, pathText, plain, section, Teardown } from './common.js';

/** The goal branch's name, as Friday names it. */
export function goalBranch(goalId: string): string {
  return `friday/goal-${goalId}`;
}

export function landModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const goalId = request.id ?? '';
  const goal = ctx.store.select('board')?.goals.find((g) => g.goal_id === goalId) ?? null;
  let branch = goalBranch(goalId);

  const branchLine = h('div', { class: 'pn-land-branch' });
  const commitsBox = h('div', { class: 'pn-commits' }, h('div', { class: 'muted' }, 'Reading the goal branch…'));
  const filesBox = h('div', { class: 'pn-diffstat' });
  const stepsBox = h('div', { class: 'pn-steps-box' });

  function renderBranch() {
    replace(
      branchLine,
      h('span', { class: 'pn-land-title' }, 'Ready to land: '),
      pathText(branch, 'pn-branch'),
      button(copyIcon(), () => void copy(branch, 'branch name'), {
        class: 'btn btn-icon',
        ariaLabel: 'Copy the branch name',
        title: 'Copy the branch name',
        disabled: hasHidden(branch),
      }),
    );
  }

  async function copy(text: string, what: string) {
    const ok = await ctx.platform.copy(text);
    ctx.toast(
      ok
        ? { kind: 'success', text: `Copied the ${what}` }
        : { kind: 'warn', text: 'This page may not copy; select the text and copy it' },
    );
  }

  function renderSteps() {
    replace(
      stepsBox,
      h('div', { class: 'field-label' }, 'In VS Code'),
      h(
        'ol',
        { class: 'pn-steps' },
        h('li', null, 'Open the Source Control view.'),
        h('li', null, 'In its "…" menu choose Branch → Merge Branch…'),
        h('li', null, 'Pick ', pathText(branch), '.'),
      ),
      h('div', { class: 'field-label' }, 'In git (in the project folder, on your branch)'),
      copyLine(ctx, `git merge ${branch}`, 'merge command'),
      note('Friday never merges into your branch: landing the goal is your step. Review the diff first.'),
    );
  }

  function render(diff: GoalDiff) {
    if (typeof diff.branch === 'string' && diff.branch) branch = diff.branch;
    renderBranch();
    renderSteps();
    const commits = Array.isArray(diff.commits_ahead) ? diff.commits_ahead : [];
    replace(
      commitsBox,
      h(
        'div',
        { class: 'field-label' },
        `${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} ahead of the main checkout's HEAD`,
      ),
      commits.length
        ? h(
            'ul',
            { class: 'pn-list' },
            commits.map((c) =>
              h(
                'li',
                { class: 'pn-item pn-commit' },
                h('span', { class: 'mono pn-sha' }, visible(String(c.sha).slice(0, 10))),
                h('span', { class: 'pn-grow' }, plain(c.subject, 300)),
                h('span', { class: 'muted' }, timeAgo(c.date, ctx.now())),
              ),
            ),
          )
        : h('div', { class: 'muted' }, 'Nothing to land yet: the goal branch has no commits ahead.'),
    );
    const files = Array.isArray(diff.files) ? diff.files : [];
    const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
    const removed = files.reduce((n, f) => n + (f.removed ?? 0), 0);
    replace(
      filesBox,
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'field-label' }, `${files.length} ${files.length === 1 ? 'file' : 'files'}`),
        h('span', { class: 'pn-add' }, `+${added}`),
        h('span', { class: 'pn-del' }, `−${removed}`),
      ),
      h(
        'ul',
        { class: 'pn-list' },
        files
          .slice(0, 40)
          .map((f) =>
            h(
              'li',
              { class: 'pn-item' },
              pathText(f.path, 'pn-grow'),
              f.binary ? h('span', { class: 'muted' }, 'binary') : null,
              h('span', { class: 'pn-add' }, f.added === null ? '' : `+${f.added}`),
              h('span', { class: 'pn-del' }, f.removed === null ? '' : `−${f.removed}`),
            ),
          ),
      ),
      files.length > 40 ? h('div', { class: 'muted' }, `and ${files.length - 40} more in the full diff`) : null,
      diff.truncated ? note('The goal diff is longer than Friday reads at once.') : null,
    );
  }

  const el = panel(
    'pn-land',
    goal && goal.status !== 'COMPLETED'
      ? note(`This goal is ${humanize(goal.status).toLowerCase()}; it is ready to land once it is completed.`)
      : null,
    goal ? h('p', { class: 'pn-goal-line' }, plain(goal.objective ?? goal.request, 400)) : null,
    branchLine,
    section('Commits', commitsBox),
    section(
      'Files',
      filesBox,
      linkButton('Open the full goal diff', () => openDrawer(ctx, { kind: 'diff', id: goalId, tab: 'goal' })),
    ),
    section('Merge it', stepsBox),
    h(
      'div',
      { class: 'pn-actions' },
      button('Close', () => close(), { class: 'btn' }),
    ),
  );
  renderBranch();
  renderSteps();

  void (async () => {
    try {
      const diff = await ctx.api.goalDiff(goalId, true);
      if (td.done) return;
      render(diff ?? ({} as GoalDiff));
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      replace(
        commitsBox,
        h(
          'div',
          { class: 'field-error' },
          `Could not read the goal branch: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
      );
    }
  })();

  return {
    title: 'Ready to land',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
