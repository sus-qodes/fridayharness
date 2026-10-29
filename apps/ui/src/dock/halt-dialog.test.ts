import type { ControlResult } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { Component } from '../shell/context.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeHarness, makeScenario, makeSnapshot, makeTask } from '../test/fixtures.js';
import { registerDock } from './dock.js';
import {
  HALT_COUNTDOWN_S,
  HALT_DOES,
  HALT_DOES_NOT,
  haltSummary,
  renderHaltSummary,
  stopLabel,
} from './halt-dialog.js';

const HOSTILE = '<img src=x onerror=alert(1)>';

const RESULT: ControlResult = {
  control: { paused: true, reason: 'runaway', changed_at: null, changed_by: 'local-operator', halted_at: null },
  tasks: [
    {
      task_id: 'task_00000000000000000000api001',
      preserved_ref: 'refs/friday/preserved/task_api/attempt-1',
      host: 'spawned',
      stop: 'sent',
    },
    {
      task_id: 'task_00000000000000000000ui0001',
      preserved_ref: 'refs/friday/preserved/task_ui/attempt-2',
      host: 'attached',
      stop: 'not_possible',
    },
    { task_id: 'task_unknown', preserved_ref: null, host: 'spawned', stop: 'sent' },
  ],
  operations_stopped: 2,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function key(k: string): KeyboardEvent {
  return new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
}

let ctx: TestContext;
let dialog: (Component & { title: string; size?: string }) | null;
let close: Mock<() => void>;

function open(answers: Record<string, unknown> = { 'POST /control/halt': RESULT }) {
  ctx = makeContext({ snapshot: makeScenario(), answers });
  registerDock(ctx);
  close = vi.fn();
  const factory = ctx.registry.modals.get('halt');
  if (!factory) throw new Error('halt modal not registered');
  dialog = factory(ctx, { kind: 'halt' }, close);
  document.body.appendChild(dialog.el);
  const reason = dialog.el.querySelector('.dk-halt-reason') as HTMLInputElement;
  const confirm = () => dialog?.el.querySelector('.dk-halt-confirm') as HTMLButtonElement | null;
  return { reason, confirm };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  dialog?.destroy();
  dialog = null;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('halt dialog', () => {
  it('is registered as the halt modal and explains what halt does and does not do', () => {
    open();
    expect(dialog?.title).toBe('Halt Friday');
    const text = dialog?.el.textContent ?? '';
    for (const line of [...HALT_DOES, ...HALT_DOES_NOT]) expect(text).toContain(line);
    expect(text).toMatch(/never|not/);
    expect(text).toContain('Cancel any task, remove any worktree');
    expect(text).toContain('keep running, but cannot change anything while Friday is paused');
  });

  it('arms Confirm only after the 3-second countdown', async () => {
    const { reason, confirm } = open();
    expect(HALT_COUNTDOWN_S).toBe(3);
    expect(confirm()?.disabled).toBe(true);
    expect(confirm()?.textContent).toContain('ready in 3 s');
    vi.advanceTimersByTime(1000);
    expect(confirm()?.textContent).toContain('ready in 2 s');
    vi.advanceTimersByTime(1000);
    expect(confirm()?.textContent).toContain('ready in 1 s');
    // Enter before 3 s does nothing.
    reason.dispatchEvent(key('Enter'));
    ctx.keys.handle(key('Enter'));
    confirm()?.click();
    await flush();
    expect(ctx.transport.to('POST', '/control/halt')).toHaveLength(0);
    vi.advanceTimersByTime(999);
    reason.dispatchEvent(key('Enter'));
    await flush();
    expect(ctx.transport.to('POST', '/control/halt')).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(confirm()?.disabled).toBe(false);
    expect(confirm()?.textContent).toContain('Halt now');
  });

  it('Enter confirms once armed and sends the reason', async () => {
    const { reason } = open();
    vi.advanceTimersByTime(3000);
    reason.value = '  runaway spend  ';
    const ev = key('Enter');
    reason.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await flush();
    const calls = ctx.transport.to('POST', '/control/halt');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ reason: 'runaway spend' });
    expect(ctx.refreshes).toBe(1);
  });

  it('confirms from the page keyboard too, once, without a reason', async () => {
    open();
    vi.advanceTimersByTime(3000);
    ctx.keys.handle(key('Enter'));
    ctx.keys.handle(key('Enter'));
    await flush();
    const calls = ctx.transport.to('POST', '/control/halt');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({});
  });

  it('Enter on the focused Cancel button cancels instead of confirming', async () => {
    open();
    vi.advanceTimersByTime(3000);
    const cancel = dialog?.el.querySelector('.dk-halt-cancel') as HTMLButtonElement;
    cancel.focus();
    const ev = key('Enter');
    Object.defineProperty(ev, 'target', { value: cancel });
    ctx.keys.handle(ev);
    await flush();
    expect(close).toHaveBeenCalledTimes(1);
    expect(ctx.transport.to('POST', '/control/halt')).toHaveLength(0);
  });

  it('Escape cancels, before and after arming', async () => {
    const { reason } = open();
    const esc = key('Escape');
    reason.dispatchEvent(esc);
    expect(esc.defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    ctx.keys.handle(key('Escape'));
    expect(close).toHaveBeenCalledTimes(2);
    expect(ctx.transport.calls).toHaveLength(0);
  });

  it('shows what the daemon reported after the halt', async () => {
    const { reason } = open();
    vi.advanceTimersByTime(3000);
    reason.dispatchEvent(key('Enter'));
    await flush();
    const text = dialog?.el.textContent ?? '';
    expect(text).toContain('Friday is halted and paused. 3 tasks released.');
    expect(text).toContain('Agents Friday started: 2 tasks');
    expect(text).toContain('stop sent');
    expect(text).toContain('Sessions attached in an editor: 1 task');
    expect(text).toContain('cannot be stopped (held by the pause)');
    expect(text).toContain('2 operations stopped');
    expect(text).toContain('refs/friday/preserved/task_api/attempt-1');
    expect(text).toContain('Add the subscription API');
    expect(text).toContain('Sessions attached in VS Code need a prompt there to continue.');
    // "Stop sent" is not "stopped": no agent is reported stopped.
    expect(text).not.toMatch(/(agents?|tasks?|sessions?) (were |was )?stopped/i);
    // After the halt, Enter and Escape close the dialog.
    const done = dialog?.el.querySelector('.dk-halt-close') as HTMLButtonElement;
    expect(done).not.toBeNull();
    ctx.keys.handle(key('Enter'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the dialog armed after a failed halt so it can be tried again', async () => {
    let fail = true;
    const { reason, confirm } = open({
      'POST /control/halt': () => {
        if (fail) throw new Error('COS-9001 Friday is stopping');
        return RESULT;
      },
    });
    vi.advanceTimersByTime(3000);
    reason.dispatchEvent(key('Enter'));
    await flush();
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Halt Friday' });
    expect(confirm()?.disabled).toBe(false);
    fail = false;
    reason.dispatchEvent(key('Enter'));
    await flush();
    expect(ctx.transport.to('POST', '/control/halt')).toHaveLength(2);
    expect(dialog?.el.querySelector('.dk-halt-summary')).not.toBeNull();
  });

  it('clears its timers and keyboard scope on destroy', () => {
    open();
    dialog?.destroy();
    dialog = null;
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(ctx.keys.handle(key('Enter'))).toBe(false);
    expect(ctx.transport.calls).toHaveLength(0);
  });
});

describe('haltSummary', () => {
  it('labels each stop without claiming more than was done', () => {
    expect(stopLabel({ host: 'spawned', stop: 'sent' })).toBe('stop sent');
    expect(stopLabel({ host: 'attached', stop: 'not_possible' })).toBe('cannot be stopped (held by the pause)');
    expect(stopLabel({ host: 'none', stop: 'none' })).toBe('released (no agent was running it)');
    expect(stopLabel({ host: 'spawned', stop: 'none' })).toBe('released');
  });

  it('groups tasks by host kind, spawned first', () => {
    const s = haltSummary(RESULT, makeScenario());
    expect(s.groups).toEqual([
      { host: 'spawned', label: 'Agents Friday started', stop: 'stop sent', count: 2 },
      {
        host: 'attached',
        label: 'Sessions attached in an editor',
        stop: 'cannot be stopped (held by the pause)',
        count: 1,
      },
    ]);
    expect(s.tasks[2]?.title).toBe('task_unknown');
    expect(s.operations).toBe('2 operations stopped');
  });

  it('says when no task was running', () => {
    const s = haltSummary({ ...RESULT, tasks: [], operations_stopped: 0 }, makeSnapshot());
    expect(s.heading).toBe('Friday is halted and paused. No task was running.');
    expect(s.groups).toEqual([]);
    expect(s.notes).toEqual([]);
    const attached = haltSummary(
      { ...RESULT, tasks: [], operations_stopped: 0 },
      makeSnapshot({ harnesses: [makeHarness({ attach_mode: 'attach' })] }),
    );
    expect(attached.notes).toEqual(['Sessions attached in VS Code need a prompt there to continue.']);
  });

  it('renders hostile task summaries and refs as text', () => {
    const long = 'z'.repeat(5000);
    const board = makeSnapshot({
      tasks: [makeTask({ task_id: 't1', summary: `${HOSTILE}‮​${long}` })],
    });
    const el = renderHaltSummary(
      haltSummary(
        {
          ...RESULT,
          tasks: [{ task_id: 't1', preserved_ref: `refs/${HOSTILE}‮​`, host: 'spawned', stop: 'sent' }],
        },
        board,
      ),
    );
    expect(el.querySelector('img')).toBeNull();
    const text = el.textContent ?? '';
    expect(text).toContain(HOSTILE);
    // A summary is cleaned (the bidi override removed) and shortened.
    expect(text).not.toContain('‮');
    expect(text).not.toContain(long);
    // A ref is shown with visible marks.
    expect(text).toContain('⟨U+202E⟩⟨U+200B⟩');
  });
});
