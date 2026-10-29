import type { GoalDiff, TaskDiff, TaskDiffFile } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeRun, makeSnapshot, makeTask } from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import { _setRememberedMode, createDiffViewer, fileLabels, fileNotice, renderFileDiff } from './diff-viewer.js';

const IMG = '<img src=x onerror=alert(1)>';
const BIDI = '\u202E';
const ZW = '\u200B';
const LONG = 'y'.repeat(5000);
const TID = 'task_0000000000000000000000aa01';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function file(o: Partial<TaskDiffFile> = {}): TaskDiffFile {
  return {
    path: 'src/a.ts',
    change: 'modified',
    orig_path: null,
    committed: false,
    uncommitted: true,
    binary: false,
    too_large: false,
    link: false,
    protected: false,
    before: 'const a = 1;\n',
    after: 'const a = 2;\n',
    added: null,
    removed: null,
    ...o,
  };
}

const HOSTILE_AFTER = `const a = 1;\n${IMG}\n"${BIDI}evil"\nzero${ZW}width\n${LONG}\n`;

afterEach(() => {
  _setRememberedMode('unified');
});

describe('renderFileDiff', () => {
  it('renders hostile lines as text with visible marks', () => {
    const el = renderFileDiff(file({ before: 'const a = 1;\n', after: HOSTILE_AFTER }), { mode: 'unified' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain(IMG);
    expect(el.textContent).toContain('⟨U+202E⟩');
    expect(el.textContent).toContain('⟨U+200B⟩');
    expect(el.textContent).not.toContain(BIDI);
    expect(el.textContent).toContain(LONG);
    expect(el.querySelectorAll('.dr-row.dr-add')).toHaveLength(4);
    expect(el.querySelectorAll('.dr-row.dr-context')).toHaveLength(1);
    expect(el.querySelector('.dr-hunk')?.textContent).toBe('@@ -1,1 +1,5 @@');
    const lineNos = [...el.querySelectorAll('.dr-row.dr-add')].map((r) => r.querySelectorAll('.dr-ln')[1]?.textContent);
    expect(lineNos).toEqual(['2', '3', '4', '5']);
  });

  it('highlights by language with classes, never markup', () => {
    const el = renderFileDiff(file({ before: '', after: `const s = '${IMG}';\n`, change: 'added' }), {
      mode: 'unified',
    });
    expect(el.querySelector('.dr-tk-keyword')?.textContent).toBe('const');
    expect(el.querySelector('.dr-tk-string')?.textContent).toBe(`'${IMG}'`);
    expect(el.querySelector('img')).toBeNull();
  });

  it('pairs rows side by side', () => {
    const el = renderFileDiff(file({ before: 'a\nb\nc\n', after: 'a\nx\ny\nc\n' }), { mode: 'split' });
    const rows = el.querySelectorAll('.dr-pair');
    expect(rows).toHaveLength(4);
    expect(rows[1]?.querySelector('.dr-del')?.textContent).toContain('b');
    expect(rows[1]?.querySelector('.dr-add')?.textContent).toContain('x');
    expect(rows[2]?.querySelector('.dr-side-empty')).not.toBeNull();
  });

  it.each([
    [{ protected: true }, 'Protected file'],
    [{ link: true }, 'link or junction'],
    [{ binary: true }, 'Binary file'],
    [{ too_large: true }, 'Too large'],
    [{ before: null, after: null }, 'No content'],
  ])('says why %j shows no diff', (flags, text) => {
    const f = file(flags as Partial<TaskDiffFile>);
    expect(fileNotice(f)).toContain(text);
    const el = renderFileDiff(f, { mode: 'unified' });
    expect(el.querySelector('.dr-notice')?.textContent).toContain(text);
    expect(el.querySelector('.dr-row')).toBeNull();
  });

  it('labels files', () => {
    expect(fileLabels(file({ change: 'added', protected: true, link: true })).map((l) => l.text)).toEqual([
      'added',
      'protected',
      'link',
      'uncommitted',
    ]);
  });

  it('draws at most maxRows rows, then the rest on request', () => {
    const after = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const holder = h('div');
    holder.append(renderFileDiff(file({ before: null, after, change: 'added' }), { mode: 'unified', maxRows: 100 }));
    expect(holder.querySelectorAll('.dr-row')).toHaveLength(100);
    const more = holder.querySelector<HTMLButtonElement>('.dr-more');
    expect(more?.textContent).toBe('Show the remaining 200 lines');
    more?.click();
    expect(holder.querySelectorAll('.dr-row')).toHaveLength(300);
    expect(holder.querySelector('.dr-more')).toBeNull();
  });

  it('says when a side is over the cap', () => {
    const big = Array.from({ length: 5001 }, (_, i) => `l${i}`).join('\n');
    const el = renderFileDiff(file({ before: big, after: `${big}\nx` }), { mode: 'unified', maxRows: 10 });
    expect(el.textContent).toContain('whole-file replacement');
  });
});

function taskDiff(files: TaskDiffFile[], o: Partial<TaskDiff> = {}): TaskDiff {
  return {
    task_id: TID,
    source: 'worktree',
    root: 'C:/wt/abc',
    base: 'b'.repeat(40),
    files,
    truncated: false,
    notes: [],
    ...o,
  };
}

describe('the diff drawer', () => {
  function setup(files: TaskDiffFile[], opts: { path?: string; claim?: unknown; observed?: string[] } = {}) {
    const ctx = makeContext({
      snapshot: makeSnapshot({
        tasks: [makeTask({ summary: `Fix ${IMG} pricing` })],
        runs: { [TID]: makeRun({ claim: opts.claim ?? null, observed_paths: opts.observed ?? [] }) },
      }),
      answers: { [`GET /tasks/${TID}/diff`]: taskDiff(files, { notes: [`note ${IMG}`] }) },
    });
    const open = vi.fn();
    (ctx.platform as { openInEditor: (p: string, l?: number) => void }).openInEditor = open;
    const drawer = createDiffViewer(ctx, { kind: 'diff', id: TID, ...(opts.path ? { path: opts.path } : {}) });
    document.body.append(drawer.el);
    return { ctx, drawer, open };
  }

  it('lists the files with labels and hostile names as text', async () => {
    const hostilePath = `src/${IMG}${BIDI}${ZW}.ts`;
    const { drawer, ctx } = setup([
      file({ path: hostilePath, after: HOSTILE_AFTER }),
      file({ path: '.env', protected: true, before: null, after: null }),
      file({ path: 'logo.png', binary: true, before: null, after: null }),
    ]);
    await settle();
    expect(ctx.transport.to('GET', `/tasks/${TID}/diff`)).toHaveLength(1);
    const items = drawer.el.querySelectorAll('.dr-filelist li');
    expect(items).toHaveLength(3);
    expect(drawer.el.querySelector('img')).toBeNull();
    expect(items[0]?.textContent).toContain('⟨U+202E⟩⟨U+200B⟩');
    expect(items[1]?.textContent).toContain('protected');
    expect(items[2]?.textContent).toContain('binary');
    expect(drawer.el.querySelector('.dr-item-on')?.textContent).toContain('⟨U+202E⟩');
    expect(drawer.el.querySelectorAll('.dr-diff-main .dr-row.dr-add').length).toBeGreaterThan(0);
    expect(drawer.el.querySelector('.dr-notes')?.textContent).toContain(IMG);
    expect(drawer.title).toContain(IMG);
    expect(drawer.el.querySelector('.dr-total')?.textContent).toBe('3 files +4 −0');
    drawer.destroy();
  });

  it('opens on the requested file and switches layouts', async () => {
    const { drawer } = setup([file({ path: 'a.ts' }), file({ path: 'b.ts', before: 'x\n', after: 'y\n' })], {
      path: 'b.ts',
    });
    await settle();
    const current = drawer.el.querySelector('[aria-current="true"]');
    expect(current?.textContent).toContain('b.ts');
    expect(drawer.el.querySelector('.dr-rows-unified')).not.toBeNull();
    const split = [...drawer.el.querySelectorAll<HTMLButtonElement>('.segmented button')].find(
      (b) => b.textContent === 'Side by side',
    );
    split?.click();
    expect(split?.getAttribute('aria-pressed')).toBe('true');
    expect(drawer.el.querySelector('.dr-rows-split')).not.toBeNull();
    const other = [...drawer.el.querySelectorAll<HTMLButtonElement>('.dr-item')].find((b) =>
      b.textContent?.includes('a.ts'),
    );
    other?.click();
    expect(other?.getAttribute('aria-current')).toBe('true');
    expect(drawer.el.querySelector('.dr-rows-split')).not.toBeNull();
    drawer.destroy();
    const again = setup([file()]);
    await settle();
    expect(again.drawer.el.querySelector('.dr-rows-split')).not.toBeNull();
    again.drawer.destroy();
  });

  it('opens the file where the agent works, at the first change', async () => {
    const { drawer, open } = setup([file({ path: 'src/x.ts', before: 'a\nb\nc\n', after: 'a\nb\nC\n' })]);
    await settle();
    const button = [...drawer.el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Open in VS Code'),
    );
    button?.click();
    expect(open).toHaveBeenCalledWith('C:/wt/abc/src/x.ts', 3);
    drawer.destroy();
  });

  it('flags what the claim lists but Friday did not see, and the reverse', async () => {
    const { drawer } = setup([file({ path: 'src/a.ts' }), file({ path: `src/${BIDI}b.ts` })], {
      claim: { changed_paths: ['src/a.ts', 'src/ghost.ts'] },
      observed: ['src/a.ts'],
    });
    await settle();
    const banner = drawer.el.querySelector('.dr-banner-warn');
    expect(banner?.textContent).toContain('Claimed by the agent but not seen changing by Friday: src/ghost.ts');
    expect(banner?.textContent).toContain('Changed but not in the agent’s claim: src/⟨U+202E⟩b.ts');
    drawer.destroy();
  });

  it('shows no banner without a claim', async () => {
    const { drawer } = setup([file()]);
    await settle();
    expect(drawer.el.querySelector('.dr-banner-warn')).toBeNull();
    drawer.destroy();
  });

  it('shows the error code and lets the user try again', async () => {
    const ctx = makeContext({
      answers: {
        [`GET /tasks/${TID}/diff`]: () => {
          throw new Error('git is not available');
        },
      },
    });
    const drawer = createDiffViewer(ctx, { kind: 'diff', id: TID });
    await settle();
    expect(drawer.el.querySelector('.dr-error')?.textContent).toContain('git is not available');
    ctx.transport.answers[`GET /tasks/${TID}/diff`] = taskDiff([file()]);
    [...drawer.el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Try again')?.click();
    await settle();
    expect(drawer.el.querySelector('.dr-error')).toBeNull();
    expect(drawer.el.querySelectorAll('.dr-filelist li')).toHaveLength(1);
    drawer.destroy();
  });

  it('reads a goal branch for a goal', async () => {
    const goal: GoalDiff = {
      goal_id: 'goal_1',
      source: 'goal',
      branch: `friday/goal-1${BIDI}`,
      head: 'c'.repeat(40),
      merge_base: 'd'.repeat(40),
      root: 'C:/demo/shop',
      base: 'd'.repeat(40),
      commits_ahead: [{ sha: 'e'.repeat(40), subject: `Add ${IMG}`, author: 'Friday', date: '2026-10-17' }],
      files: [file()],
      truncated: false,
      notes: [],
    };
    const ctx = makeContext({ answers: { 'GET /goals/goal_1/diff': goal } });
    const drawer = createDiffViewer(ctx, { kind: 'diff', id: 'goal_1', tab: 'goal' });
    await settle();
    expect(ctx.transport.to('GET', '/goals/goal_1/diff')).toHaveLength(1);
    expect(drawer.el.querySelector('.dr-source')?.textContent).toContain('friday/goal-1⟨U+202E⟩');
    expect(drawer.el.querySelector('.dr-source')?.textContent).toContain('1 commit ahead');
    expect(drawer.el.querySelector('.dr-commits')?.textContent).toContain(`Add ${IMG}`);
    expect(drawer.el.querySelector('img')).toBeNull();
    expect(drawer.el.querySelector('.dr-banner-warn')).toBeNull();
    drawer.destroy();
  });

  it('stops its background counting when destroyed', async () => {
    vi.useFakeTimers();
    try {
      const ctx = makeContext({ answers: { [`GET /tasks/${TID}/diff`]: taskDiff([file(), file({ path: 'b.ts' })]) } });
      const drawer = createDiffViewer(ctx, { kind: 'diff', id: TID });
      await vi.advanceTimersByTimeAsync(0);
      drawer.destroy();
      expect(vi.getTimerCount()).toBe(0);
      expect(drawer.el.isConnected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
