/**
 * The "Getting started" checklist (plan §7.1; review §4): Friday running, the project's policy
 * trusted (only while it is not), an agent connected, the planner's state, project checks, a first
 * commit, and notifications while the tab is hidden. Each open item says what it means in interface
 * words and links to where to fix it. Shown until dismissed (`prefs.gettingStartedDismissed`).
 */
import type { UiSnapshot } from '@friday/protocol';
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { linkButton, plannerState, projectPath, Teardown } from './common.js';

export type ChecklistId = 'policy' | 'agent' | 'planner' | 'checks' | 'commit' | 'notify';

export interface ChecklistItem {
  id: ChecklistId;
  done: boolean;
  title: string;
  /** What it means while it is open, in interface words. */
  detail: string;
  /** Where to fix it. */
  fix: {
    label: string;
    action: 'agents' | 'start-agent' | 'planner' | 'checks' | 'config' | 'folder' | 'notifications' | 'policy';
  } | null;
}

/** What the checklist needs besides the board: preferences, and which platform asks to notify. */
export interface ChecklistContext {
  /** `prefs.notifications`: Friday may notify while the page is not in view. */
  notifications: boolean;
  /** The desktop app notifies through Windows; a browser tab through its Notification API. */
  native: boolean;
}

const DEFAULT_CONTEXT: ChecklistContext = { notifications: false, native: false };

/** The checklist's items from the board (pure). */
export function checklist(board: UiSnapshot | null, context: Partial<ChecklistContext> = {}): ChecklistItem[] {
  const c = { ...DEFAULT_CONTEXT, ...context };
  // A session that is there now: one that left or is trying to come back is not a connected agent.
  const connected = (board?.harnesses ?? []).filter((x) =>
    ['REGISTERED', 'READY', 'BUSY'].includes(String(x.status)),
  ).length;
  const planner = plannerState(board?.brain);
  const checks = board?.verification.checks.length ?? 0;
  const commit = board?.project.has_commit ?? true;
  const when = c.native ? 'while the Notch is hidden or the screen is locked' : 'while this tab is hidden';
  // "Friday is running" stood first, always ticked (the list is not there when it is not): it
  // told nobody anything, and made the count read one better than it was (2026-11-17).
  const items: ChecklistItem[] = [];
  // Only while it applies: once trusted (or when nothing loosens), the item leaves the list.
  if (board?.policy_untrusted === true) {
    items.push({
      id: 'policy',
      done: false,
      title: 'Trust this project’s settings',
      detail:
        'This project’s files ask to let Friday or its agents do more than the defaults. None of it applies on this computer until you trust it.',
      fix: { label: 'Settings → Permissions', action: 'policy' },
    });
  }
  items.push(
    {
      id: 'agent',
      done: connected > 0,
      title:
        connected > 0 ? `${connected === 1 ? 'An agent is' : `${connected} agents are`} connected` : 'Connect an agent',
      detail: 'Start Claude Code or Codex from Friday, or connect Claude Code in VS Code or Antigravity.',
      fix: { label: 'Open Agents', action: 'agents' },
    },
    {
      id: 'planner',
      done: planner.ready,
      title: planner.ready ? 'Friday can write plans' : 'Friday cannot write plans yet',
      detail: planner.ready
        ? ''
        : `${planner.fixes.length ? `To let Friday plan: ${planner.fixes.join('; ')}.` : planner.text} You can always write plans yourself.`,
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
        "Verification runs only Friday's own checks (scope, credentials) until the project has its own. Settings suggests them from package.json.",
      fix: { label: 'Settings → Checks', action: 'checks' },
    },
    {
      id: 'commit',
      done: commit,
      title: commit ? 'The repository has a commit' : 'The repository has no commit yet',
      detail:
        'Until the project has a first commit, every agent works in your own project folder instead of a folder of its task. Commit once (VS Code: Source Control → Commit).',
      fix: { label: 'Open the folder in VS Code', action: 'folder' },
    },
    {
      id: 'notify',
      done: c.notifications,
      title: c.notifications ? `You are notified ${when}` : `Get notified ${when}`,
      detail: `Friday tells you about approvals, questions, plans, blocked agents and failures ${when}.`,
      fix: { label: 'Settings → Notifications', action: 'notifications' },
    },
  );
  return items;
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
    else if (action === 'notifications') openDrawer(ctx, { kind: 'settings', tab: 'notifications' });
    else if (action === 'policy') openDrawer(ctx, { kind: 'settings', tab: 'policy' });
    else if (action === 'checks') openDrawer(ctx, { kind: 'settings', tab: 'checks' });
    else if (action === 'config') {
      if (root) ctx.platform.openInEditor(projectPath(root, '.friday/config.yaml'));
    } else if (root) ctx.platform.openInEditor(root);
  }

  function render() {
    const prefs = ctx.store.select('prefs');
    el.hidden = prefs.gettingStartedDismissed;
    if (prefs.gettingStartedDismissed) return;
    const items = checklist(ctx.store.select('board'), {
      notifications: prefs.notifications,
      native: ctx.platform.kind === 'tauri',
    });
    const open = items.filter((i) => !i.done).length;
    summary.textContent = open === 0 ? 'All set.' : `${open} of ${items.length} to do`;
    replace(
      list,
      items.map((item) =>
        h(
          'li',
          { class: ['pn-gs-item', item.done ? 'pn-gs-done' : 'pn-gs-open'], dataset: { item: item.id } },
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
