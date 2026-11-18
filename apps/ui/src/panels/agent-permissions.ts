/**
 * What agents may do without asking, set from Settings (2026-11-17).
 *
 * An agent that runs a command to install a package, delete a file, commit, stop a program, fetch
 * something from the internet, or one Friday does not recognise, waits for a person's approval,
 * each time. Whether it should was `autonomy` in config.yaml (command classes and levels) and a
 * terminal command to trust it. The levels decide commands (the hooks judge each command by its own
 * class); a file changed outside the task's scope and an agent's web tools ask whatever they say. This card says each of those in words with a choice of **Ask me** or
 * **Allow**. Allowing is a loosening: it is written to config.yaml and applies on this computer
 * once the list is trusted, through the same confirmation as every other loosening.
 *
 * What always asks (pushing, force-pushing, publishing) and what is never allowed (reading stored
 * secrets) is said and cannot be changed here: the daemon takes no such setting from a page.
 */
import type { AppContext } from '../shell/context.js';
import { h, replace } from '../ui/dom.js';
import { badge, errorOf, note, plain, segmented, type Teardown } from './common.js';
import { type Loosening, readLoosening } from './settings.js';
import { trustLoosening, trustWhatStays } from './trust.js';

export interface Permission {
  /** The command class (`autonomy.<cls>` in config.yaml). */
  cls: string;
  title: string;
  /** What that looks like, for someone who does not know the class. */
  examples: string;
  /** Said once it is allowed. */
  allowed: string;
}

/** The command classes a person may loosen, in the order shown (the daemon's `ASKABLE_COMMAND_CLASSES`). */
export const PERMISSIONS: readonly Permission[] = [
  {
    cls: 'package.install',
    title: 'Install packages',
    examples: 'npm install, pip install, cargo add',
    allowed: 'Agents install packages without asking',
  },
  {
    cls: 'file.write',
    title: 'Change any file with a command',
    examples:
      'mkdir, cp, mv, sed -i, > file. Inside a task’s own files these already run without asking; this is for the others, and for commands that do not say which files',
    allowed: 'Agents change files with a command without asking, also outside a task’s own files',
  },
  {
    cls: 'git.mutate',
    title: 'Commit and change branches',
    examples: 'git commit, git checkout, git merge, in the task’s own folder',
    allowed: 'Agents commit and change branches without asking',
  },
  {
    cls: 'fs.destructive',
    title: 'Delete files with a command',
    examples: 'rm, del, Remove-Item',
    allowed: 'Agents delete files with a command without asking',
  },
  {
    cls: 'network.fetch',
    title: 'Download with a command',
    examples: 'curl, wget, Invoke-WebRequest',
    allowed: 'Agents download with a command without asking',
  },
  {
    cls: 'process.kill',
    title: 'Stop running programs',
    examples: 'kill, taskkill, Stop-Process',
    allowed: 'Agents stop programs without asking',
  },
  {
    cls: 'unknown',
    title: 'Run commands Friday does not recognise',
    examples: 'anything that is none of the above, nor reading, testing, building or linting',
    allowed: 'Agents run unrecognised commands without asking',
  },
];

export interface PermissionState {
  /** What config.yaml (or another policy file) asks for. */
  level: 'ask' | 'allow';
  /** `allow` is in force: this clone trusted the list it is in. */
  inForce: boolean;
  /** The policy file that allows it when that is not config.yaml: it cannot be changed here. */
  elsewhere: string | null;
}

/** Where one permission stands, from the policy's loosening list. */
export function permissionState(items: readonly Loosening[], trusted: boolean, cls: string): PermissionState {
  const mine = items.filter((l) => l.setting === `autonomy.${cls}` && l.to === 'auto');
  if (!mine.length) return { level: 'ask', inForce: false, elsewhere: null };
  const elsewhere = mine.find((l) => l.source !== 'config.yaml' && l.source !== '.friday/config.yaml');
  return { level: 'allow', inForce: trusted, elsewhere: elsewhere ? elsewhere.source : null };
}

