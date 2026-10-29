/**
 * The Studio header (plan §7.1, §7.3 header metrics, handoff Part 03 §1): the product mark, the
 * project's name and root, the daemon's state dot and address, the counts (running, active
 * worktrees, waiting for you), Search (the palette), Messages, Memory, Code graph, Routing and
 * Settings; under it, the pause banner with its reason and Resume while Friday is paused.
 */
import type { UiSnapshot } from '@friday/protocol';
import { resumeFriday } from '../dock/actions.js';
import { visible } from '../model/text.js';
import { nextExpiryIn, waitingCount } from '../notch/derive.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, plural, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { connectionView } from './connection.js';
import { type AppContext, type Component, openDrawer } from './context.js';
import { productMark } from './mark.js';

export interface HeaderCounts {
  running: number;
  worktrees: number;
  waiting: number;
  messages: number;
}

const LIVE_RUN = new Set(['STARTING', 'ACTIVE', 'SUSPENDED']);

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** The header's numbers from the board (plan §7.3 header metrics, ERRATA F37). */
export function headerCounts(board: UiSnapshot | null, now: number): HeaderCounts {
  if (!board) return { running: 0, worktrees: 0, waiting: 0, messages: 0 };
  const root = normalizePath(board.project.root ?? '');
  const roots = new Set<string>();
  for (const run of Object.values(board.runs ?? {})) {
    if (!run || !LIVE_RUN.has(run.status) || run.workspace !== 'ready' || !run.execution_root) continue;
    const r = normalizePath(run.execution_root);
    if (r && r !== root) roots.add(r);
  }
  return {
    running: board.tasks.filter((t) => t.status === 'RUNNING').length,
    worktrees: roots.size,
    waiting: waitingCount(board, now),
    messages: board.inbox.length,
  };
}

