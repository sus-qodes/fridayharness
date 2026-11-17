/**
 * Landing a goal (plan §7.7, FD-27): what Friday did for the goal, one row per fact from its
 * records (plan M12.7); what is ready on `friday/goal-<id>` (its commits ahead of the main
 * checkout's HEAD and its files with `+N −M`), a way to the full goal diff, a "Land into <branch>"
 * button (2026-11-16: a person's click, confirmed, merges it as `git merge` would, all or nothing),
 * and the steps to merge it in VS Code or git, each with a copy button. Friday never merges into a
 * human's branch on its own.
 *
 * What the button would do is read first (`GET goals/:gid/land`, 2026-11-17): the branch it lands
 * into by name; what is in the way, with the files, when something is; that the goal is on that
 * branch already; or that its work was made in the project folder itself (sessions attached from
 * an editor), where there is nothing to land and the person reviews and commits it.
 */
import type { GoalDiff, GoalSummary, LandPlanView } from '@friday/protocol';
import { pruneWorktrees } from '../dock/commands.js';
import { hasHidden, visible } from '../model/text.js';
import { goalSummaryRows } from '../nodes/goal-node.js';
import { type AppContext, type Component, type ModalRequest, openDrawer } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { humanize, timeAgo } from '../ui/format.js';
import {
  actWithError,
  badge,
  copyIcon,
  copyLine,
  errorOf,
  linkButton,
  note,
  panel,
  pathText,
  plain,
  section,
  Teardown,
} from './common.js';

/** The goal branch's name, as Friday names it. */
export function goalBranch(goalId: string): string {
  return `friday/goal-${goalId}`;
}

/** How many of a plan's files the dialog lists before "and N more". */
const FILES_SHOWN = 12;

