import type { UiSnapshot } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeApproval, makeSnapshot } from '../test/fixtures.js';
import { GOAL_PLACEHOLDER, quickPrompt } from './quick-prompt.js';

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

describe('the goal line (review §4, owner decision 4)', () => {
  it('is one field that describes a goal', () => {
    const t = track(setup());
    expect(t.input.placeholder).toBe(GOAL_PLACEHOLDER);
    expect(t.input.getAttribute('aria-label')).toBe('Describe a goal');
    expect(t.input.getAttribute('maxlength')).toBe('4000');
  });

  it('offers "Create a goal: …? Press Enter", then creates it on the second Enter', async () => {
    const t = track(setup(makeSnapshot({ brain: { planner_available: true } as UiSnapshot['brain'] })));
    await t.type('Add Stripe subscriptions');
    await t.enter();
    expect(posts(t.ctx, '/goals')).toHaveLength(0);
    expect(t.feedback.textContent).toBe('Create a goal: Add Stripe subscriptions? Press Enter');
    expect(t.feedback.textContent).not.toContain('Not a command');
    expect(t.onDone).not.toHaveBeenCalled();
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
    expect(t.input.value).toBe('');
    expect(t.feedback.textContent).toBe('Goal created.');
    expect(t.onDone).toHaveBeenCalledTimes(1);
  });

  it('opens the new goal’s plan editor when no planner will write it (review R1)', async () => {
    const t = track(setup(makeSnapshot({ brain: null }), { 'POST /goals': { goal_id: 'goal_new' } }));
    await t.type('Add subscriptions');
    await t.enter();
    await t.enter();
    expect(posts(t.ctx, '/goals')[0]?.body).toMatchObject({ request: 'Add subscriptions', plan: false });
    expect(t.ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: 'goal_new', mode: 'first' });
    expect(t.feedback.textContent).toBe('Goal created: write its plan in the editor.');
    expect(t.onDone).toHaveBeenCalledTimes(1);
  });

  it('opens no editor and keeps the line when the goal was not created', async () => {
    const t = track(
      setup(undefined, {
        'POST /goals': () => {
          throw new Error('COS-1000 invalid');
        },
      }),
    );
    await t.type('Add subscriptions');
    await t.enter();
    await t.enter();
    expect(t.ctx.store.select('ui').modal).toBeNull();
    expect(t.feedback.textContent).toBe('The goal was not created.');
    expect(t.ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Create a goal' });
    expect(t.input.value).toBe('Add subscriptions');
    expect(t.onDone).not.toHaveBeenCalled();
  });

  it('parses no command word: the nine former commands are goals like any other text', async () => {
    const board = makeSnapshot({ approvals: [makeApproval({ approval_id: 'apr_a' })] });
    const t = track(setup(board));
    for (const word of ['pause', 'resume', 'halt', 'status', 'approve', 'deny', 'open', 'start', 'goal']) {
      await t.type(word);
      await t.enter();
      expect(t.feedback.textContent).toBe(`Create a goal: ${word}? Press Enter`);
      await t.type('');
    }
    await t.type('goal Add subscriptions');
    await t.enter();
    expect(t.feedback.textContent).toBe('Create a goal: goal Add subscriptions? Press Enter');
    await t.type('approve');
    await t.enter();
    await t.enter();
    // Only a goal was created; nothing was paused, approved, denied, opened or started.
    const calls = t.ctx.transport.calls.filter((c) => c.method === 'POST');
    expect(calls.map((c) => c.path.replace(/^.*\/projects\/[^/]+/, ''))).toEqual(['/goals']);
    expect(posts(t.ctx, '/goals')[0]?.body).toMatchObject({ request: 'approve' });
    expect(posts(t.ctx, '/approvals/apr_a/approve')).toHaveLength(0);
    expect(posts(t.ctx, '/control/pause')).toHaveLength(0);
    // No status toast, no halt dialog, no inspector: nothing but the goal.
    expect(t.ctx.store.select('ui').modal).toBeNull();
    expect(t.ctx.store.select('ui').drawer).toBeNull();
    expect(t.ctx.toasts.filter((x) => x.kind === 'info')).toEqual([]);
  });

  it('asks for text on an empty Enter, and refuses a goal that is too short or too long', async () => {
    const t = track(setup());
    await t.enter();
    expect(t.feedback.textContent).toBe('Type what you want done, then press Enter.');
    await t.type('ab');
    await t.enter();
    expect(t.feedback.textContent).toMatch(/at least 3 characters/);
    await t.type('y'.repeat(5000));
    await t.enter();
    expect(t.feedback.textContent).toMatch(/at most 4000 characters/);
    expect(posts(t.ctx, '/goals')).toHaveLength(0);
  });

  it('owns Enter: the key never reaches the page keyboard', async () => {
    const t = track(setup());
    const outside = vi.fn();
    document.body.addEventListener('keydown', outside);
    await t.type('Fix the auth tests');
    const ev = await t.enter();
    expect(ev.defaultPrevented).toBe(true);
    expect(outside).not.toHaveBeenCalled();
    document.body.removeEventListener('keydown', outside);
  });

  it('a held-down Enter repeats, and never confirms what the first Enter offered (review M9i)', async () => {
    const t = track(setup());
    await t.type('Fix the auth tests');
    await t.enter();
    t.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(posts(t.ctx, '/goals')).toHaveLength(0);
    await t.enter();
    expect(posts(t.ctx, '/goals')).toHaveLength(1);
  });

  it('forgets the offer when the line is edited, and Escape clears both', async () => {
    const t = track(setup());
    await t.type('Fix the auth tests');
    await t.enter();
    await t.type('Fix the auth tests now');
    expect(t.feedback.textContent).toBe('');
    await t.enter();
    // The edit dropped the offer: this Enter offered again instead of creating.
    expect(posts(t.ctx, '/goals')).toHaveLength(0);
    expect(t.feedback.textContent).toBe('Create a goal: Fix the auth tests now? Press Enter');
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    t.input.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(t.input.value).toBe('');
    expect(t.feedback.textContent).toBe('');
    await t.enter();
    expect(posts(t.ctx, '/goals')).toHaveLength(0);
  });

  it('shows a hostile goal as text', async () => {
    const t = track(setup());
    const long = 'y'.repeat(3000);
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
    t.input.value = 'Fix the auth tests';
    await t.enter();
    await t.enter();
    expect(t.ctx.transport.calls).toHaveLength(0);
  });
});
