import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../platform/transport.js';
import { openModal } from '../shell/context.js';
import { mountDrawerHost } from '../shell/drawer-host.js';
import { LayerStack } from '../shell/layers.js';
import { mountModalHost } from '../shell/modal-host.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeAgent, makeApproval, makeSnapshot, makeTask } from '../test/fixtures.js';
import { h } from '../ui/dom.js';
import { approvalModal, isFileTarget } from './approval-modal.js';
import { requestReach } from './decisions.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const APR = 'apr_000000000000000000000ap01';
const TASK = 'task_0000000000000000000000aa01';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function arm(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5, movementX: 1 }));
  vi.advanceTimersByTime(700);
}

function buttonNamed(root: Element, name: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.includes(name));
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

function hold(el: HTMLElement, ms: number): void {
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  vi.advanceTimersByTime(ms);
}

describe('approval modal (macro)', () => {
  let ctx: TestContext;
  let closed: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    closed = 0;
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function open(a = makeApproval(), answers: Record<string, unknown> = {}) {
    ctx = makeContext({
      snapshot: makeSnapshot({ agents: [makeAgent()], tasks: [makeTask()], approvals: [a] }),
      answers: {
        [`POST /approvals/${APR}/approve`]: { ok: true, status: 'granted' },
        [`POST /approvals/${APR}/reject`]: { ok: true, status: 'denied' },
        [`POST /tasks/${TASK}/release`]: { task: makeTask() },
        ...answers,
      },
    });
    const m = approvalModal(ctx, { kind: 'approval', id: a.approval_id }, () => {
      closed += 1;
    });
    document.body.appendChild(m.el);
    vi.advanceTimersByTime(0);
    return m;
  }

  it('says so when the approval is no longer pending', () => {
    ctx = makeContext({ snapshot: makeSnapshot({ approvals: [] }) });
    const m = approvalModal(ctx, { kind: 'approval', id: 'apr_gone' }, () => {
      closed += 1;
    });
    expect(m.el.textContent).toContain('no longer pending');
    buttonNamed(m.el, 'Close').click();
    expect(closed).toBe(1);
    m.destroy();
  });

  it('shows the request in full with visible marks, the binding note and the reach selector', () => {
    const m = open(
      makeApproval({ target: `${HOSTILE}\u202E\u200B${'y'.repeat(5000)}`, purpose: `p ${HOSTILE}`, risk: 'medium' }),
    );
    expect(m.el.querySelector('img')).toBeNull();
    const target = m.el.querySelector('.gv-target .agent-text')?.textContent ?? '';
    expect(target).toContain(HOSTILE);
    expect(target).toContain('⟨U+202E⟩');
    expect(target).toContain('⟨U+200B⟩');
    expect(target).toContain('y'.repeat(5000));
    expect(m.el.querySelector('.gv-target .hidden-warning')).not.toBeNull();
    expect(m.el.textContent).toContain('bound to this task, this attempt and this exact target');
    const reach = [...m.el.querySelectorAll('.gv-reach button')].map((b) => [
      b.textContent,
      b.getAttribute('aria-pressed'),
    ]);
    expect(reach).toEqual([
      ['Once', 'true'],
      ['This attempt', 'false'],
      ['This task', 'false'],
    ]);
    m.destroy();
  });

  it('low risk once: a plain Approve, armed first, sends the chosen reach', async () => {
    const m = open(makeApproval({ risk: 'low' }));
    expect(m.el.querySelector('.gv-hold')).toBeNull();
    buttonNamed(m.el, 'Allow once').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    arm(m.el);
    buttonNamed(m.el, 'This attempt').click();
    buttonNamed(m.el, 'Allow for this attempt').click();
    await flush();
    expect(ctx.transport.to('POST', `/approvals/${APR}/approve`)[0]?.body).toEqual({ reuse: 'run', via: 'ui' });
    expect(closed).toBe(1);
    m.destroy();
  });

  it('the task reach needs the hold, even at low risk', async () => {
    const m = open(makeApproval({ risk: 'low' }));
    arm(m.el);
    buttonNamed(m.el, 'This task').click();
    const holdBtn = m.el.querySelector<HTMLButtonElement>('.gv-hold');
    expect(holdBtn).not.toBeNull();
    holdBtn?.click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    hold(holdBtn as HTMLButtonElement, 1200);
    await flush();
    expect(ctx.transport.to('POST', `/approvals/${APR}/approve`)[0]?.body).toEqual({ reuse: 'task', via: 'ui' });
    m.destroy();
  });

  it('high risk needs the hold at every reach; releasing early grants nothing', async () => {
    const m = open(makeApproval({ risk: 'high', target: 'git push origin main' }));
    arm(m.el);
    const holdBtn = m.el.querySelector<HTMLButtonElement>('.gv-hold') as HTMLButtonElement;
    expect(holdBtn.textContent).toContain('Hold to allow once');
    hold(holdBtn, 1000);
    holdBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    vi.advanceTimersByTime(2000);
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path.includes('/approve'))).toHaveLength(0);
    m.destroy();
  });

  it('a hold that ends after the view moved authorizes nothing, resets and says so (review M9i)', async () => {
    const m = open(makeApproval({ risk: 'high', target: 'git push origin main' }));
    arm(m.el);
    const holdBtn = m.el.querySelector<HTMLButtonElement>('.gv-hold') as HTMLButtonElement;
    hold(holdBtn, 600);
    // Content above the button changed and the dialog moved: the decision disarms mid-hold.
    m.el.getBoundingClientRect = () =>
      ({ x: 0, y: 60, left: 0, top: 60, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
    vi.advanceTimersByTime(800);
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path.includes('/approve'))).toHaveLength(0);
    expect(m.el.textContent).toContain('Not authorized: the view changed while you held. Hold again.');
    expect(holdBtn.classList.contains('gv-held')).toBe(false);
    m.destroy();
  });

  it('the hold does not start before the modal armed', async () => {
    const m = open(makeApproval({ risk: 'high' }));
    const holdBtn = m.el.querySelector<HTMLButtonElement>('.gv-hold') as HTMLButtonElement;
    hold(holdBtn, 1300);
    await flush();
    expect(ctx.transport.calls.filter((c) => c.path.includes('/approve'))).toHaveLength(0);
    m.destroy();
  });

  it('opens with the reach the card asked for', () => {
    requestReach(APR, 'task');
    const m = open(makeApproval({ risk: 'low' }));
    expect(buttonNamed(m.el, 'This task').getAttribute('aria-pressed')).toBe('true');
    expect(m.el.querySelector('.gv-hold')).not.toBeNull();
    m.destroy();
  });

  it('Reject with feedback sends the note', async () => {
    const m = open();
    arm(m.el);
    const note = m.el.querySelector<HTMLTextAreaElement>('.gv-reject-note') as HTMLTextAreaElement;
    note.value = `Do not hardcode secrets ${HOSTILE}`;
    buttonNamed(m.el, 'Reject with feedback').click();
    await flush();
    expect(ctx.transport.to('POST', `/approvals/${APR}/reject`)[0]?.body).toEqual({
      via: 'ui',
      note: `Do not hardcode secrets ${HOSTILE}`,
    });
    expect(closed).toBe(1);
    m.destroy();
  });

  it('Reject and release asks first, then rejects, then releases the task', async () => {
    const m = open();
    arm(m.el);
    ctx.confirmAnswer = false;
    buttonNamed(m.el, 'Reject and release the task').click();
    await flush();
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.transport.calls).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonNamed(m.el, 'Reject and release the task').click();
    await flush();
    expect(ctx.transport.calls.map((c) => c.path.replace(/.*\/projects\/[^/]+/, ''))).toEqual([
      `/approvals/${APR}/reject`,
      `/tasks/${TASK}/release`,
    ]);
    expect(closed).toBe(1);
    m.destroy();
  });

  it('a failed decision keeps the modal open and the approval pending', async () => {
    const m = open(makeApproval(), {
      [`POST /approvals/${APR}/approve`]: () => {
        throw new ApiError(500, 'COS-9000', 'internal', 'boom');
      },
    });
    arm(m.el);
    buttonNamed(m.el, 'Allow once').click();
    await flush();
    expect(closed).toBe(0);
    expect(ctx.store.select('board')?.approvals).toHaveLength(1);
    expect(m.el.textContent).toContain('still pending');
    m.destroy();
  });

  it('says when the approval was decided elsewhere and stops deciding', async () => {
    const m = open();
    arm(m.el);
    ctx.board(makeSnapshot({ approvals: [] }));
    expect(m.el.querySelector('.gv-gone')?.hasAttribute('hidden')).toBe(false);
    expect(buttonNamed(m.el, 'Reject with feedback').disabled).toBe(true);
    m.destroy();
  });

  it('for a file target: the task diff with +N −M per file, a link to the diff, and the impact list', async () => {
    const target = `src/${HOSTILE}\u202E.ts`;
    const m = open(makeApproval({ capability: 'file.write', target, risk: 'medium' }), {
      [`GET /tasks/${TASK}/diff`]: {
        task_id: TASK,
        source: 'worktree',
        root: 'C:/wt/abc',
        base: 'a',
        truncated: false,
        notes: [],
        files: [
          { path: target, change: 'modified', added: 14, removed: 2, binary: false, protected: false },
          { path: '.env', change: 'modified', added: null, removed: null, binary: false, protected: true },
        ],
      },
      'GET /graph/query': {
        version: 'g1',
        node: { path: target },
        dependencies: [],
        consumers: [{ from: 'src/checkout.ts', kind: 'import' }],
        tests: ['test/pricing.test.ts'],
        neighbourhood: [],
      },
    });
    await flush();
    expect(ctx.transport.to('GET', `/tasks/${TASK}/diff`)[0]?.path).toContain('stat=1');
    const summary = m.el.querySelector('.gv-diff-summary') as HTMLElement;
    expect(summary.querySelector('img')).toBeNull();
    expect(summary.textContent).toContain('+14');
    expect(summary.textContent).toContain('−2');
    expect(summary.textContent).toContain('⟨U+202E⟩');
    expect(summary.textContent).toContain('protected');
    expect(summary.querySelector('.gv-file-target')).not.toBeNull();
    expect(m.el.querySelector('.gv-impact')?.textContent).toContain('src/checkout.ts');
    expect(m.el.querySelector('.gv-impact')?.textContent).toContain('test/pricing.test.ts');
    buttonNamed(m.el, 'Open the diff').click();
    expect(closed).toBe(1);
    expect(ctx.store.select('ui').drawer).toEqual({
      kind: 'diff',
      id: TASK,
      path: target,
      back: { modal: { kind: 'approval', id: APR }, label: 'Back to the approval' },
    });
    m.destroy();
  });

  it('says so when the code graph has no answer', async () => {
    const m = open(makeApproval({ capability: 'file.write', target: 'README.md' }), {
      [`GET /tasks/${TASK}/diff`]: { task_id: TASK, source: 'none', files: [], truncated: false, notes: [] },
      'GET /graph/query': () => {
        throw new ApiError(400, 'COS-1000', 'invalid_request', 'not in the graph');
      },
    });
    await flush();
    expect(m.el.querySelector('.gv-impact')?.textContent).toContain('no answer');
    expect(m.el.querySelector('.gv-diff-summary')?.textContent).toContain('no checkout');
    m.destroy();
  });

  it('knows file targets', () => {
    expect(isFileTarget(makeApproval({ capability: 'file.write', target: 'a.ts' }))).toBe(true);
    expect(isFileTarget(makeApproval({ capability: 'shell.git.push', target: 'git push' }))).toBe(false);
    expect(isFileTarget(makeApproval({ capability: 'file.read', target: null }))).toBe(false);
  });
});

