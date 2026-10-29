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
      detail: "Runs the project's checks (tests, lint (advisory)), then Friday's scope and credential checks.",
      configured: true,
    });
  });

  it('says what runs without project checks', () => {
    expect(checksWording([]).detail).toBe(
      "No project checks are configured: Friday's scope and credential checks will run.",
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
    expect(m.el.textContent).toContain("Runs the project's checks (tests)");
    buttonBy(m.el, 'Run checks').click();
    await flush();
    const call = ctx.transport.to('POST', `/tasks/${TID}/verify`)[0];
    expect(call?.body).toEqual({});
    expect(call?.opts?.timeoutMs).toBeGreaterThanOrEqual(300_000);
    expect(ctx.toasts.at(-1)).toEqual({ kind: 'success', text: 'Verification Passed' });
    expect(m.el.querySelector('.pn-result')?.textContent).toContain('Passed');
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
    expect(m.el.querySelector('.pn-status')?.textContent).toBe('Ready for verification');
    expect(close()?.hidden).toBe(true);
    ctx.board(
      makeSnapshot({
        verification: { checks: [], auto_on_completion: false },
        tasks: [makeTask({ task_id: TID, status: 'COMPLETED', summary: 'Add discount codes' })],
      }),
    );
    expect(m.el.querySelector('.pn-status')?.textContent).toBe('Completed');
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
      "No project checks are configured: Friday's scope and credential checks will run.",
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
      back: { modal: { kind: 'verify', id: TID }, label: 'Back to verification' },
    });
    buttonBy(m.el, 'Open config.yaml in VS Code').click();
    expect(opened).toEqual(['C:/demo/shop/.friday/config.yaml']);
    expect(m.el.textContent).toContain('new checks judge the next verification');
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
    expect(text).toContain('Claimed but unchanged');
    expect(text).toContain('src/claimed-only.ts');
    expect(text).toContain('Changed but not claimed');
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
    expect(m.el.textContent).toContain('No completion claim is recorded');
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
      buttonBy(drawers.el, 'Back to verification').click();
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
