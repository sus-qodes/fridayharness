import type { ContextExplanation, ContextPacket, TaskDiff, TaskDiffFile } from '@friday/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { RecordedCall } from '../test/context.js';
import { makeContext } from '../test/context.js';
import {
  makeEscalation,
  makeEvent,
  makeRun,
  makeSnapshot,
  makeTask,
  makeVerification,
  PID,
  T0,
} from '../test/fixtures.js';
import { createTaskInspector, INSPECTOR_TABS, inspectorActions, inspectorTabOf } from './task-inspector.js';

const IMG = '<img src=x onerror=alert(1)>';
const BIDI = '\u202E';
const ZW = '\u200B';
const LONG = 'z'.repeat(5000);
const TID = 'task_0000000000000000000000aa01';
const DEP = 'task_00000000000000000000dep001';
const NEXT = 'task_00000000000000000000nxt001';

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function buttonNamed(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
}

function boardWith(status: string, extra: Partial<ReturnType<typeof makeTask>> = {}) {
  return makeSnapshot({
    tasks: [
      makeTask({
        status: status as never,
        summary: `Fix ${IMG} pricing ${BIDI}now`,
        description: `${IMG}\n${LONG}`,
        acceptance_criteria: [`tests pass ${IMG}`],
        scope: { write: [`src/${BIDI}**`], read: [`docs/${ZW}**`] },
        dependencies: [DEP],
        agent_key: 'claude-1',
        ...extra,
      }),
      makeTask({ task_id: DEP, summary: 'Prepare the API', status: 'COMPLETED' }),
      makeTask({ task_id: NEXT, summary: 'Document it', dependencies: [TID] }),
    ],
    runs: { [TID]: makeRun({ branch_ref: `friday/task-${BIDI}x`, execution_root: 'C:/wt/abc' }) },
    verifications: {
      [TID]: makeVerification({
        commit_sha: 'f'.repeat(40),
        summary: `ran ${IMG}`,
        checks: [
          {
            name: `tests ${IMG}`,
            kind: 'test',
            status: 'PASSED',
            exit_code: 0,
            artifact_ref: null,
            summary: 'ok',
            required: true,
            origin: 'configured',
            duration_ms: 4200,
            details: null,
          },
          {
            name: 'friday.diff',
            kind: 'diff',
            status: 'FAILED',
            exit_code: null,
            artifact_ref: null,
            summary: null,
            required: false,
            origin: 'friday',
            duration_ms: 30,
            details: null,
          },
        ],
      }),
    },
    integrations: {
      [TID]: {
        integration_id: 'int_1',
        goal_id: 'goal_1',
        task_id: TID,
        status: 'conflicted',
        branch: 'friday/goal-1',
        task_commit: null,
        base_commit: null,
        merged_commit: null,
        conflicts: [`src/${BIDI}a.ts`],
        checks: [],
        summary: `conflict ${IMG}`,
        created_at: T0,
      },
    },
  });
}

describe('inspectorActions', () => {
  it.each([
    ['READY', null, false, ['cancel']],
    ['READY_FOR_VERIFICATION', null, false, ['verify', 'cancel']],
    ['WAITING', 'blocked', false, ['continue', 'cancel']],
    ['WAITING', 'agent_error', false, ['continue', 'recover', 'cancel']],
    ['FAILED', null, false, ['rework', 'cancel']],
    ['HARNESS_LOST', null, false, ['recover', 'cancel']],
    ['RUNNING', null, true, ['recover', 'cancel']],
    ['COMPLETED', null, false, []],
    ['CANCELLED', null, false, []],
  ])('%s (%s, recovery question %s) → %j', (status, reason, recoveryQuestion, actions) => {
    expect(
      inspectorActions({ status: status as never, waiting_reason: reason as never }, { recoveryQuestion }),
    ).toEqual(actions);
  });
});

