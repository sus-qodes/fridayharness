/**
 * The project menu (2026-11-18): the project's name in the header opens it. It lists the projects
 * opened lately, newest first, with what each is doing ("open now", "Friday running", "folder not
 * found"), and "Open another folder…". Choosing one switches to it in this window. Before, the name
 * only opened the folder picker, and the switch looked like the app restarting.
 *
 * A small list of buttons under the name: arrows move between them, `Esc` closes and gives focus
 * back to the name, a click or a focus move outside closes it.
 */
import { visible } from '../model/text.js';
import { button, h, replace } from '../ui/dom.js';
import { truncate } from '../ui/format.js';
import type { AppContext, Component, DesktopCommands, RecentProject } from './context.js';
import { focusQuietly } from './layers.js';

export interface ProjectMenu extends Component {
  toggle(): void;
  isOpen(): boolean;
}

/** What a project of the list is doing, in a word or two; null for one that is simply there. */
export function projectState(p: RecentProject): string | null {
  if (p.current) return 'open now';
  if (p.missing) return 'folder not found';
  if (p.running) return 'Friday running';
  return null;
}

export function mountProjectMenu(ctx: AppContext, shell: DesktopCommands, trigger: HTMLButtonElement): ProjectMenu {
  const list = h('div', {
    class: 'sh-menu-list glass-panel sh-project-menu',
    role: 'menu',
    hidden: true,
    aria: { label: 'Projects' },
  });
  let open = false;
  let token = 0;

  const items = () => [...list.querySelectorAll<HTMLButtonElement>('button.sh-menu-item:not([disabled])')];

  function close(focusTrigger: boolean): void {
    if (!open) return;
    open = false;
    token += 1;
    list.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (focusTrigger) focusQuietly(trigger);
  }

  function onOutside(e: Event): void {
    const t = e.target as Node | null;
    if (t && (list.contains(t) || trigger.contains(t))) return;
    close(false);
  }

  const another = () =>
    button(
      'Open another folder…',
      () => {
        close(false);
        void ctx.act('Open another project', () => shell.openProject());
      },
      { class: 'sh-menu-item', role: 'menuitem', dataset: { item: 'another' } },
    );

  function render(projects: RecentProject[] | null, failed: boolean): void {
    const rows = (projects ?? []).map((p) => {
      const state = projectState(p);
      return button(
        [
          h('span', { class: 'sh-pm-name' }, truncate(visible(p.name || p.root), 40)),
          state ? h('span', { class: ['sh-pm-state', p.running && !p.current && 'sh-pm-running'] }, state) : null,
        ],
        () => {
          close(false);
          if (p.current) return;
          ctx.toast({ kind: 'info', text: `Opening ${truncate(visible(p.name), 60)} in this window…` });
          void ctx.act('Open the project', () => shell.openRecent?.(p.root) ?? shell.openProject());
        },
        {
          class: ['sh-menu-item', 'sh-pm-item', p.current && 'sh-pm-current'],
          role: 'menuitem',
          title: visible(p.root),
          disabled: p.missing,
          dataset: { item: 'project', root: p.root },
        },
      );
    });
    replace(
      list,
      projects === null && !failed ? h('div', { class: 'sh-pm-note muted' }, 'Reading your projects…') : null,
      failed ? h('div', { class: 'sh-pm-note muted' }, 'Your recent projects could not be read.') : null,
      ...rows,
      rows.length ? h('div', { class: 'sh-pm-sep', role: 'separator' }) : null,
      another(),
    );
  }

  async function show(): Promise<void> {
    open = true;
    const mine = ++token;
    list.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    render(null, false);
    let projects: RecentProject[] | null = null;
    let failed = false;
    try {
      projects = (await shell.recentProjects?.()) ?? [];
    } catch {
      failed = true;
    }
    if (!open || mine !== token) return;
    render(projects, failed);
    items()[0]?.focus();
  }

  list.addEventListener('keydown', (e: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
      all[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      (e.key === 'Home' ? all[0] : all.at(-1))?.focus();
    }
  });
  list.addEventListener('focusout', (e: FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (list.contains(next) || trigger.contains(next))) return;
    close(false);
  });

  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');

  return {
    el: list,
    toggle() {
      if (open) close(true);
      else void show();
    },
    isOpen: () => open,
    destroy() {
      close(false);
      list.remove();
    },
  };
}