export function landModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const goalId = request.id ?? '';
  const goal = ctx.store.select('board')?.goals.find((g) => g.goal_id === goalId) ?? null;
  let branch = goalBranch(goalId);
  /** What Land would do, once read; null while reading, or when the daemon did not say. */
  let plan: LandPlanView | null = null;
  let planError: string | null = null;

  const branchLine = h('div', { class: 'pn-land-branch' });
  const didBox = h('div', { class: 'pn-did' }, h('div', { class: 'muted' }, 'Reading what Friday did…'));
  const commitsBox = h('div', { class: 'pn-commits' }, h('div', { class: 'muted' }, 'Reading the goal branch…'));

  /** What Friday did for the goal: every fact on its own row, from the goal detail's summary. */
  function renderDid(summary: GoalSummary | null | undefined) {
    const rows = summary ? goalSummaryRows(summary) : [];
    replace(
      didBox,
      rows.length
        ? h(
            'dl',
            { class: 'pn-kv', dataset: { role: 'did' } },
            rows.flatMap((r) => [h('dt', null, r.label), h('dd', null, r.value)]),
          )
        : h('div', { class: 'muted' }, 'Nothing on record for this goal yet.'),
    );
  }
  const filesBox = h('div', { class: 'pn-diffstat' });
  const stepsBox = h('div', { class: 'pn-steps-box' });

  /** The work was made in the project folder itself: there is no branch to show or to merge. */
  const inFolder = () => plan?.state === 'in_folder';

  function renderBranch() {
    if (inFolder()) {
      replace(branchLine, h('span', { class: 'pn-land-title' }, 'Already in your project folder'));
      return;
    }
    replace(
      branchLine,
      h('span', { class: 'pn-land-title' }, plan?.state === 'landed' ? 'Landed: ' : 'Ready to land: '),
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

  /** The files of a plan (in the way, or to commit), as a short list. */
  function fileList(files: string[]): HTMLElement | null {
    if (!files.length) return null;
    return h(
      'ul',
      { class: 'pn-list', dataset: { role: 'land-files' } },
      files.slice(0, FILES_SHOWN).map((f) => h('li', { class: 'pn-item' }, pathText(f, 'pn-grow'))),
      files.length > FILES_SHOWN ? h('li', { class: 'pn-item muted' }, `and ${files.length - FILES_SHOWN} more`) : null,
    );
  }

  const landBox = h('div', { class: 'pn-land-now' });
  const landError = h('div', { class: 'field-error', hidden: true, role: 'alert' });
  let landing = false;
  /** The branch Land merges into, as the plan read it. */
  const into = () => (plan?.into ? visible(plan.into) : 'my branch');

  /** Lands the goal into the branch the project folder has checked out, after a confirmation. */
  async function landNow() {
    if (landing) return;
    // Nothing is asked when nothing would merge (the goal is on that branch already).
    const merges = plan?.state !== 'landed';
    // The desktop shows its own dialog for this route (`confirm_and_send`); a browser asks here.
    if (merges && !ctx.platform.desktop) {
      const ok = await ctx.confirm({
        title: 'Land this goal?',
        body: [
          `This merges ${visible(branch)} into ${into()}, the branch your project folder has checked out, as "git merge" there would.`,
          'If git cannot merge cleanly, nothing is changed and Friday says why.',
        ],
        confirmLabel: 'Land the goal',
      });
      if (!ok) return;
    }
    landing = true;
    landError.hidden = true;
    renderLand();
    const r = await actWithError(
      ctx,
      'Land the goal',
      () => ctx.api.landGoal(goalId),
      (e) => {
        landError.hidden = false;
        landError.textContent = plain(e.message, 1000);
      },
      (x) =>
        x.status === 'already'
          ? `Nothing to land: ${x.into} already has this goal's work`
          : `Landed into ${x.into}${x.fast_forward ? ' (fast-forward)' : ''}`,
    );
    landing = false;
    if (td.done) return;
    if (r) ctx.refresh();
    // What Land would do now: landed, or what the refusal named.
    await readPlan();
  }

  function renderLand() {
    const known = goal ? goal.status === 'COMPLETED' : true;
    const recorded = Boolean(ctx.store.select('board')?.goal_landing?.[goalId]?.landed);
    const again = linkButton('Check again', () => void readPlan());
    let body: (HTMLElement | null)[];
    if (!plan) {
      // The plan is not read (an older daemon, or the read failed): the daemon still judges a click.
      body = [
        h(
          'div',
          { class: 'pn-actions pn-actions-start' },
          button('Land into my branch', () => void landNow(), {
            class: 'btn btn-primary',
            disabled: landing || !known,
            title: known
              ? 'Merge the goal branch into the branch your project folder has checked out'
              : 'Only a completed goal lands',
          }),
        ),
        planError ? note(`Friday could not say what landing would do: ${planError}`) : null,
      ];
    } else if (plan.state === 'landed') {
      body = [
        h('div', { class: 'row' }, badge('landed', 'good'), h('span', null, `The goal's work is on ${into()}.`)),
        // Merged by hand: the board learns it when the person says so.
        recorded
          ? null
          : h(
              'div',
              { class: 'pn-actions pn-actions-start' },
              button('Mark as landed', () => void landNow(), { class: 'btn', disabled: landing }),
            ),
        // What is left once the work is on your branch (2026-11-17): the folders of the finished
        // tasks. Nothing offered to remove them here; it was a command in the palette.
        h(
          'div',
          { class: 'pn-land-cleanup' },
          note(
            'The folders the tasks worked in are no longer needed. Friday removes the ones of finished tasks that hold no uncommitted work, in this goal and any other.',
          ),
          h(
            'div',
            { class: 'pn-actions pn-actions-start' },
            button('Clean up finished task folders', () => void pruneWorktrees(ctx), { class: 'btn' }),
          ),
        ),
      ];
    } else if (plan.state === 'in_folder') {
      const root = ctx.store.select('board')?.project.root ?? '';
      body = [
        note(
          'This goal’s work was made in your project folder itself (by an agent you run in your editor), so it is already there. There is no branch to land: review the changes and commit them.',
        ),
        plan.files.length ? h('div', { class: 'field-label' }, 'Not committed yet in your project folder') : null,
        fileList(plan.files),
        h(
          'div',
          { class: 'pn-actions pn-actions-start' },
          root
            ? button('Open the folder in VS Code', () => ctx.platform.openInEditor(root), { class: 'btn btn-primary' })
            : null,
          again,
        ),
      ];
    } else if (plan.state === 'blocked' || plan.state === 'not_completed') {
      body = [
        h(
          'div',
          { class: 'pn-actions pn-actions-start' },
          button(`Land into ${into()}`, () => undefined, { class: 'btn btn-primary', disabled: true }),
          again,
        ),
        h(
          'div',
          { class: 'pn-land-blocked', role: 'status' },
          plain(`Not yet: ${plan.reason ?? 'something is in the way'}.`, 600),
        ),
        fileList(plan.files),
      ];
    } else {
      body = [
        h(
          'div',
          { class: 'pn-actions pn-actions-start' },
          button(`Land into ${into()}`, () => void landNow(), {
            class: 'btn btn-primary',
            disabled: landing || plan.commits === 0,
            title:
              plan.commits === 0
                ? 'The goal branch has no commits to bring'
                : `Merge the goal branch into ${into()}, the branch your project folder has checked out`,
          }),
        ),
      ];
    }
    replace(
      landBox,
      ...body,
      plan?.work === 'mixed'
        ? note(
            'Some of this goal’s tasks worked in your project folder itself (an agent you run in your editor): that part is already in the folder and is not on this branch. Review and commit it too.',
          )
        : null,
      landError,
    );
  }

  function renderSteps() {
    renderLand();
    if (inFolder()) {
      replace(stepsBox, landBox);
      return;
    }
    replace(
      stepsBox,
      landBox,
      h('div', { class: 'field-label' }, 'Or yourself, in VS Code'),
      h(
        'ol',
        { class: 'pn-steps' },
        h('li', null, 'Open the Source Control view.'),
        h('li', null, 'In its "…" menu choose Branch → Merge Branch…'),
        h('li', null, 'Pick ', pathText(branch), '.'),
      ),
      h('div', { class: 'field-label' }, 'Or in git (in the project folder, on your branch)'),
      copyLine(ctx, `git merge ${branch}`, 'merge command'),
      note('Friday never merges into your branch on its own: landing the goal is your step. Review the diff first.'),
    );
  }

  /** Reads what Land would do; the dialog works without it (an older daemon judges the click). */
  async function readPlan() {
    try {
      const read = await ctx.api.landPlan(goalId);
      planError = null;
      // A daemon without the route answers something else: only a plan is taken as one.
      plan =
        read && typeof read.state === 'string' ? { ...read, files: Array.isArray(read.files) ? read.files : [] } : null;
    } catch (e) {
      plan = null;
      planError = plain(errorOf(e).message, 300);
    }
    if (td.done) return;
    if (plan?.branch) branch = plan.branch;
    renderBranch();
    renderSteps();
  }

  function render(diff: GoalDiff) {
    if (typeof diff.branch === 'string' && diff.branch) branch = diff.branch;
    renderBranch();
    renderSteps();
    const commits = Array.isArray(diff.commits_ahead) ? diff.commits_ahead : [];
    const notes = (Array.isArray(diff.notes) ? diff.notes : []).filter((n) => typeof n === 'string');
    replace(
      commitsBox,
      h(
        'div',
        { class: 'field-label' },
        `${commits.length} ${commits.length === 1 ? 'commit' : 'commits'} ahead of your own branch`,
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
        : h('div', { class: 'muted' }, 'Nothing to land: the goal branch has no commits ahead.'),
      // What the daemon noted about the branch (it does not exist yet, it shares no history).
      ...notes.map((n) => note(plain(n, 300))),
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
    section('What Friday did', didBox),
    branchLine,
    section('Commits', commitsBox),
    section(
      'Files',
      filesBox,
      linkButton('Open the full goal diff', () => {
        // A drawer under this dialog takes no input: close first, and let the drawer come back here.
        close();
        openDrawer(ctx, {
          kind: 'diff',
          id: goalId,
          tab: 'goal',
          back: { modal: { kind: 'land', id: goalId }, label: 'Back to landing' },
        });
      }),
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
    // After the diff, which the dialog is for: what the button would do.
    if (!td.done) await readPlan();
  })();

  // The goal detail carries the summary (plan M12.7); read after the diff, which the dialog is for.
  void (async () => {
    try {
      const detail = await ctx.api.goal(goalId);
      if (td.done) return;
      renderDid(detail.summary);
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      replace(
        didBox,
        h(
          'div',
          { class: 'field-error' },
          `Could not read what Friday did: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
      );
    }
  })();

  // A landing made meanwhile (another window) shows without reopening the dialog.
  td.add(ctx.store.subscribe('board', () => renderLand()));

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