describe('the task inspector: tabs', () => {
  it('names them Overview · Changes · History · What the agent was given, in that order (review M9k)', () => {
    const ctx = makeContext({ snapshot: boardWith('READY') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    const tabs = [...drawer.el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['Overview', 'Changes', 'History', 'What the agent was given']);
    expect(tabs.map((t) => t.dataset.tab)).toEqual([...INSPECTOR_TABS]);
    expect(drawer.el.textContent).not.toContain('Git');
    expect(drawer.el.textContent).not.toContain('Context');
    // The panels follow the tabs' order, so the arrow keys and the eye agree.
    const panels = [...drawer.el.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels.map((p) => p.getAttribute('aria-labelledby'))).toEqual(tabs.map((t) => t.id));
    drawer.destroy();
  });

  it('opens on the tab a request names; the older name "git" still opens Changes', () => {
    expect(inspectorTabOf('changes')).toBe('changes');
    expect(inspectorTabOf('git')).toBe('changes');
    expect(inspectorTabOf('context')).toBe('context');
    expect(inspectorTabOf(undefined)).toBe('overview');
    expect(inspectorTabOf('nonsense')).toBe('overview');
    const ctx = makeContext({ snapshot: boardWith('RUNNING') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID, tab: 'git' });
    expect(drawer.el.querySelector('[role="tab"][data-tab="changes"]')?.getAttribute('aria-selected')).toBe('true');
    drawer.destroy();
  });
});

describe('the task inspector: Overview', () => {
  it('renders hostile task text as text, scopes and conflicts with visible marks', () => {
    const ctx = makeContext({
      snapshot: boardWith('WAITING', { waiting_reason: 'blocked', waiting_note: `Need ${IMG}` }),
    });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    const el = drawer.el;
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.dr-insp-summary')?.textContent).toBe(`Fix ${IMG} pricing now`);
    expect(drawer.title).toBe(`Fix ${IMG} pricing now`);
    expect(el.textContent).toContain(LONG);
    expect(el.textContent).toContain(`tests pass ${IMG}`);
    expect(el.textContent).toContain(`Need ${IMG}`);
    expect(el.querySelector('.dr-pill-write')?.textContent).toBe('src/⟨U+202E⟩**');
    expect(el.textContent).toContain('docs/⟨U+200B⟩**');
    expect(el.textContent).toContain('src/⟨U+202E⟩a.ts');
    expect(el.textContent).toContain('1 passed of 2 run');
    expect(el.textContent).toContain('4.2 s');
    expect(el.textContent).toContain('advisory');
    expect(el.textContent).toContain('Conflicted');
    drawer.destroy();
  });

  it('jumps to dependencies and dependents', () => {
    const ctx = makeContext({ snapshot: boardWith('READY') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    buttonNamed(drawer.el, 'Prepare the API')?.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: DEP });
    buttonNamed(drawer.el, 'Document it')?.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: NEXT });
    drawer.destroy();
  });

  it('opens the verify and recover dialogs', () => {
    const ctx = makeContext({ snapshot: boardWith('READY_FOR_VERIFICATION') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    buttonNamed(drawer.el, 'Verify')?.click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'verify', id: TID });
    ctx.board(boardWith('HARNESS_LOST'));
    buttonNamed(drawer.el, 'Recover')?.click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'recover', id: TID });
    drawer.destroy();
  });

  it('offers Recover for a pending recovery question', () => {
    const board = boardWith('RUNNING');
    board.escalations = [makeEscalation({ task_id: TID, kind: 'recovery_needed' })];
    const ctx = makeContext({ snapshot: board });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    expect(buttonNamed(drawer.el, 'Recover')).toBeDefined();
    drawer.destroy();
  });

  it('continues a waiting task and says what happened', async () => {
    const ctx = makeContext({
      snapshot: boardWith('WAITING', { waiting_reason: 'blocked' }),
      answers: { [`POST /tasks/${TID}/continue`]: { continued: false, reason: `in an editor ${IMG}`, task: {} } },
    });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    buttonNamed(drawer.el, 'Continue')?.click();
    await settle();
    expect(ctx.transport.to('POST', `/tasks/${TID}/continue`)).toHaveLength(1);
    expect(ctx.toasts.at(-1)?.text).toBe(`Not continued: in an editor ${IMG}`);
    expect(ctx.refreshes).toBe(1);
    drawer.destroy();
  });

  it('sends a failed task back for rework', async () => {
    const ctx = makeContext({ snapshot: boardWith('FAILED') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    buttonNamed(drawer.el, 'Rework')?.click();
    await settle();
    expect(ctx.transport.to('POST', `/tasks/${TID}/rework`)).toHaveLength(1);
    drawer.destroy();
  });

  it('cancels only after the user confirms', async () => {
    const ctx = makeContext({ snapshot: boardWith('READY') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    ctx.confirmAnswer = false;
    buttonNamed(drawer.el, 'Cancel task')?.click();
    await settle();
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]?.danger).toBe(true);
    expect(ctx.transport.to('POST', `/tasks/${TID}/cancel`)).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonNamed(drawer.el, 'Cancel task')?.click();
    await settle();
    expect(ctx.transport.to('POST', `/tasks/${TID}/cancel`)).toHaveLength(1);
    drawer.destroy();
  });

  it('follows the board and stops following when destroyed', () => {
    const ctx = makeContext({ snapshot: boardWith('READY') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    const next = boardWith('RUNNING', { summary: 'Renamed' });
    ctx.board(next);
    expect(drawer.el.querySelector('.dr-insp-summary')?.textContent).toBe('Renamed');
    drawer.destroy();
    ctx.board(boardWith('READY', { summary: 'After destroy' }));
    expect(drawer.el.querySelector('.dr-insp-summary')?.textContent).toBe('Renamed');
    expect(drawer.el.isConnected).toBe(false);
  });

  it('keeps the keyboard focus when a snapshot brings the same task again', () => {
    const ctx = makeContext({ snapshot: boardWith('READY') });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    document.body.append(drawer.el);
    const cancel = buttonNamed(drawer.el, 'Cancel task') as HTMLButtonElement;
    cancel.focus();
    ctx.board(boardWith('READY'));
    expect(cancel.isConnected).toBe(true);
    expect(document.activeElement).toBe(cancel);
    ctx.board(boardWith('RUNNING'));
    expect(cancel.isConnected).toBe(false);
    drawer.destroy();
  });

  it('reads a task that is not on the board', async () => {
    const ctx = makeContext({
      answers: {
        [`GET /tasks/${TID}`]: {
          task: makeTask({ summary: `Old ${IMG}`, status: 'COMPLETED' }),
          runs: [makeRun()],
          verification: null,
          open_dependencies: [],
        },
      },
    });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    expect(drawer.title).toBe('Task task_00000000');
    await settle();
    expect(drawer.el.querySelector('.dr-insp-summary')?.textContent).toBe(`Old ${IMG}`);
    expect(drawer.el.querySelector('img')).toBeNull();
    drawer.destroy();
  });
});

describe('the task inspector: History', () => {
  function pages(call: RecordedCall) {
    const q = new URLSearchParams(call.path.split('?')[1]);
    const before = q.get('before');
    const top = before ? Number(before) - 1 : 1000;
    const count = before ? 20 : 100;
    return {
      events: Array.from({ length: count }, (_, i) =>
        makeEvent(top - i, 'task.waiting', { reason: `${IMG} ${BIDI}line ${top - i}` }),
      ),
    };
  }

  it('pages newest first and loads older events before the oldest shown', async () => {
    const ctx = makeContext({ snapshot: boardWith('READY'), answers: { [`GET /tasks/${TID}/events`]: pages } });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID, tab: 'history' });
    await settle();
    const calls = ctx.transport.to('GET', `/tasks/${TID}/events`);
    expect(calls).toHaveLength(1);
    const first = new URLSearchParams(calls[0]?.path.split('?')[1]);
    expect(first.get('order')).toBe('desc');
    expect(first.get('limit')).toBe('100');
    expect(first.has('before')).toBe(false);
    const lines = () => [...drawer.el.querySelectorAll('.dr-event-text')].map((e) => e.textContent ?? '');
    expect(lines()).toHaveLength(100);
    expect(lines()[0]).toContain('line 1000');
    expect(lines()[0]).toContain(IMG);
    expect(lines()[0]).not.toContain(BIDI);
    expect(drawer.el.querySelector('img')).toBeNull();
    buttonNamed(drawer.el, 'Load older')?.click();
    await settle();
    const second = new URLSearchParams(ctx.transport.to('GET', `/tasks/${TID}/events`)[1]?.path.split('?')[1]);
    expect(second.get('before')).toBe('901');
    expect(second.get('limit')).toBe('100');
    expect(lines()).toHaveLength(120);
    expect(lines().at(-1)).toContain('line 881');
    expect(buttonNamed(drawer.el, 'Load older')).toBeUndefined();
    expect(drawer.el.textContent).toContain('The beginning of this task.');
    drawer.destroy();
  });

  it('shows a read error with its message', async () => {
    const ctx = makeContext({
      snapshot: boardWith('READY'),
      answers: {
        [`GET /tasks/${TID}/events`]: () => {
          throw new Error('no such task');
        },
      },
    });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID, tab: 'history' });
    await settle();
    expect(drawer.el.querySelector('.dr-error')?.textContent).toContain('no such task');
    drawer.destroy();
  });
});

