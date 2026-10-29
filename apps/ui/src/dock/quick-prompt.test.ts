import type { UiSnapshot } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeApproval, makeScenario, makeSnapshot } from '../test/fixtures.js';
import { quickPrompt } from './quick-prompt.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function setup(snapshot?: UiSnapshot, answers: Record<string, unknown> = {}) {
  const ctx = makeContext({ ...(snapshot ? { snapshot } : {}), answers });
  const onDone = vi.fn();
  const c = quickPrompt(ctx, { onDone });
  document.body.appendChild(c.el);
  const input = c.el.querySelector('input') as HTMLInputElement;
  const feedback = c.el.querySelector('.dk-qp-feedback') as HTMLElement;
  async function type(text: string): Promise<void> {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  }
  async function enter(): Promise<KeyboardEvent> {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    await flush();
    return ev;
  }
  return { ctx, c, input, feedback, onDone, type, enter };
}

let current: { c: { destroy(): void } } | null = null;
afterEach(() => {
  current?.c.destroy();
  current = null;
  document.body.replaceChildren();
});

function track<T extends { c: { destroy(): void } }>(t: T): T {
  current = t;
  return t;
}

function posts(ctx: TestContext, path: string) {
  return ctx.transport.to('POST', path);
}

describe('quick prompt', () => {
  it('pauses and resumes Friday', async () => {
    const t = track(setup());
    await t.type('pause');
    await t.enter();
    expect(posts(t.ctx, '/control/pause')).toHaveLength(1);
    expect(t.input.value).toBe('');
    expect(t.onDone).toHaveBeenCalledTimes(1);
    t.ctx.board(
      makeSnapshot({ control: { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null } }),
    );
    await t.type('resume');
    await t.enter();
    expect(posts(t.ctx, '/control/resume')).toHaveLength(1);
  });

  it('opens the halt dialog without halting', async () => {
    const t = track(setup());
    await t.type('halt');
    await t.enter();
    expect(t.ctx.store.select('ui').modal).toEqual({ kind: 'halt' });
    expect(posts(t.ctx, '/control/halt')).toHaveLength(0);
  });

  it('shows a status toast with counts', async () => {
    const t = track(setup(makeScenario()));
    await t.type('status');
    await t.enter();
    expect(t.ctx.toasts.at(-1)).toMatchObject({ kind: 'info', text: '1 running, 3 waiting for you' });
  });

  it('owns Enter: the key never reaches the page keyboard', async () => {
    const t = track(setup());
    const outside = vi.fn();
    document.body.addEventListener('keydown', outside);
    await t.type('status');
    const ev = await t.enter();
    expect(ev.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outside);
  });

  it('approves only the named approval, on the second Enter, with reach once', async () => {
    const board = makeSnapshot({
      approvals: [
        makeApproval({ approval_id: 'apr_b', created_at: '2026-10-17T09:30:00.000Z' }),
        makeApproval({ approval_id: 'apr_a', created_at: '2026-10-17T09:00:00.000Z', risk: 'medium' }),
      ],
    });
    const t = track(setup(board));
    await t.type('approve');
    await t.enter();
    expect(posts(t.ctx, '/approvals/apr_a/approve')).toHaveLength(0);
    expect(t.feedback.textContent).toContain('Approve once shell.git.commit');
    expect(t.feedback.textContent).toContain('(apr_a)');
    expect(t.feedback.textContent).toContain('Press Enter again');
    expect(t.onDone).not.toHaveBeenCalled();
    await t.enter();
    const calls = posts(t.ctx, '/approvals/apr_a/approve');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ reuse: 'once', via: 'ui' });
    expect(posts(t.ctx, '/approvals/apr_b/approve')).toHaveLength(0);
    expect(t.ctx.reactions).toEqual([{ kind: 'approved', label: 'shell.git.commit' }]);
    expect(t.onDone).toHaveBeenCalledTimes(1);
  });

  it('a held-down Enter repeats, and never confirms what the first Enter proposed (review M9i)', async () => {
    const board = makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_a', risk: 'medium' })] });
    const t = track(setup(board));
    await t.type('approve');
    await t.enter();
    t.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(posts(t.ctx, '/approvals/apr_a/approve')).toHaveLength(0);
    await t.enter();
    expect(posts(t.ctx, '/approvals/apr_a/approve')).toHaveLength(1);
  });

  it('refuses a denial reason longer than the daemon keeps', async () => {
    const board = makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_a', risk: 'medium' })] });
    const t = track(setup(board));
    await t.type(`deny ${'x'.repeat(501)}`);
    await t.enter();
    expect(t.feedback.textContent).toContain('A reason is at most 500 characters.');
  });

  it('refuses the second Enter when the waiting set changed since it was shown', async () => {
    const a = makeApproval({ approval_id: 'apr_a', created_at: '2026-10-17T09:00:00.000Z' });
    const t = track(setup(makeSnapshot({ approvals: [a] })));
    await t.type('approve');
    await t.enter();
    // A second request arrives before the human presses Enter again.
    t.ctx.board(makeSnapshot({ approvals: [a, makeApproval({ approval_id: 'apr_z', risk: 'high' })] }));
    await t.enter();
    expect(t.ctx.transport.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(t.feedback.textContent).toMatch(/changed since this was shown, so nothing was decided/);
    // A third Enter starts over: it names the approval again rather than deciding.
    await t.enter();
    expect(t.ctx.transport.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(t.feedback.textContent).toContain('(apr_a)');
  });

  it('forgets the proposal when the line is edited', async () => {
    const t = track(setup(makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_a' })] })));
    await t.type('approve');
    await t.enter();
    await t.type('approve ');
    await t.type('approve');
    await t.enter();
    // The edit dropped the proposal: this Enter named it again instead of deciding.
    expect(posts(t.ctx, '/approvals/apr_a/approve')).toHaveLength(0);
  });

  it('Escape clears a proposal and the line', async () => {
    const t = track(setup(makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_a' })] })));
    await t.type('approve');
    await t.enter();
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    t.input.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(t.input.value).toBe('');
    await t.type('approve');
    await t.enter();
    expect(posts(t.ctx, '/approvals/apr_a/approve')).toHaveLength(0);
  });

  it('denies the named approval with the reason as the note', async () => {
    const t = track(setup(makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_a' })] })));
    await t.type('deny not in this task');
    await t.enter();
    expect(t.feedback.textContent).toContain('Deny shell.git.commit');
    expect(t.feedback.textContent).toContain('not in this task');
    await t.enter();
    const calls = posts(t.ctx, '/approvals/apr_a/reject');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ via: 'ui', note: 'not in this task' });
    expect(t.ctx.reactions.at(-1)?.kind).toBe('denied');
  });

  it('says so when no low or medium approval waits', async () => {
    const t = track(setup(makeSnapshot({ approvals: [makeApproval({ risk: 'high' })] })));
    await t.type('approve');
    await t.enter();
    expect(t.feedback.textContent).toMatch(/decide it in its approval card/);
    await t.enter();
    expect(t.ctx.transport.calls).toHaveLength(0);
  });

  it('opens a task by a prefix of its id', async () => {
    const t = track(setup(makeScenario()));
    await t.type('open 00000000000000000000ui');
    await t.enter();
    expect(t.ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: 'task_00000000000000000000ui0001' });
    expect(t.ctx.store.select('ui').selectedTaskId).toBe('task_00000000000000000000ui0001');
  });

  it('starts an agent with the developer role by default', async () => {
    const t = track(setup());
    await t.type('start claude-code claude-2');
    await t.enter();
    await t.type('start codex codex-1 as frontend');
    await t.enter();
    const calls = posts(t.ctx, '/agent-processes');
    expect(calls.map((c) => c.body)).toEqual([
      { host: 'claude-code', agent_key: 'claude-2', role: 'developer' },
      { host: 'codex', agent_key: 'codex-1', role: 'frontend' },
    ]);
  });

  it('creates a goal from "goal <text>", planned when the planner is available', async () => {
    const board = makeSnapshot({ brain: { planner_available: true } as UiSnapshot['brain'] });
    const t = track(setup(board));
    await t.type('goal Add Stripe subscriptions');
    await t.enter();
    expect(posts(t.ctx, '/goals')[0]?.body).toEqual({
      request: 'Add Stripe subscriptions',
      constraints: [],
      outcomes: [],
      priority: 'normal',
      plan: true,
    });
    // The Master Brain writes the plan: no editor opens.
    expect(t.ctx.store.select('ui').modal).toBeNull();
  });

  it('opens the new goal’s plan editor when no planner will write it (review R1)', async () => {
    const t = track(setup(makeSnapshot({ brain: null }), { 'POST /goals': { goal_id: 'goal_new' } }));
    await t.type('goal Add subscriptions');
    await t.enter();
    expect(posts(t.ctx, '/goals')[0]?.body).toMatchObject({ request: 'Add subscriptions', plan: false });
    expect(t.ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: 'goal_new', mode: 'first' });
    expect(t.feedback.textContent).toBe('Goal created: write its plan in the editor.');
    expect(t.onDone).toHaveBeenCalledTimes(1);
    // A goal offered for free text and confirmed takes the same way.
    t.ctx.store.patch('ui', { modal: null });
    await t.type('Fix the auth tests');
    await t.enter();
    await t.enter();
    expect(t.ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: 'goal_new', mode: 'first' });
  });

  it('opens no editor when the goal was not created', async () => {
    const t = track(
      setup(undefined, {
        'POST /goals': () => {
          throw new Error('COS-1000 invalid');
        },
      }),
    );
    await t.type('goal Add subscriptions');
    await t.enter();
    expect(t.ctx.store.select('ui').modal).toBeNull();
    expect(t.feedback.textContent).toBe('The goal was not created.');
  });

  it('offers a goal for anything else and creates it only on Enter', async () => {
    const t = track(setup());
    await t.type('Fix the auth tests');
    await t.enter();
    expect(posts(t.ctx, '/goals')).toHaveLength(0);
    expect(t.feedback.textContent).toContain('Not a command. Create a goal: Fix the auth tests?');
    await t.enter();
    expect(posts(t.ctx, '/goals')[0]?.body).toMatchObject({ request: 'Fix the auth tests', plan: false });
    expect(t.onDone).toHaveBeenCalledTimes(1);
  });

  it('shows why a command is refused', async () => {
    const t = track(setup());
    await t.type('pause dev-backend');
    await t.enter();
    expect(t.feedback.textContent).toMatch(/Pausing is project-wide/);
    expect(t.ctx.transport.calls).toHaveLength(0);
  });

  it('shows a failed call as an error and keeps the line', async () => {
    const t = track(
      setup(undefined, {
        'POST /control/pause': () => {
          throw new Error('COS-9001 Friday is stopping');
        },
      }),
    );
    await t.type('pause');
    await t.enter();
    expect(t.ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Pause Friday' });
    expect(t.input.value).toBe('pause');
    expect(t.onDone).not.toHaveBeenCalled();
  });

  it('renders hostile approval text as text with visible marks', async () => {
    const target = `${HOSTILE}‮txt​`;
    const board = makeSnapshot({
      approvals: [makeApproval({ approval_id: 'apr_h', capability: `fs.write${HOSTILE}`, target })],
    });
    const t = track(setup(board));
    await t.type('approve');
    await t.enter();
    expect(t.c.el.querySelector('img')).toBeNull();
    expect(t.feedback.textContent).toContain(HOSTILE);
    expect(t.feedback.textContent).toContain('⟨U+202E⟩');
    expect(t.feedback.textContent).toContain('⟨U+200B⟩');
    expect(t.feedback.textContent).not.toContain('‮');
    expect(t.feedback.querySelector('.hidden-warning')).not.toBeNull();
  });

  it('renders a hostile goal proposal and a 5000-character line as text', async () => {
    const t = track(setup());
    const long = 'y'.repeat(5000);
    await t.type(`${HOSTILE} ${long}`);
    await t.enter();
    expect(t.c.el.querySelector('img')).toBeNull();
    expect(t.feedback.textContent).toContain(HOSTILE);
    expect(t.feedback.textContent).toContain(long);
  });

  it('removes its listeners and element on destroy', async () => {
    const t = setup();
    t.c.destroy();
    expect(t.c.el.isConnected).toBe(false);
    t.input.value = 'pause';
    await t.enter();
    expect(t.ctx.transport.calls).toHaveLength(0);
  });
});