describe('the diff from the approval', () => {
  it('opens on top, where it takes input, and Back returns to the approval', async () => {
    const target = 'src/pricing.ts';
    const ctx = makeContext({
      snapshot: makeSnapshot({
        agents: [makeAgent()],
        tasks: [makeTask()],
        approvals: [makeApproval({ capability: 'file.write', target, risk: 'medium' })],
      }),
      answers: {
        [`GET /tasks/${TASK}/diff`]: {
          task_id: TASK,
          source: 'worktree',
          root: 'C:/wt/abc',
          base: 'a',
          truncated: false,
          notes: [],
          files: [{ path: target, change: 'modified', added: 3, removed: 1, binary: false, protected: false }],
        },
        'GET /graph/query': { version: 'g1', node: { path: target }, dependencies: [], consumers: [], tests: [] },
      },
    });
    const layers = new LayerStack(ctx.keys);
    const drawers = mountDrawerHost(ctx, layers);
    const modals = mountModalHost(ctx, layers);
    document.body.append(drawers.el, modals.el);
    ctx.registry.modal('approval', (c, r, close) => approvalModal(c, r, close));
    ctx.registry.drawer('diff', () => ({ el: h('div', { class: 'diff-stub' }), title: 'Diff', destroy() {} }));
    try {
      openModal(ctx, { kind: 'approval', id: APR });
      await flush();
      buttonNamed(modals.el, 'Open the diff').click();
      expect(ctx.store.select('ui').modal).toBeNull();
      const drawer = drawers.el.querySelector<HTMLElement>('[role="dialog"]');
      expect(drawer?.querySelector('.diff-stub')).not.toBeNull();
      expect(layers.modalOpen()).toBe(false);
      expect(layers.top()?.el).toBe(drawer);
      buttonNamed(drawers.el, 'Back to the approval').click();
      expect(ctx.store.select('ui').drawer).toBeNull();
      expect(ctx.store.select('ui').modal).toEqual({ kind: 'approval', id: APR });
      expect(drawers.el.querySelector('[role="dialog"]')).toBeNull();
      expect(modals.el.querySelector('.gv-approval-modal')).not.toBeNull();
    } finally {
      drawers.destroy();
      modals.destroy();
      document.body.replaceChildren();
    }
  });
});
