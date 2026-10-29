/**
 * The scope picker (plan §7.7): a task's write or read globs, chosen by browsing the project's
 * tracked folders (`GET files?dir=`) or typed, each with a live count of the tracked files it
 * matches (`POST files/match`, debounced 300 ms) and a warning when it matches none.
 */
import type { FilesListing } from '@friday/protocol';
import { scopeGlobProblem } from '../model/plan-draft.js';
import { visible } from '../model/text.js';
import type { AppContext, Component } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { errorOf, input, pathText, plain, uid } from './common.js';

export const MATCH_DEBOUNCE_MS = 300;

export interface ScopePickerOptions {
  /** "Write scope" or "Read scope": names the controls for screen readers. */
  label: string;
  value: readonly string[];
  onChange: (globs: string[]) => void;
  /** Shown under an empty list. */
  emptyText?: string;
  debounceMs?: number;
}

export interface ScopePicker extends Component {
  readonly globs: readonly string[];
  /** Replaces the globs (an import) without calling `onChange`. */
  set(globs: readonly string[]): void;
  /** Marks the picker invalid and shows a message under it. */
  setError(message: string | null): void;
  /** The text field (focus target for an error). */
  readonly input: HTMLInputElement;
}

type Count = { state: 'loading' } | { state: 'done'; n: number } | { state: 'error'; message: string };

/** The glob a listing entry adds: a folder as `folder/**`, a file as itself. */
export function globFor(entry: { path: string; kind: 'file' | 'dir' }): string {
  const p = entry.path.replace(/\/+$/, '');
  return entry.kind === 'dir' ? `${p}/**` : p;
}