const PACKET: ContextPacket = {
  context_id: 'ctx_1',
  project_id: PID,
  recipient: { kind: 'agent', id: 'agent_1' },
  task_id: TID,
  purpose: 'task',
  created_at: T0,
  state_version: 1,
  budget: { tokens: 5000, latency_ms: 0, chars: 20_000 },
  sections: [
    {
      kind: 'task.files',
      content: '',
      authority: 'graph',
      sources: [
        {
          source_id: `src/${IMG}${BIDI}.ts`,
          source_type: 'file',
          authority: 'git',
          recency: T0,
          relevance: 1,
          relationship_distance: 0,
          verification_status: 'verified',
          selection_reason: 'in the write scope',
          estimated_tokens: 120,
        },
      ],
    },
  ],
  staleness: { is_stale: false },
  source_version: 'abcdef1234567890',
};

const EXPLANATION: ContextExplanation = {
  context_id: 'ctx_1',
  cache_key: 'k',
  source_version: 'abcdef1234567890',
  policy_version: null,
  source_basis: 'content',
  asked: { overflow: null, request: null },
  budget: { chars: 20_000, used_chars: 5728, max_sources: 40, sources: 12, asked_chars: null, asked_sources: null },
  included: [
    {
      section: 'task.files',
      source_id: `src/${IMG}${BIDI}.ts`,
      priority: 1,
      relevance: 1,
      protected: false,
      reason: `matches ${IMG}`,
      rule: 'task files',
      tokens: 120,
    },
    {
      section: 'task.contract',
      source_id: TID,
      priority: 0,
      relevance: 1,
      protected: true,
      reason: 'the task',
      rule: 'protected: task contract',
      tokens: 40,
    },
  ],
  cut_by_budget: [{ section: 'history', source_id: 'evt_1', priority: 5, reason: 'over budget', tokens: 900 }],
  withheld_by_permission: 2,
  unsupported_edges: [],
  memory_conflicts: [],
  escalate: false,
  notes: [`note ${IMG}`],
  timings_ms: {},
};

