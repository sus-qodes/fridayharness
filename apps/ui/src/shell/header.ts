/**
 * The Studio header (plan §7.1, §7.3 header metrics, handoff Part 03 §1, the product review of
 * 2026-10-17 §4): the product mark; the project's name, with the folder path in its tooltip; the
 * daemon's state dot and word, with the address in their tooltip; the counts (Running, whose
 * tooltip is the one-line status sentence, and Waiting for you); Search (the palette), Messages, a
 * More (…) menu holding Project memory, Code graph and About, and Settings; under it, the pause
 * banner with its reason and Resume while Friday is paused. The worktrees count and the routing pins
 * left the header: Settings → Friday holds the count (`panels/settings.ts` `worktreesInUse`) and
 * Settings → Routing the pins. The counts and the sentence come from `notch/derive.ts`, the one
 * rule every surface reads.
 */
import type { UiSnapshot } from '@friday/protocol';
import { resumeFriday } from '../dock/actions.js';
import { visible } from '../model/text.js';
import { nextExpiryIn, runningCount, statusSentence, waitingCount } from '../notch/derive.js';
import { button, h, replace, setText } from '../ui/dom.js';
import { cleanText, plural, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { connectionView } from './connection.js';
import { type AppContext, type Component, openDrawer } from './context.js';
import { mountMenu } from './menu.js';

export interface HeaderCounts {
  running: number;
  waiting: number;
  messages: number;
}

/** The header's numbers from the board (plan §7.3 header metrics, ERRATA F37). */
export function headerCounts(board: UiSnapshot | null, now: number): HeaderCounts {
  if (!board) return { running: 0, waiting: 0, messages: 0 };
  return {
    running: runningCount(board),
    waiting: waitingCount(board, now),
    messages: board.inbox.length,
  };
}

/** Where this page talks to Friday (`127.0.0.1:<port>`); also shown in Settings → About. */
export function daemonAddress(board: UiSnapshot | null): string {
  return board ? `127.0.0.1:${Number(board.project.port) || ''}` : '';
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
  const dot = h('span', { class: 'sh-dot', aria: { hidden: true } });
  const stateLabel = h('span', { class: 'sh-daemon-label' });
  const daemon = h('div', { class: 'sh-daemon', role: 'status', aria: { live: 'polite' } }, dot, stateLabel);

  const running = h('span', { class: 'sh-metric-value' }, '0');
  const runningMetric = h(
    'span',
    { class: 'sh-metric sh-metric-running', title: 'Tasks an agent is working on now' },
    h('span', { class: 'sh-metric-label' }, 'Running'),
    running,
  );
  const waiting = h('span', { class: 'sh-metric-value' }, '0');
  const waitingBtn = button(
    [h('span', { class: 'sh-metric-label' }, 'Waiting for you'), waiting],
    () => opts.onShowWaiting?.(),
    {
      class: 'btn btn-ghost sh-metric sh-metric-waiting',
      title: 'Everything that waits for you: approvals, questions, blocked agents, plans, messages, memories, policy',
    },
  );
  const metrics = h(
    'div',
    { class: 'sh-metrics', aria: { label: 'Counts' }, role: 'group' },
    runningMetric,
    waitingBtn,
  );

  const messagesCount = h('span', { class: 'badge badge-info sh-btn-count' });
  const search = button(
    [icon('search', 15), h('span', { class: 'sh-btn-label' }, 'Search'), h('span', { class: 'kbd' }, 'Ctrl K')],
    () => ctx.store.patch('ui', { paletteOpen: true }),
    { class: 'btn btn-ghost sh-btn sh-search', title: 'Search tasks, goals, agents, files and commands (Ctrl+K)' },
  );
  const messages = button(
    [icon('message', 15), h('span', { class: 'sh-btn-label' }, 'Messages'), messagesCount],
    () => openDrawer(ctx, { kind: 'inbox' }),
    { class: 'btn btn-ghost sh-btn sh-messages', title: 'Messages from agents to you' },
  );
  // What explains Friday rather than the work: one click further than the daily buttons.
  const more = mountMenu({
    label: h('span', { class: 'sh-more-dots', aria: { hidden: 'true' } }, '…'),
    ariaLabel: 'More',
    title: 'More: Project memory, Code graph, About',
    triggerClass: 'btn-icon sh-btn sh-more',
    items: [
      {
        id: 'memory',
        label: 'Project memory',
        title: "The project's memory: decisions, conventions, lessons",
        run: () => openDrawer(ctx, { kind: 'memory' }),
      },
      {
        id: 'graph',
        label: 'Code graph',
        title: "The main checkout's code graph",
        run: () => openDrawer(ctx, { kind: 'graph' }),
      },
      {
        id: 'about',
        label: 'About',
        title: 'The address, the folder and the versions',
        run: () => openDrawer(ctx, { kind: 'settings', tab: 'about' }),
      },
    ],
  });

  const canvasBtn = button(
    [icon('grid', 14), h('span', null, 'Canvas')],
    () => {
      ctx.store.patch('ui', { activeView: 'canvas', drawer: null });
    },
    {
      class: 'sh-view-btn sh-view-canvas',
      ariaLabel: 'Spatial Canvas',
      title: 'Switch to Spatial Canvas',
    },
  );

  const settingsBtn = button(
    [icon('gear', 14), h('span', null, 'Settings')],
    () => {
      openDrawer(ctx, { kind: 'settings' });
    },
    {
      class: 'sh-view-btn sh-view-settings sh-settings',
      ariaLabel: 'Settings',
      title: 'Switch to Settings Hub',
    },
  );

  const viewSwitcher = h(
    'div',
    { class: 'sh-views', role: 'tablist', aria: { label: 'Studio Views' } },
    canvasBtn,
    settingsBtn,
  );

  const leftZone = h(
    'div',
    { class: 'sh-left-zone' },
    h('div', { class: 'sh-project-pill' }, h('div', { class: 'sh-project' }, name), daemon),
  );

  const centerZone = h('div', { class: 'sh-center-zone' }, viewSwitcher);

  const rightZone = h(
    'div',
    { class: 'sh-right-zone' },
    metrics,
    h('nav', { class: 'sh-actions', aria: { label: 'Studio' } }, search, messages, more.el),
  );

  const bar = h('div', { class: 'sh-bar' }, leftZone, centerZone, rightZone);

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

  /** The dot's tooltip: the connection's message, then the address this page talks to. */
  function renderDaemonTitle(): void {
    const v = connectionView(ctx.store.select('system'));
    const address = daemonAddress(ctx.store.select('board'));
    const message = v.message ?? 'Friday is connected';
    daemon.title = address ? `${message} · ${address}` : message;
  }

  function renderSystem(): void {
    const v = connectionView(ctx.store.select('system'));
    dot.dataset.state = v.state;
    daemon.dataset.state = v.state;
    setText(stateLabel, v.label);
    renderDaemonTitle();
  }

  function renderBoard(): void {
    const board = ctx.store.select('board');
    const now = ctx.now();
    const projectName = board?.project.name ? visible(truncate(board.project.name, 80)) : 'Friday';
    setText(name, projectName);
    // The folder path is read once in a while, never typed: the tooltip is its place.
    const rootText = board?.project.root ?? '';
    name.title = rootText ? visible(rootText) : '';
    renderDaemonTitle();

    const counts = headerCounts(board, now);
    setText(running, String(counts.running));
    runningMetric.title = statusSentence(board, now);
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

  function renderView(): void {
    const active = ctx.store.select('ui').activeView;
    canvasBtn.classList.toggle('active', active === 'canvas');
    settingsBtn.classList.toggle('active', active === 'settings');
  }

  const unsubscribers = [
    ctx.store.subscribe('system', renderSystem),
    ctx.store.subscribe('board', renderBoard),
    ctx.store.subscribe('ui', renderView),
  ];
  renderSystem();
  renderBoard();
  renderView();

  return {
    el,
    destroy() {
      for (const u of unsubscribers) u();
      if (expiryTimer) clearTimeout(expiryTimer);
      expiryTimer = null;
      more.destroy();
      el.remove();
    },
  };
}