/** The parent of a project-relative folder (`a/b` → `a`, `a` → ``). */
export function parentDir(dir: string): string {
  const parts = dir.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function scopePicker(ctx: AppContext, opts: ScopePickerOptions): ScopePicker {
  const debounceMs = opts.debounceMs ?? MATCH_DEBOUNCE_MS;
  let globs: string[] = [...opts.value];
  const counts = new Map<string, Count>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let destroyed = false;
  let browseDir = '';
  let browseGen = 0;

  const list = h('ul', { class: 'pn-globs', aria: { label: opts.label } });
  const empty = h('div', { class: 'pn-globs-empty muted' }, opts.emptyText ?? 'No globs yet.');
  const addInput = input({
    class: 'input mono',
    placeholder: 'backend/** or a file path',
    aria: { label: `Add to the ${opts.label.toLowerCase()}` },
  });
  const addError = h('div', { class: 'field-error', hidden: true, role: 'alert' });
  const pickerError = h('div', { class: 'field-error', hidden: true, role: 'alert' });
  const live = h('div', { class: 'visually-hidden', aria: { live: 'polite' } });

  const browser = h('div', { class: 'pn-browser', hidden: true, id: uid('pn-browse') });
  const browseToggle = button([icon('chevronRight', 14), 'Browse folders'], () => toggleBrowser(), {
    class: 'btn btn-ghost pn-browse-toggle',
    aria: { expanded: false, controls: browser.id },
  });

  const addButton = button([icon('plus', 14), 'Add'], () => addFromInput(), { class: 'btn' });
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromInput();
    }
  });
  addInput.addEventListener('input', () => showAddError(null));

  const el = h(
    'div',
    { class: 'pn-scope' },
    list,
    empty,
    h('div', { class: 'pn-scope-add' }, addInput, addButton),
    addError,
    browseToggle,
    browser,
    pickerError,
    live,
  );

  function showAddError(message: string | null) {
    addError.hidden = !message;
    addError.textContent = message ?? '';
    if (message) addInput.setAttribute('aria-invalid', 'true');
    else addInput.removeAttribute('aria-invalid');
  }

  function addFromInput() {
    const glob = addInput.value.trim();
    if (!glob) return;
    const problem = scopeGlobProblem(glob);
    if (problem) {
      showAddError(problem);
      return;
    }
    if (add(glob)) addInput.value = '';
  }

  function add(glob: string): boolean {
    if (globs.includes(glob)) {
      showAddError(`${visible(glob)} is already in the list`);
      return false;
    }
    globs = [...globs, glob];
    changed();
    return true;
  }

  function remove(glob: string) {
    globs = globs.filter((g) => g !== glob);
    counts.delete(glob);
    changed();
  }

  function changed() {
    render();
    schedule();
    opts.onChange([...globs]);
  }

  function render() {
    empty.hidden = globs.length > 0;
    list.replaceChildren(
      ...globs.map((g) => {
        const c = counts.get(g);
        const zero = c?.state === 'done' && c.n === 0;
        return h(
          'li',
          { class: ['pn-glob', zero && 'pn-glob-zero'] },
          pathText(g),
          h(
            'span',
            { class: ['pn-glob-count', zero && 'pn-warn'] },
            !c || c.state === 'loading'
              ? 'counting…'
              : c.state === 'error'
                ? 'not counted'
                : c.n === 0
                  ? 'matches no tracked file'
                  : `${c.n} ${c.n === 1 ? 'file' : 'files'}`,
          ),
          button(icon('close', 12), () => remove(g), {
            class: 'btn btn-ghost btn-icon pn-glob-remove',
            ariaLabel: `Remove ${visible(g)}`,
          }),
        );
      }),
    );
    const zeros = globs.filter((g) => {
      const c = counts.get(g);
      return c?.state === 'done' && c.n === 0;
    });
    live.textContent = zeros.length ? `${zeros.length} of the globs match no tracked file` : '';
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = null;
    generation += 1;
    if (globs.length === 0) return;
    for (const g of globs) if (!counts.has(g) || counts.get(g)?.state === 'error') counts.set(g, { state: 'loading' });
    render();
    timer = setTimeout(() => {
      timer = null;
      void count(generation);
    }, debounceMs);
  }

  async function count(gen: number) {
    const asked = [...globs];
    try {
      const r = await ctx.api.matchFiles(asked);
      if (destroyed || gen !== generation) return;
      for (const g of asked) counts.set(g, { state: 'done', n: Number(r?.counts?.[g] ?? 0) });
    } catch (e) {
      if (destroyed || gen !== generation) return;
      const message = errorOf(e).message;
      for (const g of asked) counts.set(g, { state: 'error', message });
    }
    render();
  }

  function toggleBrowser() {
    const open = browser.hidden;
    browser.hidden = !open;
    browseToggle.setAttribute('aria-expanded', String(open));
    browseToggle.replaceChildren(icon(open ? 'chevronDown' : 'chevronRight', 14), 'Browse folders');
    if (open) void browse(browseDir);
  }

  async function browse(dir: string) {
    browseDir = dir;
    const gen = ++browseGen;
    browser.replaceChildren(crumbs(dir), h('div', { class: 'muted pn-browser-state' }, 'Reading the folder…'));
    let listing: FilesListing;
    try {
      listing = await ctx.api.files(dir);
    } catch (e) {
      if (destroyed || gen !== browseGen) return;
      const err = errorOf(e);
      browser.replaceChildren(
        crumbs(dir),
        h(
          'div',
          { class: 'field-error' },
          `Could not read the folder: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
      );
      return;
    }
    if (destroyed || gen !== browseGen) return;
    const entries = Array.isArray(listing?.entries) ? listing.entries : [];
    const dirs = entries.filter((e) => e.kind === 'dir');
    const files = entries.filter((e) => e.kind === 'file');
    replace(
      browser,
      crumbs(dir),
      entries.length === 0 ? h('div', { class: 'muted pn-browser-state' }, 'No tracked files here.') : null,
      h(
        'ul',
        { class: 'pn-entries' },
        dir
          ? h(
              'li',
              { class: 'pn-entry' },
              button([icon('chevronRight', 12), '..'], () => void browse(parentDir(dir)), {
                class: 'btn btn-ghost pn-entry-open',
                ariaLabel: 'Up one folder',
              }),
            )
          : null,
        dirs.map((d) =>
          h(
            'li',
            { class: 'pn-entry' },
            button([icon('chevronRight', 12), `${visible(d.name)}/`], () => void browse(d.path), {
              class: 'btn btn-ghost pn-entry-open mono',
              ariaLabel: `Open the folder ${visible(d.name)}`,
            }),
            h(
              'span',
              { class: 'muted pn-entry-count' },
              d.files === null ? '' : `${d.files} ${d.files === 1 ? 'file' : 'files'}`,
            ),
            button(`Add ${visible(globFor(d))}`, () => add(globFor(d)), { class: 'btn pn-entry-add' }),
          ),
        ),
        files.map((f) =>
          h(
            'li',
            { class: 'pn-entry' },
            h('span', { class: 'pn-entry-file' }, pathText(f.name)),
            button('Add', () => add(globFor(f)), { class: 'btn pn-entry-add', ariaLabel: `Add ${visible(f.path)}` }),
          ),
        ),
      ),
      listing?.truncated
        ? h('div', { class: 'muted pn-browser-state' }, 'Only the first entries are listed; type a glob for the rest.')
        : null,
    );
  }

  function crumbs(dir: string): HTMLElement {
    const parts = dir.split('/').filter(Boolean);
    return h(
      'nav',
      { class: 'pn-crumbs', aria: { label: 'Folder' } },
      button('project', () => void browse(''), { class: 'btn btn-ghost pn-crumb', ariaLabel: 'The project root' }),
      parts.map((p, i) => [
        h('span', { class: 'muted' }, '/'),
        button(visible(p), () => void browse(parts.slice(0, i + 1).join('/')), {
          class: 'btn btn-ghost pn-crumb mono',
        }),
      ]),
    );
  }

  render();
  if (globs.length) schedule();

  return {
    el,
    input: addInput,
    get globs() {
      return globs;
    },
    set(next) {
      globs = [...next];
      render();
      schedule();
    },
    setError(message) {
      pickerError.hidden = !message;
      pickerError.textContent = message ?? '';
      toggleInvalid(message !== null);
    },
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      el.remove();
    },
  };

  function toggleInvalid(on: boolean) {
    el.classList.toggle('pn-invalid', on);
  }
}