export function agentPermissionsCard(ctx: AppContext, td: Teardown): HTMLElement {
  const body = h('div', { class: 'pn-perm-body' }, note('Reading what agents may do…'));
  const el = h(
    'div',
    { class: 'pn-permissions', dataset: { setup: 'permissions' } },
    h('div', { class: 'pn-qs-title' }, 'What agents may do without asking'),
    note(
      'Commands that read, test, build or lint never ask. For the kinds below, an agent that runs one waits for your approval each time, unless you allow that kind here. Allowing is the project’s setting (in .friday/config.yaml, which your team shares) and applies on this computer once you trust it.',
    ),
    body,
  );
  let policy: ReturnType<typeof readLoosening> | null = null;
  let busy = false;

  async function load() {
    try {
      policy = readLoosening(await ctx.api.policy());
      if (!td.done) render();
    } catch (e) {
      if (td.done) return;
      replace(
        body,
        h('div', { class: 'field-error' }, `The settings could not be read: ${plain(errorOf(e).message, 300)}`),
      );
    }
  }

  async function set(p: Permission, level: 'ask' | 'allow') {
    if (busy) return;
    busy = true;
    try {
      const setting = `autonomy.${p.cls}`;
      const done = await ctx.act(
        level === 'allow' ? p.title : 'Ask me again',
        () => ctx.api.editSettings({ [setting]: level === 'allow' ? 'auto' : 'review' }),
        level === 'allow' ? '' : `Agents ask before they ${p.title.toLowerCase()}`,
      );
      if (done) {
        if (level === 'allow') {
          await trustLoosening(ctx, {
            expects: setting,
            missing: `“${p.title}” is not among the settings that wait for trust`,
            success: p.allowed,
          });
        } else {
          await trustWhatStays(ctx);
        }
      }
    } finally {
      busy = false;
      if (!td.done) {
        ctx.refresh();
        await load();
      }
    }
  }

  function row(p: Permission): HTMLElement {
    const st = permissionState(policy?.items ?? [], policy?.trusted ?? false, p.cls);
    const choice = segmented(
      `${p.title}: ask me, or allow`,
      [
        { value: 'ask', label: 'Ask me', disabled: st.elsewhere !== null },
        { value: 'allow', label: 'Allow', disabled: st.elsewhere !== null },
      ],
      st.level,
      (v) => {
        if (v !== st.level) void set(p, v);
      },
    );
    return h(
      'li',
      { class: 'pn-item pn-perm-item', dataset: { cls: p.cls } },
      h(
        'div',
        { class: 'pn-perm-text pn-grow' },
        h('div', { class: 'pn-perm-title' }, p.title),
        h('div', { class: 'muted pn-perm-examples' }, p.examples),
        st.elsewhere
          ? h('div', { class: 'muted' }, `Allowed by ${plain(st.elsewhere, 120)}, which is changed in that file.`)
          : null,
      ),
      st.level === 'allow' && !st.inForce
        ? badge(
            'waits for your trust',
            'warn',
            'Allowed in the project’s settings, and not in force on this computer yet',
          )
        : null,
      choice,
    );
  }

  function render() {
    replace(
      body,
      h('ul', { class: 'pn-list' }, PERMISSIONS.map(row)),
      note(
        'Always asks you, whatever is set here: pushing to a remote, force-pushing, publishing a package, changing a file outside the task’s scope, and an agent’s own web tools. Never allowed: reading stored secrets.',
      ),
    );
  }

  void load();
  // Trusting (here, or by the list below) changes what is in force: read again when it does.
  const facts = () => JSON.stringify([ctx.store.select('board')?.policy_untrusted ?? null]);
  let seen = facts();
  td.add(
    ctx.store.subscribe('board', () => {
      const now = facts();
      if (now === seen) return;
      seen = now;
      if (!busy) void load();
    }),
  );
  return el;
}
