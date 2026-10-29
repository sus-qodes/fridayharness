/**
 * The terminal drawer (plan §7.4, handoff Part 05 §6, ERRATA F23, F38): the bottom drawer for one
 * agent. Friday does not relay agents' raw output; it shows Friday's record of the agent (tool
 * decisions, completions, failures, unmediated writes, progress notes, usage, scope and ownership
 * conflicts) in the tabs Combined, Tools and Errors, and, for an agent started from the interface,
 * its launched process's redacted output with escape sequences removed (re-read every 3 s while
 * open). A text filter, a local clear, a scroll lock, and a resize handle (300–600 px) that keeps
 * the height in `prefs.terminalHeight`.
 */
import type { AgentProcess } from '@friday/protocol';
import { visible } from '../model/text.js';
import { type AppContext, type Component, type DrawerRequest, openDrawer } from '../shell/context.js';
import type { AgentActivity, LogLine } from '../store/state.js';
import { button, h, replace, setVar } from '../ui/dom.js';
import { cleanText, humanize, timeAgo, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { badge, empty, mono, statusPill, tabPanel, tabs } from './common.js';
import {
  clampHeight,
  clearPoint,
  MAX_HEIGHT,
  MIN_HEIGHT,
  processClearPoint,
  processLines,
  type TerminalTab,
  visibleLines,
} from './terminal-model.js';

export const PROCESS_POLL_MS = 3000;
const KEY_STEP = 20;
const MAX_FAILURES = 3;
const LINE_MAX = 10_000;

function clock(at: number): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 8);
}

