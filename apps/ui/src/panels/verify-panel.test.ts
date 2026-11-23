import type { TaskDiffFile } from '@friday/protocol';
import { describe, expect, it } from 'vitest';
import { openDrawer, openModal } from '../shell/context.js';
import { mountDrawerHost } from '../shell/drawer-host.js';
import { LayerStack } from '../shell/layers.js';
import { mountModalHost } from '../shell/modal-host.js';
import { makeContext } from '../test/context.js';
import { makeRun, makeSnapshot, makeTask, makeVerification } from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import { BIDI, buttonBy, flush, HOSTILE, LONG, type, ZW } from './test-support.js';
import { changedPaths, checksWording, discrepancies, readClaim, verifyModal } from './verify-panel.js';

const TID = 'task_0000000000000000000000aa01';

function file(path: string, over: Partial<TaskDiffFile> = {}): TaskDiffFile {
  return {
    path,
    change: 'modified',
    orig_path: null,
    committed: false,
    uncommitted: true,
    binary: false,
    too_large: false,
    link: false,
    protected: false,
    before: null,
    after: null,
    added: 2,
    removed: 1,
    ...over,
  };
}

function scenario(checks = [{ name: 'tests', kind: 'test', required: true }], claim: unknown = null) {
  return makeSnapshot({
    verification: { checks, auto_on_completion: false },
    tasks: [makeTask({ task_id: TID, status: 'READY_FOR_VERIFICATION', summary: 'Add discount codes' })],
    runs: { [TID]: makeRun({ task_id: TID, claim, observed_paths: ['src/a.ts'] }) },
  });
}

describe('verification wording (FD-29)', () => {
  it('names the configured checks', () => {
    const w = checksWording([
      { name: 'tests', required: true },
      { name: 'lint', required: false },
    ]);
    expect(w).toEqual({
      button: 'Run checks',
      detail:
        "Runs your project's checks (tests, lint (advisory)), then Friday's own: that only the files it was given changed, with no passwords or keys in them.",
      configured: true,
    });
  });

  it('says what runs without project checks', () => {
    expect(checksWording([]).detail).toBe(
      'Your project has no checks of its own set: Friday checks that the agent changed only the files it was given and left no passwords or keys in them.',
    );
  });
});

describe('claims and discrepancies', () => {
  it('reads a claim and drops what is malformed', () => {
    expect(readClaim(null)).toBeNull();
    expect(readClaim('text')).toBeNull();
    expect(
      readClaim({ summary: 5, changed_paths: ['a', 3], checks: [{ name: 'tests', outcome: 'passed' }, 'junk'] }),
    ).toEqual({
      summary: '',
      changed_paths: ['a'],
      checks: [{ name: 'tests', kind: 'other', command: null, outcome: 'passed', evidence: null }],
      notes: [],
      risks: [],
    });
  });

  it('compares claimed and changed paths', () => {
    expect(discrepancies(['src/a.ts', './src/b.ts', 'src\\c.ts'], ['src/a.ts', 'src/c.ts', 'src/d.ts'])).toEqual({
      claimedUnchanged: ['src/b.ts'],
      changedUnclaimed: ['src/d.ts'],
    });
    expect(changedPaths({ files: [file('new.ts', { change: 'renamed', orig_path: 'old.ts' })] })).toEqual([
      'new.ts',
      'old.ts',
    ]);
  });
});

