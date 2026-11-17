/**
 * "Settings files for agents' copies" (2026-11-17): `worktrees.files`. Each agent Friday starts
 * works in its own copy of the project, made from version control, and Friday checks combined work
 * in a copy of its own. A settings file the project keeps out of version control (`.env`) is in
 * none of them, so a project whose tests read it failed every check there, though the work was
 * right. A person ticks which of their files the copies get. It is a loosening: programs run in a
 * copy can read what it was given, so this computer trusts the list first.
 *
 * A file named `.env.agents.local` (or `.env.agents`) is one kept for agents, without real keys:
 * ticked, it is given to the copies under the name `.env`, beside which it stands.
 */
import type { CopiedFile, CopyFilesView } from '../api/client.js';
import type { AppContext } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { badge, note, type Teardown } from './common.js';
import { trustLoosening, trustWhatStays } from './trust.js';

const SETTING = 'worktrees.files';
const FOR_AGENTS = /^\.env\.agents(\.local)?$/;

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** The name a file gets in a copy when it is ticked: its own, or `.env` for a file kept for agents. */
export function nameInCopy(path: string): string {
  return FOR_AGENTS.test(nameOf(path)) ? `${folderOf(path)}.env` : path;
}

export interface CopyRow {
  path: string;
  /** Its name in a copy: what is listed, else what ticking it would give. */
  to: string;
  /** `on`: the copies get it; `waiting`: listed, and this computer has not approved the list; `off`. */
  state: 'on' | 'waiting' | 'off';
  /** Listed, and no longer in the project folder (or no longer ignored). */
  gone: boolean;
}

/** One row per file Friday found, and per file that is listed and was not found, by path. */
export function copyRows(view: CopyFilesView): CopyRow[] {
  const paths = [...new Set([...view.found, ...view.files.map((f) => f.from)])].sort();
  return paths.map((path) => {
    const listed = view.files.find((f) => f.from === path);
    const to = listed?.to ?? nameInCopy(path);
    const inForce = view.in_force.some((f) => f.from === path && f.to === to);
    return {
      path,
      to,
      state: listed ? (inForce ? 'on' : 'waiting') : 'off',
      gone: Boolean(listed) && !view.found.includes(path),
    };
  });
}

/** The list after a tick on `path`: taken out when it was listed; else added, in place of any file with its name. */
export function tickedList(view: CopyFilesView, path: string): CopiedFile[] {
  if (view.files.some((f) => f.from === path)) return view.files.filter((f) => f.from !== path);
  const to = nameInCopy(path);
  return [...view.files.filter((f) => f.to !== to), { from: path, to }];
}

/** The list as config.yaml takes it: `to` only where it differs. */
const asSetting = (files: readonly CopiedFile[]) =>
  files.map((f) => (f.to === f.from ? { from: f.from } : { from: f.from, to: f.to }));

export function copyFilesCard(ctx: AppContext, td: Teardown): HTMLElement {
  let view: CopyFilesView | null = null;
  let failed = false;
  let busy = false;
  const body = h('div', { class: 'pn-qs-body' });
  const el = h(
    'div',
    { class: 'pn-quick-setup', dataset: { setup: 'copy-files' } },
    h('div', { class: 'pn-qs-title' }, 'Settings files for agents’ copies'),
    note(
      'Each agent Friday starts works in its own copy of your project, and Friday checks combined work in a copy of its own. A copy is made from version control, so a settings file such as .env is not in it, and tests that read it fail there. Tick the files the copies should get.',
    ),
    body,
  );

  async function load() {
    try {
      // An older daemon answers without these lists: nothing is found, and nothing breaks.
      const got = (await ctx.api.copyFiles()) as Partial<CopyFilesView> | null;
      view = {
        files: Array.isArray(got?.files) ? got.files : [],
        in_force: Array.isArray(got?.in_force) ? got.in_force : [],
        found: Array.isArray(got?.found) ? got.found : [],
      };
      failed = false;
    } catch {
      failed = true;
    }
    if (!td.done) render();
  }

  async function approve() {
    if (busy) return;
    busy = true;
    render();
    try {
      await trustLoosening(ctx, {
        expects: SETTING,
        missing: 'Giving files to the copies is not among the settings that wait for trust',
        why: 'Programs an agent runs in its copy can read these files. Agents themselves are kept from opening a .env file.',
        success: 'Agents’ copies now get the files you chose',
      });
    } finally {
      busy = false;
      if (!td.done) {
        ctx.refresh();
        await load();
      }
    }
  }

  async function tick(path: string) {
    if (busy || !view) return;
    busy = true;
    render();
    try {
      const next = tickedList(view, path);
      const set = await ctx.act('Change the files for agents’ copies', () =>
        ctx.api.editSettings({ [SETTING]: asSetting(next) }),
      );
      if (set) {
        if (next.length) {
          await trustLoosening(ctx, {
            expects: SETTING,
            missing: 'Giving files to the copies is not among the settings that wait for trust',
            why: 'Programs an agent runs in its copy can read these files. Agents themselves are kept from opening a .env file.',
            success: 'Agents’ copies now get the files you chose',
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

  function render() {
    if (failed) {
      replace(
        body,
        note('Friday could not read which settings files this project has. Reopen this page to try again.'),
      );
      return;
    }
    if (!view) {
      replace(body, note('Looking for settings files…'));
      return;
    }
    const rows = copyRows(view);
    if (!rows.length) {
      replace(
        body,
        note(
          'Friday found no settings file in this project that is kept out of version control (.env, .env.local), so the copies lack nothing.',
        ),
      );
      return;
    }
    const waiting = rows.some((r) => r.state === 'waiting');
    replace(
      body,
      h(
        'div',
        { class: 'pn-landing-choices', role: 'group', aria: { label: 'Files the copies of the project get' } },
        rows.map((r) =>
          button(
            [
              h(
                'span',
                { class: 'pn-landing-label' },
                r.path,
                r.state === 'waiting' ? badge('Waits for your approval', 'warn') : null,
                r.gone ? badge('Not in the project folder now', 'warn') : null,
              ),
              h(
                'span',
                { class: 'pn-landing-what muted' },
                r.to === r.path
                  ? 'The copies get this file as it is.'
                  : `The copies get this file under the name ${r.to}. Your own ${r.to} stays in your folder only.`,
              ),
            ],
            () => void tick(r.path),
            {
              class: ['btn', 'pn-landing-choice', r.state === 'off' ? '' : 'is-on'].filter(Boolean).join(' '),
              disabled: busy,
              role: 'checkbox',
              aria: { checked: r.state === 'off' ? 'false' : 'true' },
              dataset: { file: r.path },
            },
          ),
        ),
      ),
      waiting
        ? h(
            'div',
            { class: 'pn-qs-actions' },
            button('Approve on this computer', () => void approve(), {
              class: 'btn btn-primary',
              disabled: busy,
              dataset: { action: 'approve-copy-files' },
            }),
          )
        : null,
      note(
        'Programs an agent runs in its copy (your tests) can read these files; Friday keeps the agents themselves from opening a .env file. To keep real keys out of the copies, save a version without them as .env.agents.local and tick that one: the copies get it as .env.',
      ),
    );
  }

  render();
  void load();
  return el;
}