describe('the task inspector: What the agent was given', () => {
  it('explains the delivered packet and links each file to the code graph', async () => {
    const ctx = makeContext({
      snapshot: boardWith('RUNNING'),
      answers: {
        [`GET /tasks/${TID}/delivered-context`]: { context_id: 'ctx_1', agent_id: 'agent_1', agent_key: 'claude-1' },
        'GET /context/ctx_1/explain': { packet: PACKET, explanation: EXPLANATION },
      },
    });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    drawer.el.querySelector<HTMLButtonElement>('[role="tab"][data-tab="context"]')?.click();
    await settle();
    const el = drawer.el;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('Delivered to claude-1');
    expect(el.textContent).toContain('5,728 of 20,000 characters');
    expect(el.textContent).toContain('Current (source abcdef123456)');
    expect(el.querySelector('.dr-ctx-path')?.textContent).toBe(`src/${IMG}⟨U+202E⟩.ts`);
    expect(el.textContent).toContain(`matches ${IMG}`);
    expect(el.textContent).toContain('task files');
    expect(el.textContent).toContain('1 source cut by the budget');
    expect(el.textContent).toContain('2 sources withheld');
    expect(el.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('29');
    buttonNamed(el, 'Code graph')?.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'graph', path: `src/${IMG}${BIDI}.ts` });
    drawer.destroy();
  });

  it('compiles a fresh preview labelled as compiled for a human', async () => {
    const ctx = makeContext({
      snapshot: boardWith('RUNNING'),
      answers: {
        [`GET /tasks/${TID}/delivered-context`]: { context_id: null, agent_id: null, agent_key: null },
        'POST /context/compile': {
          ...PACKET,
          context_id: 'ctx_2',
          staleness: { is_stale: true, reason: `code ${IMG}` },
        },
        'GET /context/ctx_2/explain': { packet: PACKET, explanation: EXPLANATION },
      },
    });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID, tab: 'context' });
    await settle();
    expect(drawer.el.textContent).toContain('No context packet was delivered');
    buttonNamed(drawer.el, 'Compile a fresh preview')?.click();
    await settle();
    expect(ctx.transport.to('POST', '/context/compile')[0]?.body).toEqual({ task_id: TID, purpose: 'explain' });
    const preview = drawer.el.querySelector('.dr-ctx-preview');
    expect(preview?.textContent).toContain('Preview');
    expect(preview?.textContent).toContain('not what the agent received');
    expect(preview?.textContent).toContain(`Stale: code ${IMG}`);
    expect(drawer.el.querySelector('img')).toBeNull();
    drawer.destroy();
  });
});