describe('verification panel', () => {
  it('runs the configured checks', async () => {
    const ctx = makeContext({
      snapshot: scenario(),
      answers: {
        'GET /tasks/task_0000000000000000000000aa01/diff': {
          task_id: TID,
          source: 'worktree',
          root: 'C:/wt',
          base: 'b',
          files: [file('src/a.ts')],
          truncated: false,
          notes: [],
        },
        'POST /tasks/task_0000000000000000000000aa01/verify': {
          task: makeTask(),
          verification: makeVerification({ status: 'PASSED' }),
        },
      },
    });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    await flush();
    expect(m.el.textContent).toContain("Runs your project's checks (tests)");
    buttonBy(m.el, 'Run checks').click();
    await flush();
    const call = ctx.transport.to('POST', `/tasks/${TID}/verify`)[0];
    expect(call?.body).toEqual({});
    expect(call?.opts?.timeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Checks passed' });
    expect(m.el.querySelector('.pn-result')?.textContent).toContain('Passed');
    m.destroy();
  });

  it('shows what a failed check found in words, with its output one click away (2026-11-17)', async () => {
    const failed = makeVerification({
      status: 'FAILED',
      summary: '1 of 2 required checks failed',
      checks: [
        {
          name: 'tests',
          kind: 'test',
          status: 'FAILED',
          exit_code: 1,
          artifact_ref: 'artifact:out1',
          summary: 'exit 1',
          required: true,
          origin: 'configured',
          duration_ms: 900,
          details: null,
        },
        {
          name: 'friday.secrets',
          kind: 'secrets',
          status: 'FAILED',
          exit_code: null,
          artifact_ref: null,
          summary: 'failed: secrets.token',
          required: true,
          origin: 'friday',
          duration_ms: 12,
          details: {
            findings: [
              {
                rule: 'secrets.token',
                severity: 'fail',
                message: `A token is in the change ${HOSTILE}`,
                paths: ['src/a.ts'],
              },
            ],
          },
        },
      ],
    } as never);
    const ctx = makeContext({
      snapshot: scenario(),
      answers: {
        'GET /tasks/task_0000000000000000000000aa01/diff': {
          task_id: TID,
          source: 'worktree',
          root: 'C:/wt',
          base: 'b',
          files: [file('src/a.ts')],
          truncated: false,
          notes: [],
        },
        'POST /tasks/task_0000000000000000000000aa01/verify': { task: makeTask(), verification: failed },
        'GET /artifacts/out1': {
          artifact_ref: 'artifact:out1',
          kind: 'verification',
          text: '1 failing',
          lines: 900,
          from_line: 501,
          truncated: true,
        },
      },
    });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    await flush();
    buttonBy(m.el, 'Run checks').click();
    await flush();
    const result = m.el.querySelector('.pn-verification') as HTMLElement;
    expect(result.textContent).toContain('No credentials in the changes');
    expect(result.textContent).toContain(`A token is in the change ${HOSTILE}`);
    expect(result.textContent).toContain('src/a.ts');
    expect(result.textContent).not.toContain('secrets.token');
    expect(result.querySelector('img')).toBeNull();
    buttonBy(result, 'Show output').click();
    await flush();
    expect(result.querySelector('pre')?.textContent).toBe('1 failing');
    expect(result.textContent).toContain('The end of the output: lines 501 to 900 of 900.');
    m.destroy();
  });

  it('says when the task’s folder is gone, and makes it again from the task’s branch (2026-11-17)', async () => {
    let gone = true;
    const ctx = makeContext({
      snapshot: scenario(),
      answers: {
        'GET /tasks/task_0000000000000000000000aa01/diff': {
          task_id: TID,
          source: 'worktree',
          root: 'C:/wt',
          base: 'b',
          files: [],
          truncated: false,
          notes: [],
        },
        'POST /tasks/task_0000000000000000000000aa01/verify': () => {
          if (gone) {
            throw new Error(
              `the checkout ${TID} worked in is gone (C:/wt/x); restore it from its branch with "friday task worktree ${TID}", or record a result with --result passed|failed`,
            );
          }
          return { task: makeTask(), verification: makeVerification({ status: 'PASSED' }) };
        },
        'POST /tasks/task_0000000000000000000000aa01/worktree': () => {
          gone = false;
          return { worktree: {}, warnings: [], created: true };
        },
      },
    });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    await flush();
    buttonBy(m.el, 'Run checks').click();
    await flush();
    // Said in the dialog, in words, with the way out: no toast naming a terminal command.
    expect(ctx.toasts).toEqual([]);
    const notice = m.el.querySelector('.pn-folder-gone') as HTMLElement;
    expect(notice.textContent).toContain('The task’s folder is gone, so there is nothing to check.');
    expect(m.el.textContent).not.toContain('friday task worktree');
    buttonBy(notice, 'Create the folder again').click();
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${TID}/worktree`)).toHaveLength(1);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'The task folder is back: run the checks again' });
    expect(m.el.querySelector('.pn-folder-gone')).toBeNull();
    buttonBy(m.el, 'Run checks').click();
    await flush();
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Checks passed' });
    m.destroy();
  });

  it('shows any other refusal as it did', async () => {
    const ctx = makeContext({
      snapshot: scenario(),
      answers: {
        'POST /tasks/task_0000000000000000000000aa01/verify': () => {
          throw new Error('a verification of this task is already running');
        },
      },
    });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    await flush();
    buttonBy(m.el, 'Run checks').click();
    await flush();
    expect(ctx.toasts.at(-1)).toMatchObject({
      kind: 'error',
      detail: 'a verification of this task is already running',
    });
    expect(m.el.querySelector('.pn-folder-gone')).toBeNull();
    m.destroy();
  });

  it('follows the task on the board: once it is verified the status says so and Close appears', async () => {
    const ctx = makeContext({ snapshot: scenario([]) });
    let closed = 0;
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => {
      closed += 1;
    });
    await flush();
    const close = () => [...m.el.querySelectorAll('button')].find((b) => b.textContent === 'Close');
    expect(m.el.querySelector('.pn-status')?.textContent).toBe('Done, to be checked');
    expect(close()?.hidden).toBe(true);
    ctx.board(
      makeSnapshot({
        verification: { checks: [], auto_on_completion: false },
        tasks: [makeTask({ task_id: TID, status: 'COMPLETED', summary: 'Add discount codes' })],
      }),
    );
    expect(m.el.querySelector('.pn-status')?.textContent).toBe('Done');
    expect(buttonBy(m.el, "Run Friday's checks").disabled).toBe(true);
    close()?.click();
    expect(closed).toBe(1);
    m.destroy();
  });

  it('says Friday’s own checks run when the project has none', async () => {
    const ctx = makeContext({ snapshot: scenario([]) });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    await flush();
    expect(m.el.textContent).toContain(
      'Your project has no checks of its own set: Friday checks that the agent changed only the files it was given and left no passwords or keys in them.',
    );
    expect(buttonBy(m.el, "Run Friday's checks").disabled).toBe(false);
    expect(m.el.textContent).toContain('verification:');
    m.destroy();
  });

  it('marks passed only after a confirmation, with the note, labelled as skipping every check', async () => {
    const ctx = makeContext({
      snapshot: scenario(),
      answers: {
        'POST /tasks/task_0000000000000000000000aa01/verify': { task: makeTask(), verification: makeVerification() },
      },
    });
    let closed = 0;
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => {
      closed += 1;
    });
    expect(m.el.textContent).toContain('skip every check');
    ctx.confirmAnswer = false;
    buttonBy(m.el, 'Mark passed').click();
    await flush();
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.transport.to('POST', `/tasks/${TID}/verify`)).toHaveLength(0);
    ctx.confirmAnswer = true;
    type(m.el.querySelector('.pn-manual textarea') as HTMLTextAreaElement, ' checked by hand ');
    buttonBy(m.el, 'Mark passed').click();
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${TID}/verify`)[0]?.body).toEqual({
      result: 'passed',
      note: 'checked by hand',
    });
    expect(closed).toBe(1);
    m.destroy();
  });

  it('marks failed without asking', async () => {
    const ctx = makeContext({ snapshot: scenario() });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    buttonBy(m.el, 'Mark failed').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(ctx.transport.to('POST', `/tasks/${TID}/verify`)[0]?.body).toEqual({ result: 'failed' });
    m.destroy();
  });

  it('opens the diff and config.yaml', async () => {
    const opened: string[] = [];
    const ctx = makeContext({ snapshot: scenario() });
    (ctx.platform as { openInEditor: (p: string) => void }).openInEditor = (p) => opened.push(p);
    let closed = 0;
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => {
      closed += 1;
    });
    buttonBy(m.el, 'Open the diff').click();
    // The dialog closes first: a drawer under it would take no input (review R3).
    expect(closed).toBe(1);
    expect(ctx.store.select('ui').drawer).toEqual({
      kind: 'diff',
      id: TID,
      back: { modal: { kind: 'verify', id: TID }, label: 'Back to the checks' },
    });
    buttonBy(m.el, 'Open config.yaml in VS Code').click();
    expect(opened).toEqual(['C:/demo/shop/.friday/config.yaml']);
    expect(m.el.textContent).toContain('new checks are used the next time work is checked');
    m.destroy();
  });

  it('shows hostile claims, file names and checks as text, with discrepancies', async () => {
    const claim = {
      summary: `${HOSTILE} done ${LONG}`,
      changed_paths: [`src/${BIDI}`, 'src/claimed-only.ts'],
      checks: [{ name: HOSTILE, kind: 'test', command: `npm test ${ZW}`, outcome: 'passed', evidence: HOSTILE }],
      risks: [HOSTILE],
    };
    const ctx = makeContext({
      snapshot: scenario(undefined, claim),
      answers: {
        'GET /tasks/task_0000000000000000000000aa01/diff': {
          task_id: TID,
          source: 'worktree',
          root: 'C:/wt',
          base: 'b',
          files: [file(`src/${BIDI}`), file(`${HOSTILE}.ts`), file(LONG, { binary: true, added: null, removed: null })],
          truncated: false,
          notes: [],
        },
      },
    });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    await flush();
    expect(m.el.querySelector('img')).toBeNull();
    const text = m.el.textContent ?? '';
    expect(text).toContain(HOSTILE);
    expect(text).toContain('⟨U+202E⟩');
    expect(text).toContain('⟨U+200B⟩');
    expect(text).not.toContain('\u202E');
    expect(text).toContain('It says it changed these, but they did not change');
    expect(text).toContain('src/claimed-only.ts');
    expect(text).toContain('Changed, but it did not say so');
    expect(m.el.querySelector('.hidden-warning')).not.toBeNull();
    m.destroy();
  });

  it('says when no claim is recorded and when the diff cannot be read', async () => {
    const ctx = makeContext({
      snapshot: scenario(),
      answers: {
        'GET /tasks/task_0000000000000000000000aa01/diff': () => {
          throw new Error('git is not available');
        },
      },
    });
    const m = verifyModal(ctx, { kind: 'verify', id: TID }, () => undefined);
    await flush();
    expect(m.el.textContent).toContain('The agent has not said it is done in this try yet');
    expect(m.el.textContent).toContain('Could not read the diff: git is not available');
    m.destroy();
  });
});

