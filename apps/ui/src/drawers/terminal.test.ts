import type { AgentProcess } from '@friday/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentActivity, LogLine } from '../store/state.js';
import { makeContext } from '../test/context.js';
import { makeAgent, makeHarness, makeSnapshot, makeTask, T0 } from '../test/fixtures.js';
import { createTerminal, PROCESS_POLL_MS } from './terminal.js';

const IMG = '<img src=x onerror=alert(1)>';
const BIDI = '‮';
const ZW = '​';
const LONG = 'q'.repeat(5000);
const TID = 'task_0000000000000000000000aa01';

const LOG: LogLine[] = [
  { at: Date.parse(T0), sequence: 10, stream: 'tool', text: `→ Edit src/${IMG}.ts` },
  { at: Date.parse(T0), sequence: 11, stream: 'error', text: `✕ Bash rm — denied ${BIDI}evil` },
  { at: Date.parse(T0), sequence: 12, stream: 'progress', text: `progress: ${ZW}${LONG}` },
  { at: Date.parse(T0), sequence: 13, stream: 'info', text: 'turn ended' },
];

function activity(log: LogLine[]): AgentActivity {
  return {
    current: { at: 1, tool: 'Edit', kind: 'write', target: `src/${IMG}.ts`, decision: 'allow', taskId: TID },
    log,
    usage: null,
    model: null,
  };
}

function proc(o: Partial<AgentProcess> = {}): AgentProcess {
  return {
    agent_key: 'claude-1',
    host: 'claude-code',
    role: 'developer',
    pid: 4242,
    status: 'running',
    started_at: T0,
    ended_at: null,
    exit_code: null,
    options: {},
    log_tail: ['\u001b[32mstarted\u001b[0m', `out ${IMG} ${BIDI}x`],
    shadow: false,
    ...o,
  };
}

function setup(opts: { answers?: Record<string, unknown>; height?: number } = {}) {
  const ctx = makeContext({
    snapshot: makeSnapshot({
      agents: [makeAgent({ status: 'BUSY', current_task_id: TID })],
      harnesses: [makeHarness()],
      tasks: [makeTask({ status: 'RUNNING', summary: `Pricing ${IMG}` })],
    }),
    answers: { 'GET /agent-processes': { processes: [], profiles: [] }, ...opts.answers },
  });
  ctx.store.setState({ activity: { ...ctx.store.select('activity'), agents: { 'claude-1': activity(LOG) } } });
  if (opts.height !== undefined) ctx.store.patch('prefs', { terminalHeight: opts.height });
  const drawer = createTerminal(ctx, { kind: 'terminal', id: 'claude-1' });
  document.body.append(drawer.el);
  return { ctx, drawer };
}

function lines(root: HTMLElement): string[] {
  return [...root.querySelectorAll('.dr-term-body .dr-term-line')].map((l) => l.textContent ?? '');
}

function tab(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${id}"]`) as HTMLButtonElement;
}