function clock(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface HeaderOptions {
  /** "Waiting for you" was clicked: show the decisions (the shell focuses its tray). */
  onShowWaiting?: () => void;
}

export function mountHeader(ctx: AppContext, opts: HeaderOptions = {}): Component {
  const name = h('span', { class: 'sh-project-name' });
  const root = h('span', { class: 'sh-project-root mono' });
  const dot = h('span', { class: 'sh-dot', aria: { hidden: true } });
  const stateLabel = h('span', { class: 'sh-daemon-label' });
  const address = h('span', { class: 'sh-daemon-address mono' });
  const daemon = h('div', { class: 'sh-daemon', role: 'status', aria: { live: 'polite' } }, dot, stateLabel, address);

  const running = h('span', { class: 'sh-metric-value' }, '0');
  const worktrees = h('span', { class: 'sh-metric-value' }, '0');
  const waiting = h('span', { class: 'sh-metric-value' }, '0');
  const waitingBtn = button(
    [h('span', { class: 'sh-metric-label' }, 'Waiting for you'), waiting],
    () => opts.onShowWaiting?.(),
    { class: 'btn btn-ghost sh-metric sh-metric-waiting', title: 'Approvals, questions and agents waiting for you' },
  );
  const metrics = h(
    'div',
    { class: 'sh-metrics', aria: { label: 'Counts' }, role: 'group' },
    h(
      'span',
      { class: 'sh-metric', title: 'Tasks an agent is working on now' },
      h('span', { class: 'sh-metric-label' }, 'Running'),
      running,
    ),
    h(
      'span',
      { class: 'sh-metric', title: 'Worktrees in use by running attempts' },
      h('span', { class: 'sh-metric-label' }, 'Worktrees'),
      worktrees,
    ),
    waitingBtn,
  );

  const messagesCount = h('span', { class: 'badge badge-info sh-btn-count' });
  const search = button(
    [icon('search', 15), h('span', { class: 'sh-btn-label' }, 'Search'), h('span', { class: 'kbd' }, 'Ctrl K')],
    () => ctx.store.patch('ui', { paletteOpen: true }),
    { class: 'btn btn-ghost sh-btn', title: 'Search tasks, goals, agents, files and commands (Ctrl+K)' },
  );
  const messages = button(
    [icon('message', 15), h('span', { class: 'sh-btn-label' }, 'Messages'), messagesCount],
    () => openDrawer(ctx, { kind: 'inbox' }),
    { class: 'btn btn-ghost sh-btn', title: 'Messages from agents to you' },
  );
  const memory = button(
    [icon('memory', 15), h('span', { class: 'sh-btn-label' }, 'Memory')],
    () => openDrawer(ctx, { kind: 'memory' }),
    { class: 'btn btn-ghost sh-btn', title: "The project's memory: decisions, conventions, lessons" },
  );
  const graph = button(
    [icon('graph', 15), h('span', { class: 'sh-btn-label' }, 'Code graph')],
    () => openDrawer(ctx, { kind: 'graph' }),
    { class: 'btn btn-ghost sh-btn', title: "The main checkout's code graph" },
  );
  const routing = button(
    [icon('swap', 15), h('span', { class: 'sh-btn-label' }, 'Routing')],
    () => openDrawer(ctx, { kind: 'agents', tab: 'pins' }),
    { class: 'btn btn-ghost sh-btn sh-routing', title: 'Which model runs which work: routing pins' },
  );
  const settings = button(icon('gear', 16), () => openDrawer(ctx, { kind: 'settings' }), {
    class: 'btn btn-ghost btn-icon sh-btn',
    ariaLabel: 'Settings',
    title: 'Settings',
  });

  const bar = h(
    'div',
    { class: 'sh-bar' },
    h(
      'div',
      { class: 'sh-brand' },
      productMark(22),
      h('span', { class: 'sh-brand-name' }, 'Friday'),
      h('span', { class: 'sh-brand-sub' }, 'Studio'),
    ),
    h('div', { class: 'sh-project' }, name, root),
    daemon,
    h('span', { class: 'spacer' }),
    metrics,
    h('nav', { class: 'sh-actions', aria: { label: 'Studio' } }, search, messages, memory, graph, routing, settings),
  );

  const pauseText = h('span', { class: 'sh-pause-text' });
  let resuming = false;
  const resumeBtn = button(
    [icon('play', 14), 'Resume'],
    async () => {
      if (resuming) return;
      resuming = true;
      resumeBtn.disabled = true;
      try {
        await resumeFriday(ctx);
      } finally {
        resuming = false;
        resumeBtn.disabled = false;
      }
    },
    { class: 'btn btn-primary sh-pause-resume' },
  );
  const pause = h(
    'div',
    { class: 'sh-pause', role: 'status', hidden: true },
    h('span', { class: 'sh-pause-icon' }, icon('pause', 16)),
    pauseText,
    resumeBtn,
  );

  const el = h('header', { class: 'sh-header' }, bar, pause);
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;

  function renderSystem(): void {
    const v = connectionView(ctx.store.select('system'));
    dot.dataset.state = v.state;
    daemon.dataset.state = v.state;
    setText(stateLabel, v.label);
    daemon.title = v.message ?? 'Friday is connected';
  }

  function renderBoard(): void {
    const board = ctx.store.select('board');
    const now = ctx.now();
    const projectName = board?.project.name ? visible(truncate(board.project.name, 80)) : 'Friday';
    setText(name, projectName);
    const rootText = board?.project.root ?? '';
    setText(root, rootText ? visible(truncate(rootText, 120)) : '');
    root.title = rootText ? visible(rootText) : '';
    root.hidden = !rootText;
    setText(address, board ? `127.0.0.1:${Number(board.project.port) || ''}` : '');
    address.hidden = !board;

    const counts = headerCounts(board, now);
    setText(running, String(counts.running));
    setText(worktrees, String(counts.worktrees));
    setText(waiting, String(counts.waiting));
    waitingBtn.classList.toggle('sh-metric-hot', counts.waiting > 0);
    waitingBtn.setAttribute('aria-label', `${plural(counts.waiting, 'item')} waiting for you`);
    setText(messagesCount, counts.messages ? String(counts.messages) : '');
    messagesCount.hidden = counts.messages === 0;
    messages.setAttribute('aria-label', counts.messages ? `Messages, ${counts.messages}` : 'Messages');

    const control = board?.control;
    pause.hidden = !control?.paused;
    if (control?.paused) {
      const since = clock(control.changed_at);
      const reason = control.reason ? truncate(cleanText(control.reason), 300) : null;
      replace(
        pauseText,
        h('strong', null, control.halted_at ? 'Friday was halted and is paused' : 'Friday is paused'),
        since ? ` since ${since}` : '',
        reason ? h('span', { class: 'sh-pause-reason' }, ` — ${reason}`) : '',
        h('span', { class: 'sh-pause-note muted' }, ": nothing new starts and agents' changes are refused."),
      );
    }

    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    const next = nextExpiryIn(board, now);
    // The waiting count drops when an approval expires, which changes nothing in the board.
    if (next !== null) expiryTimer = setTimeout(renderBoard, Math.min(next + 50, 2_147_000_000));
  }

  const unsubscribers = [ctx.store.subscribe('system', renderSystem), ctx.store.subscribe('board', renderBoard)];
  renderSystem();
  renderBoard();

  return {
    el,
    destroy() {
      for (const u of unsubscribers) u();
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
      el.remove();
    },
  };
}
