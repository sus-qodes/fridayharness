/**
 * The diff drawer (plan §7.4, handoff Part 05 §3, FD-11): a task's changes (`tasks/:tid/diff`) or a
 * goal branch's (`goals/:gid/diff`, `request.tab === 'goal'`). A file list with labels for protected,
 * linked, binary and too-large files; a discrepancy banner between the agent's claim and what Friday
 * saw; side-by-side or unified views with line numbers, highlighting and a `+N −M` meter; "Open in
 * VS Code". The line diff is computed here (diff.ts); every line is text, with hidden characters
 * shown as visible marks (a bidi override in code is a known way to disguise it).
 */
import type { GoalDiff, RunView, TaskDiff, TaskDiffFile } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component, DrawerRequest } from '../shell/context.js';
import { button, type Child, h, replace } from '../ui/dom.js';
import { cleanText, plural, shortId, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { badge, errorNote, joinPath, loading, mono, shortSha, type Tone } from './common.js';
import { type DiffLine, diffLines, firstChangedLine, type LineDiff, pairRows } from './diff.js';
import { discrepancies, hasDiscrepancy } from './discrepancy.js';
import { languageOf, type Token, tokenizeLines } from './highlight.js';

export type DiffMode = 'unified' | 'split';

/** Rows drawn before "Show the rest" (a 5 000-line file stays responsive). */
export const MAX_ROWS = 1500;

/** The layout chosen last, for the next diff opened in this page. */
let rememberedMode: DiffMode = 'unified';

/** Why a file shows no line diff, or null when it can be diffed. */
export function fileNotice(file: TaskDiffFile, truncated = false): string | null {
  if (file.protected) return 'Protected file: Friday never shows its content.';
  if (file.link) return 'Reached through a link or junction: Friday does not read it.';
  if (file.binary) return 'Binary file: no line diff.';
  if (file.too_large) return 'Too large to show (over 256 KB on a side).';
  const noBefore = file.before === null && file.change !== 'added';
  const noAfter = file.after === null && file.change !== 'deleted';
  if (noBefore && noAfter)
    return truncated ? 'Listed without contents: the diff reached its size cap.' : 'No content was sent for this file.';
  return null;
}

/** The labels of a file in the list. */
export function fileLabels(file: TaskDiffFile): { text: string; tone: Tone }[] {
  const out: { text: string; tone: Tone }[] = [];
  out.push({
    text: file.change,
    tone: file.change === 'added' ? 'good' : file.change === 'deleted' ? 'danger' : 'info',
  });
  if (file.protected) out.push({ text: 'protected', tone: 'warn' });
  if (file.link) out.push({ text: 'link', tone: 'warn' });
  if (file.binary) out.push({ text: 'binary', tone: 'muted' });
  if (file.too_large) out.push({ text: 'too large', tone: 'muted' });
  if (file.uncommitted) out.push({ text: 'uncommitted', tone: 'muted' });
  return out;
}

/** The line diff of a file, or null when it has none to show. */
export function lineDiffOf(file: TaskDiffFile): LineDiff | null {
  if (fileNotice(file)) return null;
  return diffLines(file.before, file.after);
}

function tokensView(tokens: Token[] | undefined, text: string): Child[] {
  if (!tokens) return [visible(text)];
  return tokens.map((t) =>
    t.kind === 'plain' ? visible(t.text) : h('span', { class: `dr-tk dr-tk-${t.kind}` }, visible(t.text)),
  );
}

function lineNo(n: number | null): HTMLElement {
  return h('span', { class: 'dr-ln', aria: { hidden: 'true' } }, n === null ? '' : String(n));
}

const SIGN: Record<DiffLine['kind'], string> = { context: ' ', add: '+', del: '−' };
const SPOKEN: Record<DiffLine['kind'], string> = { context: '', add: 'added', del: 'removed' };

export interface FileDiffOptions {
  mode: DiffMode;
  /** Most rows drawn before a "Show the rest" button (default `MAX_ROWS`). */
  maxRows?: number;
  /** A diff already computed for this file. */
  diff?: LineDiff | null;
  truncated?: boolean;
}

/**
 * One file's diff as DOM: its notice when it cannot be shown, else the hunks. Exported for the
 * approval modal and the verification panel, which show a task's current diff for a file.
 */
export function renderFileDiff(file: TaskDiffFile, opts: FileDiffOptions): HTMLElement {
  const root = h('div', { class: 'dr-filediff' });
  const notice = fileNotice(file, opts.truncated);
  if (notice) {
    root.append(h('div', { class: 'dr-notice' }, notice));
    return root;
  }
  const diff = opts.diff ?? diffLines(file.before, file.after);
  if (diff.identical) {
    root.append(h('div', { class: 'dr-notice' }, 'The contents are the same on both sides.'));
    return root;
  }
  if (diff.replaced) {
    root.append(
      h('div', { class: 'dr-notice' }, 'More than 5 000 lines on a side: shown as a whole-file replacement.'),
    );
  }
  const lang = languageOf(file.path);
  const before = tokenizeLines(file.before, lang);
  const after = tokenizeLines(file.after, lang);
  const oldTokens = (l: DiffLine | null) => (l?.oldNo ? before[l.oldNo - 1] : undefined);
  const newTokens = (l: DiffLine | null) => (l?.newNo ? after[l.newNo - 1] : undefined);
  const rows = h('div', { class: ['dr-rows', opts.mode === 'split' ? 'dr-rows-split' : 'dr-rows-unified'] });
  root.append(h('div', { class: 'dr-code-scroll scroll' }, rows));

  const limit = opts.maxRows ?? MAX_ROWS;
  let drawn = 0;
  let remaining = 0;
  for (const hunk of diff.hunks) {
    if (drawn >= limit) {
      remaining += opts.mode === 'split' ? pairRows(hunk.lines).length : hunk.lines.length;
      continue;
    }
    rows.append(
      h('div', { class: 'dr-hunk' }, `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
    );
    if (opts.mode === 'unified') {
      for (const line of hunk.lines) {
        if (drawn >= limit) {
          remaining++;
          continue;
        }
        drawn++;
        const tokens = line.kind === 'add' ? newTokens(line) : oldTokens(line);
        rows.append(
          h(
            'div',
            { class: ['dr-row', `dr-${line.kind}`] },
            lineNo(line.oldNo),
            lineNo(line.newNo),
            h('span', { class: 'dr-sign', aria: { label: SPOKEN[line.kind] } }, SIGN[line.kind]),
            h('code', { class: 'dr-code' }, tokensView(tokens, line.text)),
          ),
        );
      }
    } else {
      for (const pair of pairRows(hunk.lines)) {
        if (drawn >= limit) {
          remaining++;
          continue;
        }
        drawn++;
        const side = (l: DiffLine | null, which: 'left' | 'right') => {
          if (!l) return h('div', { class: 'dr-side dr-side-empty' }, lineNo(null), h('code', { class: 'dr-code' }));
          const kind = l.kind === 'context' ? 'context' : which === 'left' ? 'del' : 'add';
          const tokens = which === 'left' ? oldTokens(l) : newTokens(l);
          return h(
            'div',
            { class: ['dr-side', `dr-${kind}`] },
            lineNo(which === 'left' ? l.oldNo : l.newNo),
            h('span', { class: 'dr-sign', aria: { label: SPOKEN[kind] } }, SIGN[kind]),
            h('code', { class: 'dr-code' }, tokensView(tokens, l.text)),
          );
        };
        rows.append(h('div', { class: 'dr-row dr-pair' }, side(pair.left, 'left'), side(pair.right, 'right')));
      }
    }
  }
  if (remaining > 0) {
    const more = button(
      `Show the remaining ${plural(remaining, 'line')}`,
      () => {
        root.replaceWith(renderFileDiff(file, { ...opts, diff, maxRows: Number.POSITIVE_INFINITY }));
      },
      { class: 'btn btn-ghost dr-more' },
    );
    root.append(more);
  }
  return root;
}

function counts(added: number | null | undefined, removed: number | null | undefined): HTMLElement {
  return h(
    'span',
    { class: 'dr-delta', aria: { label: `${added ?? 0} lines added, ${removed ?? 0} removed` } },
    h('span', { class: 'dr-delta-add' }, `+${added ?? '—'}`),
    ' ',
    h('span', { class: 'dr-delta-del' }, `−${removed ?? '—'}`),
  );
}

const SOURCE: Record<TaskDiff['source'], string> = {
  worktree: "the current attempt's worktree",
  verified: 'the verified tree',
  integrated: 'the integrated commit',
  none: 'what the agent reported (no contents)',
};

type AnyDiff = TaskDiff | GoalDiff;

export function createDiffViewer(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  const goalMode = request.tab === 'goal';
  const id = request.id ?? '';
  const board = ctx.store.select('board');
  const task = goalMode ? undefined : board?.tasks.find((t) => t.task_id === id);
  const title = goalMode
    ? `Goal diff ${shortId(id)}`
    : task
      ? `Diff · ${truncate(cleanText(task.summary), 48)}`
      : `Diff ${shortId(id)}`;

  let destroyed = false;
  let mode: DiffMode = rememberedMode;
  let data: AnyDiff | null = null;
  let selected: string | null = request.path ?? null;
  const computed = new Map<string, LineDiff | null>();
  let countTimer: ReturnType<typeof setTimeout> | null = null;
  const listItems = new Map<string, HTMLElement>();

  const modeButtons: Record<DiffMode, HTMLButtonElement> = {
    unified: button('Unified', () => setMode('unified'), { class: 'dr-seg', aria: { pressed: mode === 'unified' } }),
    split: button('Side by side', () => setMode('split'), { class: 'dr-seg', aria: { pressed: mode === 'split' } }),
  };
  const segmented = h(
    'div',
    { class: 'segmented', role: 'group', aria: { label: 'Diff layout' } },
    modeButtons.unified,
    modeButtons.split,
  );
  const total = h('span', { class: 'dr-total' });
  const sourceLine = h('div', { class: 'dr-source muted' });
  const banner = h('div', { class: 'dr-banner-slot' });
  const extra = h('div', { class: 'dr-extra' });
  const list = h('ul', { class: 'dr-filelist', aria: { label: 'Changed files' } });
  const main = h('div', { class: 'dr-diff-main' });
  const body = h('div', { class: 'dr-diff-body' }, h('nav', { class: 'dr-filenav scroll' }, list), main);
  const el = h(
    'div',
    { class: 'dr-diffview' },
    h(
      'div',
      { class: 'dr-diff-head' },
      sourceLine,
      h('div', { class: 'row' }, segmented, h('span', { class: 'spacer' }), total),
    ),
    banner,
    extra,
    body,
  );

  function setMode(next: DiffMode): void {
    mode = next;
    rememberedMode = next;
    for (const [m, b] of Object.entries(modeButtons)) b.setAttribute('aria-pressed', String(m === next));
    renderSelected();
  }

  function diffOf(file: TaskDiffFile): LineDiff | null {
    if (!computed.has(file.path)) computed.set(file.path, lineDiffOf(file));
    return computed.get(file.path) ?? null;
  }

  function fileCounts(file: TaskDiffFile): { added: number | null; removed: number | null } {
    if (file.added !== null && file.removed !== null) return { added: file.added, removed: file.removed };
    if (!computed.has(file.path)) return { added: null, removed: null };
    const d = computed.get(file.path);
    return d ? { added: d.added, removed: d.removed } : { added: null, removed: null };
  }

  function renderTotal(): void {
    if (!data) return;
    let added = 0;
    let removed = 0;
    let known = true;
    for (const f of data.files) {
      const c = fileCounts(f);
      if (fileNotice(f)) continue;
      if (c.added === null || c.removed === null) known = false;
      added += c.added ?? 0;
      removed += c.removed ?? 0;
    }
    replace(
      total,
      plural(data.files.length, 'file'),
      ' ',
      known ? counts(added, removed) : h('span', { class: 'muted' }, 'counting…'),
    );
  }

  /** Computes the line counts of the files one per tick, so the list fills without blocking. */
  function countInBackground(): void {
    if (!data || destroyed) return;
    const next = data.files.find((f) => !computed.has(f.path) && !(f.added !== null && f.removed !== null));
    if (!next) {
      countTimer = null;
      renderTotal();
      return;
    }
    diffOf(next);
    updateListItem(next);
    countTimer = setTimeout(countInBackground, 0);
  }

  function updateListItem(file: TaskDiffFile): void {
    const item = listItems.get(file.path);
    const slot = item?.querySelector('.dr-item-counts');
    if (!slot) return;
    const c = fileCounts(file);
    replace(slot, fileNotice(file) ? '' : c.added === null ? '' : counts(c.added, c.removed));
  }

  function rootDir(): string {
    return data?.root ?? ctx.store.select('board')?.project.root ?? '';
  }

  function renderList(): void {
    if (!data) return;
    listItems.clear();
    replace(
      list,
      data.files.map((file) => {
        const c = fileCounts(file);
        const b = button(
          [
            h('span', { class: 'dr-item-path' }, visible(file.path)),
            h(
              'span',
              { class: 'dr-item-meta' },
              fileLabels(file)
                .filter((l) => l.text !== 'uncommitted')
                .map((l) => badge(l.text, l.tone)),
              h(
                'span',
                { class: 'dr-item-counts' },
                fileNotice(file) || c.added === null ? '' : counts(c.added, c.removed),
              ),
            ),
          ],
          () => select(file.path),
          {
            class: ['dr-item', file.path === selected && 'dr-item-on'],
            aria: { current: file.path === selected ? 'true' : 'false' },
            title: visible(file.path),
          },
        );
        const li = h('li', null, b);
        listItems.set(file.path, li);
        return li;
      }),
    );
  }

  function select(path: string): void {
    selected = path;
    for (const [p, li] of listItems) {
      const b = li.querySelector('button');
      b?.classList.toggle('dr-item-on', p === path);
      b?.setAttribute('aria-current', p === path ? 'true' : 'false');
    }
    renderSelected();
  }

  function renderSelected(): void {
    if (!data) return;
    const file = data.files.find((f) => f.path === selected);
    if (!file) {
      replace(main, h('div', { class: 'empty' }, data.files.length ? 'Choose a file.' : 'No changed files.'));
      return;
    }
    const d = diffOf(file);
    updateListItem(file);
    renderTotal();
    const canOpen = !file.protected && !file.link && file.change !== 'deleted';
    const line = d ? firstChangedLine(d) : undefined;
    const c = fileCounts(file);
    replace(
      main,
      h(
        'div',
        { class: 'dr-file-head' },
        h(
          'div',
          { class: 'dr-file-title' },
          mono(file.path, 'dr-file-path'),
          file.orig_path && file.orig_path !== file.path
            ? h('span', { class: 'muted dr-renamed' }, 'from ', mono(file.orig_path))
            : null,
        ),
        h(
          'div',
          { class: 'row-wrap' },
          fileLabels(file).map((l) => badge(l.text, l.tone)),
          c.added !== null ? counts(c.added, c.removed) : null,
          h('span', { class: 'spacer' }),
          canOpen
            ? button(
                [icon('expand', 14), 'Open in VS Code'],
                () => ctx.platform.openInEditor(joinPath(rootDir(), file.path), line),
                {
                  class: 'btn btn-ghost',
                  title: goalMode
                    ? "Opens the main checkout's copy of this file"
                    : 'Opens this file where the agent works',
                },
              )
            : null,
        ),
      ),
      renderFileDiff(file, { mode, diff: d, truncated: data.truncated }),
    );
  }

  function renderBanner(run: RunView | null): void {
    if (!data || goalMode || !run) {
      replace(banner);
      return;
    }
    const d = discrepancies(
      run.claim,
      run.observed_paths,
      data.files.map((f) => f.path),
    );
    if (!d || !hasDiscrepancy(d)) {
      replace(banner);
      return;
    }
    replace(
      banner,
      h(
        'div',
        { class: 'dr-banner dr-banner-warn', role: 'note' },
        h('strong', null, 'Discrepancy between the agent’s claim and what Friday saw'),
        d.claimedNotSeen.length
          ? h(
              'div',
              null,
              'Claimed by the agent but not seen changing by Friday: ',
              d.claimedNotSeen.map((p, i) => [i ? ', ' : '', mono(p)]),
            )
          : null,
        d.seenNotClaimed.length
          ? h(
              'div',
              null,
              'Changed but not in the agent’s claim: ',
              d.seenNotClaimed.map((p, i) => [i ? ', ' : '', mono(p)]),
            )
          : null,
      ),
    );
  }

  function renderHeader(): void {
    if (!data) return;
    if ('commits_ahead' in data) {
      const g = data;
      replace(
        sourceLine,
        'Goal branch ',
        mono(g.branch),
        ` · ${plural(g.commits_ahead.length, 'commit')} ahead of the main checkout · merge base ${shortSha(g.merge_base)}`,
      );
      replace(
        extra,
        g.commits_ahead.length
          ? h(
              'details',
              { class: 'dr-commits' },
              h('summary', null, `Commits (${g.commits_ahead.length})`),
              h(
                'ul',
                null,
                g.commits_ahead.map((c) =>
                  h(
                    'li',
                    null,
                    h('span', { class: 'dr-mono' }, shortSha(c.sha)),
                    ' ',
                    truncate(cleanText(c.subject), 140),
                    h('span', { class: 'muted' }, ` · ${truncate(cleanText(c.author), 60)}`),
                  ),
                ),
              ),
            )
          : null,
        notes(g.notes, g.truncated),
      );
    } else {
      replace(sourceLine, `From ${SOURCE[data.source]}`, data.base ? ` · base ${shortSha(data.base)}` : '');
      replace(extra, notes(data.notes, data.truncated));
    }
  }

  function notes(list: string[], truncated: boolean): Child {
    const items = list.map((n) => h('li', null, truncate(cleanText(n), 300)));
    if (truncated) items.push(h('li', null, 'The diff reached its cap: some files are listed without contents.'));
    return items.length ? h('ul', { class: 'dr-notes muted' }, items) : null;
  }

  async function runOf(): Promise<RunView | null> {
    const fromBoard = ctx.store.select('board')?.runs[id];
    if (fromBoard) return fromBoard;
    try {
      const detail = await ctx.api.task(id);
      return detail.runs?.[detail.runs.length - 1] ?? null;
    } catch {
      return null;
    }
  }

  async function load(): Promise<void> {
    replace(main, loading(goalMode ? 'Reading the goal branch…' : 'Reading the changes…'));
    replace(list);
    try {
      const d = goalMode ? await ctx.api.goalDiff(id) : await ctx.api.taskDiff(id);
      if (destroyed) return;
      data = { ...d, files: d.files ?? [], notes: d.notes ?? [] };
    } catch (e) {
      if (destroyed) return;
      replace(
        main,
        errorNote(goalMode ? 'Could not read the goal diff' : 'Could not read the diff', e),
        button('Try again', () => void load(), { class: 'btn' }),
      );
      return;
    }
    if (!data.files.some((f) => f.path === selected)) selected = data.files[0]?.path ?? null;
    renderHeader();
    renderList();
    renderSelected();
    renderTotal();
    countTimer = setTimeout(countInBackground, 0);
    if (!goalMode) {
      const run = await runOf();
      if (!destroyed) renderBanner(run);
    }
  }

  void load();

  return {
    el,
    title,
    destroy() {
      destroyed = true;
      if (countTimer !== null) clearTimeout(countTimer);
      countTimer = null;
      el.remove();
    },
  };
}

/** Exposed for tests: the layout the next diff opens with. */
export function _rememberedMode(): DiffMode {
  return rememberedMode;
}

export function _setRememberedMode(mode: DiffMode): void {
  rememberedMode = mode;
}