describe('the task inspector: Changes', () => {
  const diff: TaskDiff = {
    task_id: TID,
    source: 'worktree',
    root: 'C:/wt/abc',
    base: 'a'.repeat(40),
    truncated: false,
    notes: [`note ${IMG}`],
    files: [
      {
        path: `src/${IMG}${ZW}.ts`,
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
        added: 4,
        removed: 1,
      } satisfies TaskDiffFile,
      {
        path: '.env',
        change: 'modified',
        orig_path: null,
        committed: true,
        uncommitted: false,
        binary: false,
        too_large: false,
        link: false,
        protected: true,
        before: null,
        after: null,
        added: null,
        removed: null,
      } satisfies TaskDiffFile,
    ],
  };

  it('shows the branch, worktree, base and head, and the changed files', async () => {
    const ctx = makeContext({ snapshot: boardWith('RUNNING'), answers: { [`GET /tasks/${TID}/diff`]: diff } });
    const open = vi.fn();
    (ctx.platform as { openInEditor: (p: string, l?: number) => void }).openInEditor = open;
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID, tab: 'changes' });
    await settle();
    const el = drawer.el;
    expect(ctx.transport.to('GET', `/tasks/${TID}/diff`)[0]?.path).toContain('stat=1');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('friday/task-⟨U+202E⟩x');
    expect(el.textContent).toContain('C:/wt/abc');
    expect(el.textContent).toContain('aaaaaaa');
    expect(el.textContent).toContain('fffffff (verified)');
    expect(el.textContent).toContain('Dirty: uncommitted changes');
    expect(el.textContent).toContain('2 changed files');
    expect(el.textContent).toContain(`src/${IMG}⟨U+200B⟩.ts`);
    expect(el.textContent).toContain('+4');
    expect(el.textContent).toContain('protected');
    el.querySelector<HTMLButtonElement>('.dr-git-file .dr-item')?.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: TID, path: `src/${IMG}${ZW}.ts` });
    el.querySelector<HTMLButtonElement>('.dr-git-file .btn-icon')?.click();
    expect(open).toHaveBeenCalledWith(`C:/wt/abc/src/${IMG}${ZW}.ts`);
    expect(el.querySelectorAll('.dr-git-file .btn-icon')).toHaveLength(1);
    el.querySelector<HTMLButtonElement>('[aria-label="Open the worktree in VS Code"]')?.click();
    expect(open).toHaveBeenLastCalledWith('C:/wt/abc');
    drawer.destroy();
  });

  it('moves between tabs with the arrow keys', async () => {
    const ctx = makeContext({
      snapshot: boardWith('RUNNING'),
      answers: { [`GET /tasks/${TID}/delivered-context`]: { context_id: null, agent_id: null, agent_key: null } },
    });
    const drawer = createTaskInspector(ctx, { kind: 'inspector', id: TID });
    document.body.append(drawer.el);
    const overview = drawer.el.querySelector<HTMLButtonElement>('[role="tab"][data-tab="overview"]');
    expect(overview?.getAttribute('aria-selected')).toBe('true');
    overview?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // Changes comes right after Overview; what the agent was given is last.
    const changes = drawer.el.querySelector<HTMLButtonElement>('[role="tab"][data-tab="changes"]');
    expect(changes?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(changes);
    await settle();
    expect(ctx.transport.to('GET', `/tasks/${TID}/diff`)).toHaveLength(1);
    changes?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const context = drawer.el.querySelector<HTMLButtonElement>('[role="tab"][data-tab="context"]');
    expect(context?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(context);
    await settle();
    expect(ctx.transport.to('GET', `/tasks/${TID}/delivered-context`)).toHaveLength(1);
    const panels = [...drawer.el.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    expect(panels.filter((p) => !p.hidden)).toHaveLength(1);
    expect(panels.find((p) => !p.hidden)?.getAttribute('aria-labelledby')).toBe(context?.id);
    drawer.destroy();
  });
});