describe('the diff from the verification panel (review R3)', () => {
  it('opens on top, where it takes input, and Back returns to the panel', async () => {
    const ctx = makeContext({ snapshot: scenario() });
    const layers = new LayerStack(ctx.keys);
    const drawers = mountDrawerHost(ctx, layers);
    const modals = mountModalHost(ctx, layers);
    document.body.append(drawers.el, modals.el);
    ctx.registry.modal('verify', (c, r, close) => verifyModal(c, r, close));
    ctx.registry.drawer('diff', () => ({ el: h('div', { class: 'diff-stub' }), title: 'Diff', destroy() {} }));
    try {
      openModal(ctx, { kind: 'verify', id: TID });
      await flush();
      buttonBy(modals.el, 'Open the diff').click();
      expect(ctx.store.select('ui').modal).toBeNull();
      expect(modals.el.querySelector('.sh-modal-backdrop')).toBeNull();
      const drawer = drawers.el.querySelector<HTMLElement>('[role="dialog"]');
      expect(drawer?.querySelector('.diff-stub')).not.toBeNull();
      expect(layers.modalOpen()).toBe(false);
      expect(layers.top()?.el).toBe(drawer);
      buttonBy(drawers.el, 'Back to the checks').click();
      expect(ctx.store.select('ui').drawer).toBeNull();
      expect(ctx.store.select('ui').modal).toEqual({ kind: 'verify', id: TID });
      expect(drawers.el.querySelector('[role="dialog"]')).toBeNull();
      expect(modals.el.querySelector('.pn-verify')).not.toBeNull();
    } finally {
      drawers.destroy();
      modals.destroy();
    }
  });

  it('shows no Back button on a drawer opened from elsewhere', () => {
    const ctx = makeContext({ snapshot: scenario() });
    const drawers = mountDrawerHost(ctx, new LayerStack(ctx.keys));
    ctx.registry.drawer('diff', () => ({ el: h('div'), title: 'Diff', destroy() {} }));
    openDrawer(ctx, { kind: 'diff', id: TID });
    expect(drawers.el.querySelector('.sh-drawer-back')).toBeNull();
    expect(drawers.el.querySelector('.sh-drawer-close')).not.toBeNull();
    drawers.destroy();
  });
});