function buttonNamed(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('the terminal drawer', () => {
  it("shows Friday's record of the agent, hostile lines as text", () => {
    vi.useFakeTimers();
    const { drawer } = setup();
    expect(drawer.title).toBe('Agent claude-1');
    expect(drawer.el.querySelector('img')).toBeNull();
    const all = lines(drawer.el);
    expect(all).toHaveLength(4);
    expect(all[0]).toContain(`→ Edit src/${IMG}.ts`);
    expect(all[1]).toContain('denied evil');
    expect(all[1]).not.toContain(BIDI);
    expect(all[2]).toContain(LONG);
    expect(drawer.el.querySelector('.dr-term-head')?.textContent).toContain(`Pricing ${IMG}`);
    expect(drawer.el.querySelector('.dr-term-head')?.textContent).toContain('Claude Code · spawn');
    expect(drawer.el.querySelector('[role="log"]')).not.toBeNull();
    drawer.destroy();
  });

  it('splits the stream into Tools and Errors', () => {
    vi.useFakeTimers();
    const { drawer } = setup();
    tab(drawer.el, 'tools').click();
    expect(lines(drawer.el)).toHaveLength(1);
    expect(lines(drawer.el)[0]).toContain('Edit');
    tab(drawer.el, 'tools').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(tab(drawer.el, 'errors').getAttribute('aria-selected')).toBe('true');
    expect(lines(drawer.el)).toHaveLength(1);
    expect(lines(drawer.el)[0]).toContain('denied');
    expect(tab(drawer.el, 'process').hidden).toBe(true);
    drawer.destroy();
  });

  it('filters, clears locally and keeps new lines after a clear', () => {
    vi.useFakeTimers();
    const { ctx, drawer } = setup();
    const filter = drawer.el.querySelector<HTMLInputElement>('.dr-term-filter') as HTMLInputElement;
    filter.value = 'TURN';
    filter.dispatchEvent(new Event('input'));
    expect(lines(drawer.el)).toEqual([expect.stringContaining('turn ended')]);
    filter.value = '';
    filter.dispatchEvent(new Event('input'));
    buttonNamed(drawer.el, 'Clear')?.click();
    expect(lines(drawer.el)).toEqual([]);
    expect(drawer.el.textContent).toContain('Cleared.');
    ctx.store.setState({
      activity: {
        ...ctx.store.select('activity'),
        agents: { 'claude-1': activity([...LOG, { at: 2, sequence: 14, stream: 'tool', text: 'after clear' }]) },
      },
    });
    expect(lines(drawer.el)).toEqual([expect.stringContaining('after clear')]);
    expect(ctx.store.select('activity').agents['claude-1']?.log).toHaveLength(5);
    drawer.destroy();
  });

  it('toggles the scroll lock', () => {
    vi.useFakeTimers();
    const { drawer } = setup();
    const lock = buttonNamed(drawer.el, 'Scroll lock') as HTMLButtonElement;
    expect(lock.getAttribute('aria-pressed')).toBe('false');
    lock.click();
    expect(lock.getAttribute('aria-pressed')).toBe('true');
    lock.click();
    expect(lock.getAttribute('aria-pressed')).toBe('false');
    drawer.destroy();
  });

  it('takes its height from the preferences, clamped, and saves a resize', () => {
    vi.useFakeTimers();
    const { ctx, drawer } = setup({ height: 1000 });
    expect(drawer.el.style.getPropertyValue('--dr-term-h')).toBe('600px');
    const handle = drawer.el.querySelector<HTMLElement>('[role="separator"]') as HTMLElement;
    expect(handle.getAttribute('aria-valuenow')).toBe('600');
    expect(handle.tabIndex).toBe(0);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(ctx.store.select('prefs').terminalHeight).toBe(580);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(ctx.store.select('prefs').terminalHeight).toBe(300);
    expect(drawer.el.style.getPropertyValue('--dr-term-h')).toBe('300px');
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientY: 500, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientY: 420, pointerId: 1, bubbles: true }));
    expect(drawer.el.style.getPropertyValue('--dr-term-h')).toBe('380px');
    expect(ctx.store.select('prefs').terminalHeight).toBe(300);
    handle.dispatchEvent(new PointerEvent('pointerup', { clientY: 400, pointerId: 1, bubbles: true }));
    expect(ctx.store.select('prefs').terminalHeight).toBe(400);
    ctx.store.patch('prefs', { terminalHeight: 450 });
    expect(drawer.el.style.getPropertyValue('--dr-term-h')).toBe('450px');
    drawer.destroy();
  });

  it('shows the launched process output, re-read every 3 s while open', async () => {
    vi.useFakeTimers();
    const { ctx, drawer } = setup({ answers: { 'GET /agent-processes': { processes: [proc()], profiles: [] } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(1);
    const processTab = tab(drawer.el, 'process');
    expect(processTab.hidden).toBe(false);
    processTab.click();
    const out = lines(drawer.el);
    expect(out).toEqual(['started', `out ${IMG} x`]);
    expect(drawer.el.querySelector('img')).toBeNull();
    expect(drawer.el.textContent).toContain('pid 4242');
    ctx.transport.answers['GET /agent-processes'] = {
      processes: [proc({ status: 'exited', exit_code: 1, log_tail: [...proc().log_tail, 'bye'] })],
      profiles: [],
    };
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(2);
    expect(lines(drawer.el).at(-1)).toBe('bye');
    expect(drawer.el.textContent).toContain('exit code 1');
    buttonNamed(drawer.el, 'Clear')?.click();
    expect(lines(drawer.el)).toEqual([]);
    drawer.destroy();
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS * 3);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops asking for processes when the launcher is not there', async () => {
    vi.useFakeTimers();
    const { ctx, drawer } = setup({
      answers: {
        'GET /agent-processes': () => {
          throw new Error('no route GET /agent-processes');
        },
      },
    });
    await vi.advanceTimersByTimeAsync(PROCESS_POLL_MS * 6);
    expect(ctx.transport.to('GET', '/agent-processes')).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.toasts).toEqual([]);
    drawer.destroy();
  });

  it('opens the inspector of the task the agent works on', () => {
    vi.useFakeTimers();
    const { ctx, drawer } = setup();
    buttonNamed(drawer.el, `Pricing ${IMG}`)?.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: TID });
    drawer.destroy();
  });

  it('stops following the store when destroyed', () => {
    vi.useFakeTimers();
    const { ctx, drawer } = setup();
    drawer.destroy();
    ctx.store.setState({
      activity: { ...ctx.store.select('activity'), agents: { 'claude-1': activity([]) } },
    });
    expect(lines(drawer.el)).toHaveLength(4);
    expect(drawer.el.isConnected).toBe(false);
  });
});
