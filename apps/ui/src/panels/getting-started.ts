/**
 * The "Getting started" checklist (plan §7.1): Friday running, an agent connected, the planner's
 * state, project checks, a first commit. Each open item says what it means in interface words and
 * links to where to fix it. Shown until dismissed (`prefs.gettingStartedDismissed`).
 */
import type { UiSnapshot } from '@friday/protocol';
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { linkButton, plannerState, projectPath, Teardown } from './common.js';

export type ChecklistId = 'running' | 'agent' | 'planner' | 'checks' | 'commit';

export interface ChecklistItem {
  id: ChecklistId;
  done: boolean;
  title: string;
  /** What it means while it is open, in interface words. */
  detail: string;
  /** Where to fix it. */
  fix: { label: string; action: 'agents' | 'start-agent' | 'planner' | 'config' | 'folder' } | null;
}

/** The checklist's items from the board (pure). */
export function checklist(board: UiSnapshot | null): ChecklistItem[] {
  const connected = (board?.harnesses ?? []).filter((x) => x.status !== 'TERMINATED').length;
  const planner = plannerState(board?.brain);
  const checks = board?.verification.checks.length ?? 0;
  const commit = board?.project.has_commit ?? true;
  return [
    { id: 'running', done: true, title: 'Friday is running', detail: '', fix: null },
    {
      id: 'agent',
      done: connected > 0,
      title:
        connected > 0 ? `${connected === 1 ? 'An agent is' : `${connected} agents are`} connected` : 'Connect an agent',
      detail: 'Start Claude Code or Codex from Friday, or set up Claude Code in VS Code.',
      fix: { label: 'Open Agents', action: 'agents' },
    },
    {
      id: 'planner',
      done: planner.ready,
      title: planner.ready ? 'The Master Brain can plan' : 'The Master Brain cannot plan yet',
      detail: planner.ready
        ? ''
        : `${planner.fixes.length ? `To let it plan: ${planner.fixes.join('; ')}.` : planner.text} You can always write plans yourself.`,
      fix: { label: 'Settings → Planner', action: 'planner' },
    },
    {
      id: 'checks',
      done: checks > 0,
      title:
        checks > 0
          ? `${checks === 1 ? '1 project check is' : `${checks} project checks are`} configured`
          : 'No project checks are configured',
      detail:
        "Verification will run Friday's scope and credential checks only. Add your tests under verification.checks.",
      fix: { label: 'Open config.yaml', action: 'config' },
    },
    {
      id: 'commit',
      done: commit,
      title: commit ? 'The repository has a commit' : 'The repository has no commit yet',
      detail: 'Every agent works in the main checkout until you commit once (VS Code: Source Control → Commit).',
      fix: { label: 'Open the folder in VS Code', action: 'folder' },
    },
  ];
}

export function gettingStarted(ctx: AppContext): Component {
  const td = new Teardown();
  const list = h('ul', { class: 'pn-gs-list' });
  const summary = h('span', { class: 'pn-gs-summary muted' });
  const dismiss = button('Dismiss', () => ctx.store.patch('prefs', { gettingStartedDismissed: true }), {
    class: 'btn btn-ghost',
    ariaLabel: 'Dismiss the getting-started checklist',
  });
  const el = h(
    'section',
    { class: 'pn-gs glass-panel', aria: { label: 'Getting started' } },
    h(
      'div',
      { class: 'pn-gs-head' },
      h('h2', { class: 'pn-gs-title' }, 'Getting started'),
      summary,
      h('span', { class: 'spacer' }),
      dismiss,
    ),
    list,
  );

  function fix(action: NonNullable<ChecklistItem['fix']>['action']) {
    const root = ctx.store.select('board')?.project.root ?? '';
    if (action === 'agents') openDrawer(ctx, { kind: 'agents' });
    else if (action === 'start-agent') openModal(ctx, { kind: 'start-agent' });
    else if (action === 'planner') openDrawer(ctx, { kind: 'settings', tab: 'planner' });
    else if (action === 'config') {
      if (root) ctx.platform.openInEditor(projectPath(root, '.friday/config.yaml'));
    } else if (root) ctx.platform.openInEditor(root);
  }

  function render() {
    const dismissed = ctx.store.select('prefs').gettingStartedDismissed;
    el.hidden = dismissed;
    if (dismissed) return;
    const items = checklist(ctx.store.select('board'));
    const open = items.filter((i) => !i.done).length;
    summary.textContent = open === 0 ? 'All set.' : `${open} of ${items.length} to do`;
    replace(
      list,
      items.map((item) =>
        h(
          'li',
          { class: ['pn-gs-item', item.done ? 'pn-gs-done' : 'pn-gs-open'] },
          h('span', { class: 'pn-gs-mark' }, icon(item.done ? 'check' : 'dot', 14, item.done ? 'done' : 'to do')),
          h(
            'div',
            { class: 'pn-gs-text' },
            h('div', { class: 'pn-gs-item-title' }, item.title),
            !item.done && item.detail ? h('div', { class: 'muted' }, item.detail) : null,
            // Under the text, so the checklist fits the rail beside the Studio.
            !item.done && item.fix
              ? h(
                  'div',
                  { class: 'pn-gs-fix' },
                  linkButton(item.fix.label, () => fix((item.fix as NonNullable<ChecklistItem['fix']>).action)),
                )
              : null,
          ),
        ),
      ),
    );
  }

  td.add(ctx.store.subscribe('board', render));
  td.add(ctx.store.subscribe('prefs', render));
  render();

  return {
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