export function createTerminal(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  const key = request.id ?? '';
  let destroyed = false;
  let filterText = '';
  let clearedThrough = 0;
  let processCut: string | null = null;
  let locked = false;
  let proc: AgentProcess | null = null;
  let polling: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  let failures = 0;
  let height = clampHeight(ctx.store.select('prefs').terminalHeight);
  let headSignature = '';
  const unsubscribe: (() => void)[] = [];

  const head = h('div', { class: 'dr-term-head' });
  const tabBar = tabs<TerminalTab>(
    [
      { id: 'combined', label: 'Combined' },
      { id: 'tools', label: 'Tools' },
      { id: 'errors', label: 'Errors' },
      { id: 'process', label: 'Process output' },
    ],
    'combined',
    () => render(),
  );
  tabBar.setHidden('process', true);
  const filter = h('input', {
    class: 'input dr-term-filter',
    type: 'search',
    placeholder: 'Filter',
    autocomplete: 'off',
    spellcheck: false,
    aria: { label: 'Filter the lines' },
    on: {
      input: () => {
        filterText = filter.value;
        render();
      },
    },
  });
  const clearButton = button([icon('cross', 14), 'Clear'], () => clear(), {
    class: 'btn btn-ghost',
    title: 'Hide the lines shown so far (in this drawer only)',
  });
  const lockButton = button([icon('pause', 14), 'Scroll lock'], () => toggleLock(), {
    class: 'btn btn-ghost',
    aria: { pressed: false },
    title: 'Keep the view where it is while new lines arrive',
  });
  const body = h('div', {
    class: 'dr-term-body scroll',
    role: 'log',
    aria: { label: `Activity of ${key}` },
    tabIndex: 0,
  });
  const panel = tabPanel(tabBar, 'combined', body);
  const handle = h('div', {
    class: 'dr-term-handle',
    role: 'separator',
    tabIndex: 0,
    aria: {
      orientation: 'horizontal',
      label: 'Resize the terminal',
      valuemin: MIN_HEIGHT,
      valuemax: MAX_HEIGHT,
      valuenow: height,
    },
    title: 'Drag, or use the arrow keys, to resize',
  });
  const el = h(
    'div',
    { class: 'dr-term' },
    handle,
    head,
    h('div', { class: 'dr-term-toolbar' }, tabBar.el, h('span', { class: 'spacer' }), filter, clearButton, lockButton),
    panel,
  );
  setVar(el, '--dr-term-h', `${height}px`);

  // ---- height ----------------------------------------------------------------------------------

  function applyHeight(next: number, save: boolean): void {
    height = clampHeight(next);
    setVar(el, '--dr-term-h', `${height}px`);
    handle.setAttribute('aria-valuenow', String(height));
    if (save && ctx.store.select('prefs').terminalHeight !== height)
      ctx.store.patch('prefs', { terminalHeight: height });
  }

  let drag: { y: number; h: number; id: number } | null = null;
  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    drag = { y: e.clientY, h: height, id: e.pointerId };
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer cannot be captured; the drag still works while over the handle.
    }
    e.preventDefault();
  });
  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!drag) return;
    applyHeight(drag.h + (drag.y - e.clientY), false);
  });
  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    applyHeight(drag.h + (drag.y - e.clientY), true);
    drag = null;
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
  handle.addEventListener('keydown', (e: KeyboardEvent) => {
    const steps: Record<string, number> = {
      ArrowUp: height + KEY_STEP,
      ArrowDown: height - KEY_STEP,
      PageUp: height + 100,
      PageDown: height - 100,
      Home: MIN_HEIGHT,
      End: MAX_HEIGHT,
    };
    const next = steps[e.key];
    if (next === undefined) return;
    e.preventDefault();
    applyHeight(next, true);
  });

  // ---- content ---------------------------------------------------------------------------------

  function activity(): AgentActivity | undefined {
    return ctx.store.select('activity').agents[key];
  }

  function renderHead(): void {
    const board = ctx.store.select('board');
    const agent = board?.agents.find((a) => a.agent_key === key);
    const harness = agent?.harness_id ? board?.harnesses.find((x) => x.harness_id === agent.harness_id) : undefined;
    const task = agent?.current_task_id ? board?.tasks.find((t) => t.task_id === agent.current_task_id) : undefined;
    const current = activity()?.current;
    // Each snapshot brings new objects: redraw only what changed, so a focused link keeps focus.
    const signature = JSON.stringify([
      agent?.status,
      harness?.name,
      harness?.attach_mode,
      proc?.status,
      task?.task_id,
      task?.status,
      task?.summary,
      current?.tool,
      current?.target,
      current?.decision,
    ]);
    if (signature === headSignature) return;
    headSignature = signature;
    replace(
      head,
      h(
        'div',
        { class: 'row-wrap' },
        icon('terminal', 16),
        mono(key, 'dr-term-key'),
        agent
          ? badge(
              humanize(agent.status),
              agent.status === 'DISCONNECTED' || agent.status === 'UNHEALTHY' ? 'warn' : 'info',
            )
          : badge('not connected', 'muted'),
        harness ? h('span', { class: 'muted' }, `${cleanText(harness.name)} · ${harness.attach_mode}`) : null,
        proc ? badge(`process ${proc.status}`, proc.status === 'exited' ? 'muted' : 'good') : null,
        task
          ? button(
              [statusPill(task.status), truncate(cleanText(task.summary), 60)],
              () => openDrawer(ctx, { kind: 'inspector', id: task.task_id }),
              { class: 'dr-link', title: 'Inspect the task' },
            )
          : null,
        current
          ? h(
              'span',
              { class: 'dr-term-current muted' },
              `${current.decision === 'deny' ? '✕' : '→'} ${cleanText(current.tool)}`,
              current.target ? [' ', mono(truncate(current.target, 120))] : null,
            )
          : null,
      ),
      h(
        'p',
        { class: 'dr-term-note muted' },
        "Friday's record of this agent: tool decisions, completions, failures, progress notes and usage.",
      ),
    );
  }

  function lineView(line: LogLine): HTMLElement {
    return h(
      'div',
      { class: ['dr-term-line', `dr-term-${line.stream}`] },
      h('span', { class: 'dr-term-time', title: new Date(line.at).toISOString() }, clock(line.at)),
      h('span', { class: 'dr-term-text' }, truncate(cleanText(line.text), LINE_MAX)),
    );
  }

  function render(): void {
    if (destroyed) return;
    const tab = tabBar.current();
    // The one panel follows the selected tab.
    const tabId = tabBar.button(tab)?.id ?? '';
    panel.id = `${tabId}-panel`;
    panel.setAttribute('aria-labelledby', tabId);
    if (tab === 'process') {
      const lines = proc ? processLines(proc.log_tail, { filter: filterText, clearedAt: processCut }) : [];
      replace(
        body,
        proc
          ? h(
              'div',
              { class: 'dr-term-procstat muted' },
              `${humanize(proc.status)}`,
              proc.pid ? ` · pid ${proc.pid}` : '',
              ` · started ${timeAgo(proc.started_at, ctx.now())}`,
              proc.exit_code !== null ? ` · exit code ${proc.exit_code}` : '',
              proc.shadow ? ' · shadow: another session holds this key' : '',
            )
          : null,
        lines.length
          ? lines.map((l) => h('div', { class: 'dr-term-line dr-term-process' }, truncate(l, LINE_MAX)))
          : empty(filterText ? 'No lines match the filter.' : 'No output yet.'),
      );
    } else {
      const log = activity()?.log ?? [];
      const lines = visibleLines(log, { tab, filter: filterText, clearedThrough });
      replace(
        body,
        lines.length
          ? lines.map(lineView)
          : empty(
              filterText
                ? 'No lines match the filter.'
                : log.length && clearedThrough
                  ? 'Cleared. New lines appear here.'
                  : 'Nothing recorded for this agent yet.',
            ),
      );
    }
    if (!locked) body.scrollTop = body.scrollHeight;
  }

  function clear(): void {
    clearedThrough = clearPoint(activity()?.log ?? [], clearedThrough);
    if (proc) processCut = processClearPoint(proc.log_tail);
    render();
  }

  function toggleLock(): void {
    locked = !locked;
    lockButton.setAttribute('aria-pressed', String(locked));
    lockButton.classList.toggle('dr-on', locked);
    if (!locked) body.scrollTop = body.scrollHeight;
  }

  // ---- launched process ------------------------------------------------------------------------

  async function poll(): Promise<void> {
    if (destroyed || inFlight) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    inFlight = true;
    try {
      const r = await ctx.api.agentProcesses();
      if (destroyed) return;
      failures = 0;
      const next = (r.processes ?? []).find((p) => p.agent_key === key) ?? null;
      const changed = JSON.stringify(next) !== JSON.stringify(proc);
      proc = next;
      tabBar.setHidden('process', !proc);
      if (changed) {
        renderHead();
        if (tabBar.current() === 'process') render();
      }
    } catch {
      failures++;
      // The launcher is not mounted (a daemon started without the CLI's extension): stop asking.
      if (failures >= MAX_FAILURES) stopPolling();
    } finally {
      inFlight = false;
    }
  }

  function stopPolling(): void {
    if (polling !== null) clearInterval(polling);
    polling = null;
  }

  // ---- wiring ----------------------------------------------------------------------------------

  let lastAgent = activity();
  unsubscribe.push(
    ctx.store.subscribe('activity', (a) => {
      const next = a.agents[key];
      if (next === lastAgent) return;
      const toolChanged = next?.current !== lastAgent?.current;
      lastAgent = next;
      if (toolChanged) renderHead();
      if (tabBar.current() !== 'process') render();
    }),
    ctx.store.subscribe('board', () => renderHead()),
    ctx.store.subscribe('prefs', (p, prev) => {
      if (p.terminalHeight !== prev.terminalHeight && clampHeight(p.terminalHeight) !== height)
        applyHeight(p.terminalHeight, false);
    }),
  );

  renderHead();
  render();
  void poll();
  polling = setInterval(() => void poll(), PROCESS_POLL_MS);

  return {
    el,
    title: `Agent ${visible(key)}`,
    destroy() {
      destroyed = true;
      stopPolling();
      for (const u of unsubscribe) u();
      el.remove();
    },
  };
}
